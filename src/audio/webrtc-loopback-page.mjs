export const WEBRTC_LOOPBACK_BACKEND_ID = "webrtc-loopback";
export const WEBRTC_LOOPBACK_CHANNEL = "meetron-webrtc-loopback";

// `state.failures` mixes fatal breakage with routine diagnostics. A
// `capture-media-element` rejection on an unrelated <audio> element (a chime,
// a preview clip that a provider already wrapped) is expected and must not
// abort the session, while a lost inbound track, a failed offer or a failed
// signal application means no audio can ever flow. Only the latter group may
// throw; the rest is surfaced in the diagnostic payload.
export const WEBRTC_LOOPBACK_FATAL_STAGES = Object.freeze([
  'resume-bridge',
  'remote-track',
  'create-offer',
  'apply-signal',
]);

// The device backend records failures as plain strings and the loopback as
// {stage, message} objects, so both shapes reach this helper.
export function describeLoopbackFailure(failure) {
  if (typeof failure === 'string') return failure;
  if (!failure) return String(failure);
  return failure.stage ? `${failure.stage}: ${failure.message}` : (failure.message || JSON.stringify(failure));
}

export function classifyLoopbackFailures(failures) {
  const entries = Array.isArray(failures) ? failures : [];
  const fatal = [];
  const benign = [];
  for (const failure of entries) {
    // A string failure carries no stage, so it comes from the device backend
    // where every recorded failure was already treated as fatal.
    const isFatal = typeof failure === 'string' ||
      WEBRTC_LOOPBACK_FATAL_STAGES.includes(failure?.stage);
    (isFatal ? fatal : benign).push(failure);
  }
  return { fatal, benign };
}

export function describeLoopbackFailures(failures) {
  return (Array.isArray(failures) ? failures : []).map(describeLoopbackFailure).join(', ');
}

// The extension broker only emits `peer-ready` once BOTH roles have registered,
// and it then notifies both ports (extension/service-worker.js notifyAudioPair),
// so a side that registers first is still told about the pairing when its peer
// arrives. The wait therefore does not require the peer to be present already —
// it only needs a budget long enough for a cold start of the other side, and a
// periodic re-register so an MV3 service-worker eviction during the wait cannot
// strand this role with a port nothing re-announces.
export const WEBRTC_LOOPBACK_PAIRING_TIMEOUT_MS = 60_000;

export async function waitForWebRtcLoopbackPairing(page, {
  label = 'Meetron',
  timeoutMs = WEBRTC_LOOPBACK_PAIRING_TIMEOUT_MS,
  pollMs = 500,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const paired = await page.evaluate(() => {
      const state = globalThis.__meetronWebRtcLoopback;
      if (!state) return false;
      if (state.peerReadyMessages > 0) return true;
      state.reregister?.();
      return false;
    });
    if (paired) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `${label} WebRTC loopback did not pair with the ChatGPT tab through the extension within ${Math.round(timeoutMs / 1000)}s.`,
      );
    }
    await page.waitForTimeout(pollMs);
  }
}

// Teardown hook for callers that hold the page (page.evaluate or an init
// script). Serialized into the page like the installer, so it stays
// self-contained. Idempotent: uninstalling twice, or with nothing installed,
// simply reports false.
export function uninstallWebRtcLoopbackPage() {
  const state = globalThis.__meetronWebRtcLoopback;
  if (!state?.uninstall) return false;
  state.uninstall();
  return true;
}

// This function is serialized by Playwright into the page's main world. Keep
// it self-contained: imported bindings are not available after serialization.
export function installWebRtcLoopbackPage({ role, hostnames, channel = "meetron-webrtc-loopback" } = {}) {
  if (!['chatgpt', 'meeting'].includes(role)) {
    throw new Error('Meetron WebRTC loopback requires a chatgpt or meeting role.');
  }
  // The dedicated Chrome context holds the meeting tab and the ChatGPT tab at
  // once, and a context-level init script runs on every page in it. Without an
  // origin guard the ChatGPT page also receives role "meeting" (and the meeting
  // page role "chatgpt"), and the double-install guard below then makes the two
  // installs tear each other down — whichever init script runs last wins, so
  // pairing breaks non-deterministically. Match the device backend's guard
  // style: exact host or dot-suffixed subdomain, never a substring test.
  if (Array.isArray(hostnames) && hostnames.length > 0) {
    const host = location.hostname;
    const permitted = hostnames.some((name) => host === name || host.endsWith(`.${name}`));
    if (!permitted) return null;
  }
  // Re-injection into a document that already carries an install would stack a
  // second layer of prototype patches on top of the first, so the "originals"
  // captured below would be the previous install's wrappers and no uninstall
  // could ever restore the real natives. Tear the previous install down first
  // and rebuild from the genuine prototype members.
  const previous = globalThis.__meetronWebRtcLoopback;
  if (previous) {
    if (previous.role === role && previous.installed !== false) return previous;
    try {
      previous.uninstall?.();
    } catch {
      // A half-torn-down previous install must not block the new one.
    }
  }

  const NativeAudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!NativeAudioContext || !globalThis.RTCPeerConnection || !globalThis.MediaStream) {
    throw new Error('This browser does not provide the Web Audio and WebRTC APIs required by Meetron.');
  }

  const bridgeContext = new NativeAudioContext({ latencyHint: 'interactive' });
  const outgoingDestination = bridgeContext.createMediaStreamDestination();
  const incomingDestination = bridgeContext.createMediaStreamDestination();
  const outgoingTrack = outgoingDestination.stream.getAudioTracks()[0];
  const incomingTrack = incomingDestination.stream.getAudioTracks()[0];
  const peer = new RTCPeerConnection({ iceServers: [] });
  const nativeAudioNodeConnect = globalThis.AudioNode?.prototype?.connect;
  const nativeAudioNodeDisconnect = globalThis.AudioNode?.prototype?.disconnect;
  const nativeGetUserMedia = globalThis.MediaDevices?.prototype?.getUserMedia;
  const nativeSetSinkId = globalThis.HTMLMediaElement?.prototype?.setSinkId;
  const nativeMediaElementPlay = globalThis.HTMLMediaElement?.prototype?.play;
  const nativeSourceObjectSetter = globalThis.HTMLMediaElement && Object.getOwnPropertyDescriptor(
    globalThis.HTMLMediaElement.prototype,
    'srcObject',
  )?.set;
  const incomingSinks = new Map();
  const capturedElements = new WeakMap();
  const mirroredContexts = new WeakMap();
  const retainedSources = new Set();
  const incomingSources = new Map();
  const pendingCandidates = [];
  let makingOffer = false;
  let paired = false;
  let ignoreOffer = false;
  // Teardown registry. Every prototype patch, listener, observer and audio node
  // created below registers its undo here so uninstall() can hand the page back
  // exactly as it was found. WeakMap-held sources are unreachable at teardown
  // time, so they are additionally tracked in a strong set.
  const restorers = [];
  const managedSources = new Set();
  const clonedInputTracks = new Set();
  const pendingElementRetries = new Set();
  let documentObserver = null;
  let installed = true;
  const patchPrototype = (target, name, replacement) => {
    if (!target) return;
    const original = target[name];
    target[name] = replacement;
    restorers.push(() => { target[name] = original; });
  };
  const trackSource = (source) => {
    managedSources.add(source);
    return source;
  };
  const disconnectSource = (source) => {
    if (!source) return;
    managedSources.delete(source);
    try {
      if (nativeAudioNodeDisconnect) nativeAudioNodeDisconnect.call(source);
      else source.disconnect();
    } catch {
      // A node whose context is already closed throws; nothing is left to undo.
    }
  };

  const state = {
    backend: 'webrtc-loopback',
    role,
    installed: true,
    bridgeContextState: bridgeContext.state,
    connectionState: peer.connectionState,
    iceConnectionState: peer.iceConnectionState,
    inputRequests: 0,
    inputTracks: [],
    outputSources: 0,
    outputContexts: 0,
    activeOutputKind: "bridge-mix",
    signalMessages: 0,
    peerReadyMessages: 0,
    offerAttempts: 0,
    signalingState: peer.signalingState,
    failures: [],
    processing: {
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: false,
    },
    outgoingStream: outgoingDestination.stream,
    activeOutputStream: outgoingDestination.stream,
    incomingStream: incomingDestination.stream,
  };
  Object.defineProperty(globalThis, '__meetronWebRtcLoopback', {
    configurable: true,
    value: state,
  });
  Object.defineProperty(state, 'peerConnection', { value: peer });
  if (role === 'meeting') {
    const markDedicatedParticipant = () => {
      if (!document.documentElement) return false;
      document.documentElement.setAttribute('data-meetron-dedicated-participant', 'true');
      return true;
    };
    if (!markDedicatedParticipant()) {
      globalThis.addEventListener('DOMContentLoaded', markDedicatedParticipant, { once: true });
      restorers.push(() => globalThis.removeEventListener('DOMContentLoaded', markDedicatedParticipant));
    }
    restorers.push(() => document.documentElement?.removeAttribute('data-meetron-dedicated-participant'));
  }

  const recordFailure = (stage, error) => {
    if (state.failures.length < 20) {
      state.failures.push({ stage, message: error?.message || String(error) });
    }
  };
  const resumeBridge = () => {
    if (!installed || bridgeContext.state === 'closed') return;
    if (bridgeContext.state === 'suspended') {
      void bridgeContext.resume()
        .then(() => { state.bridgeContextState = bridgeContext.state; })
        .catch((error) => recordFailure('resume-bridge', error));
    } else {
      state.bridgeContextState = bridgeContext.state;
    }
  };
  const sendToExtension = (type, payload = {}) => {
    if (!installed) return;
    globalThis.postMessage({
      channel,
      direction: 'page-to-extension',
      type,
      role,
      ...payload,
    }, location.origin);
  };

  peer.addTrack(outgoingTrack, outgoingDestination.stream);
  // The loopback carries exactly one inbound audio track at a time. Every
  // renegotiation (reconnect, tab reload, peer re-register) fires `track`
  // again, so stale sources must be disconnected or the remote audio is summed
  // into incomingDestination once per negotiation and grows louder each time.
  // Chrome only decodes a remote WebRTC track while its stream also has a media
  // element sink. Connected to WebAudio alone the graph pulls silence, so the
  // bridge would forward a silent stream while RTP kept flowing. Give the
  // arriving stream a muted, detached sink of its own, driven through the
  // native members so the page's own srcObject and play hooks do not capture
  // it back into the graph.
  const attachIncomingSink = (track, stream) => {
    if (!nativeSourceObjectSetter || !nativeMediaElementPlay) return;
    try {
      const sink = new Audio();
      sink.muted = true;
      sink.autoplay = true;
      nativeSourceObjectSetter.call(sink, stream);
      const started = nativeMediaElementPlay.call(sink);
      if (started?.catch) started.catch((error) => recordFailure('remote-sink-play', error));
      incomingSinks.set(track, sink);
    } catch (error) {
      recordFailure('remote-sink', error);
    }
  };
  const releaseIncomingSink = (track) => {
    const sink = incomingSinks.get(track);
    if (!sink) return;
    incomingSinks.delete(track);
    try {
      sink.pause();
      if (nativeSourceObjectSetter) nativeSourceObjectSetter.call(sink, null);
    } catch (error) {
      recordFailure('release-remote-sink', error);
    }
  };
  const releaseIncomingSource = (track) => {
    releaseIncomingSink(track);
    const source = incomingSources.get(track);
    if (!source) return;
    incomingSources.delete(track);
    managedSources.delete(source);
    try {
      if (nativeAudioNodeDisconnect) nativeAudioNodeDisconnect.call(source);
      else source.disconnect();
    } catch (error) {
      recordFailure('release-remote-track', error);
    }
  };
  const releaseIncomingSources = (keep) => {
    for (const track of [...incomingSources.keys()]) {
      if (track !== keep) releaseIncomingSource(track);
    }
  };
  peer.addEventListener('track', (event) => {
    try {
      if (event.track.kind !== 'audio') return;
      const stream = event.streams[0] || new MediaStream([event.track]);
      const source = trackSource(bridgeContext.createMediaStreamSource(stream));
      nativeAudioNodeConnect.call(source, incomingDestination);
      releaseIncomingSources();
      incomingSources.set(event.track, source);
      attachIncomingSink(event.track, stream);
      event.track.addEventListener('ended', () => releaseIncomingSource(event.track), { once: true });
      resumeBridge();
    } catch (error) {
      recordFailure('remote-track', error);
    }
  });
  peer.addEventListener('icecandidate', (event) => {
    if (event.candidate) sendToExtension('signal', { candidate: event.candidate.toJSON() });
  });
  const updateConnectionState = () => {
    state.connectionState = peer.connectionState;
    state.iceConnectionState = peer.iceConnectionState;
  };
  peer.addEventListener('connectionstatechange', updateConnectionState);
  peer.addEventListener('iceconnectionstatechange', updateConnectionState);

  const makeOffer = async () => {
    if (!paired || makingOffer || peer.signalingState !== 'stable') return;
    makingOffer = true;
    state.offerAttempts += 1;
    try {
      await peer.setLocalDescription(await peer.createOffer());
      state.signalingState = peer.signalingState;
      sendToExtension('signal', { description: peer.localDescription.toJSON() });
    } catch (error) {
      recordFailure('create-offer', error);
    } finally {
      makingOffer = false;
    }
  };

  const addCandidate = async (candidate) => {
    try {
      await peer.addIceCandidate(candidate);
    } catch (error) {
      // A candidate belonging to an offer we ignored is expected to be
      // rejected; only a candidate for the surviving negotiation is a failure.
      if (!ignoreOffer) throw error;
    }
  };

  const applySignal = async ({ description, candidate }) => {
    state.signalMessages += 1;
    if (description) {
      const offerCollision = description.type === 'offer' &&
        (makingOffer || peer.signalingState !== 'stable');
      ignoreOffer = role === 'chatgpt' && offerCollision;
      if (ignoreOffer) return;
      if (offerCollision) await peer.setLocalDescription({ type: 'rollback' });
      await peer.setRemoteDescription(description);
      while (pendingCandidates.length) await addCandidate(pendingCandidates.shift());
      if (description.type === 'offer') {
        await peer.setLocalDescription(await peer.createAnswer());
        sendToExtension('signal', { description: peer.localDescription.toJSON() });
      }
      return;
    }
    if (candidate) {
      // Buffer rather than drop while an offer is ignored: these candidates
      // belong to the ICE session the surviving negotiation still uses, so
      // discarding them strands connectivity until an ICE restart.
      if (ignoreOffer || !peer.remoteDescription) pendingCandidates.push(candidate);
      else await addCandidate(candidate);
    }
  };

  // Signals must be applied strictly in order. Concurrent applySignal calls
  // interleave their awaits and throw InvalidStateError from
  // setRemoteDescription / createAnswer.
  let signalChain = Promise.resolve();
  const enqueueSignal = (data) => {
    signalChain = signalChain
      .then(() => applySignal(data))
      .catch((error) => recordFailure('apply-signal', error));
  };

  const handleExtensionMessage = (event) => {
    if (!installed) return;
    if (
      event.source !== globalThis ||
      event.origin !== location.origin ||
      event.data?.channel !== channel ||
      event.data?.direction !== 'extension-to-page'
    ) return;
    if (event.data.type === 'peer-ready') {
      state.peerReadyMessages += 1;
      paired = true;
      if (role === 'chatgpt') void makeOffer();
      return;
    }
    if (event.data.type === 'bridge-ready') {
      sendToExtension('register');
      return;
    }
    if (event.data.type === 'peer-disconnected') {
      state.connectionState = 'disconnected';
      // Drop the dead peer's audio graph and stale candidates so the next
      // pairing starts clean instead of summing onto the previous session.
      paired = false;
      pendingCandidates.length = 0;
      releaseIncomingSources();
      return;
    }
    if (event.data.type === 'signal') {
      enqueueSignal(event.data);
    }
  };
  globalThis.addEventListener('message', handleExtensionMessage);
  restorers.push(() => globalThis.removeEventListener('message', handleExtensionMessage));

  const captureMediaElement = (element) => {
    if (!installed) return;
    if (!(element instanceof HTMLMediaElement)) return;
    const currentObject = element.srcObject || null;
    const existing = capturedElements.get(element);
    if (existing?.srcObject === currentObject) return;
    try {
      disconnectSource(existing?.source);
      let capturedStream = currentObject instanceof MediaStream ? currentObject : null;
      if (!capturedStream && typeof element.captureStream === 'function') {
        try {
          capturedStream = element.captureStream();
        } catch {
          // Fall through to createMediaElementSource when captureStream is unavailable for this source.
        }
      }
      const directTrack = capturedStream?.getAudioTracks()[0] || null;
      if (directTrack) {
        const source = trackSource(bridgeContext.createMediaStreamSource(capturedStream));
        nativeAudioNodeConnect.call(source, outgoingDestination);
        capturedElements.set(element, { source, srcObject: currentObject });
        state.outputSources += 1;
        state.activeOutputKind = 'media-stream-track';
        state.activeOutputStream = capturedStream;
        resumeBridge();
        return;
      }
      if (capturedStream) {
        // Both listeners fire for a normal element. With `once` they are
        // independent, so the second one re-ran the capture after the first had
        // already succeeded and connected a duplicate source, doubling the
        // element's audio. Share one retry, unregister both, and only act while
        // this pending entry is still the current one.
        const pending = { pending: true, source: null, srcObject: currentObject };
        capturedElements.set(element, pending);
        const retry = () => {
          element.removeEventListener('loadedmetadata', retry);
          element.removeEventListener('playing', retry);
          pendingElementRetries.delete(unregisterRetry);
          if (capturedElements.get(element) !== pending) return;
          capturedElements.delete(element);
          captureMediaElement(element);
        };
        const unregisterRetry = () => {
          element.removeEventListener('loadedmetadata', retry);
          element.removeEventListener('playing', retry);
        };
        pendingElementRetries.add(unregisterRetry);
        element.addEventListener('loadedmetadata', retry);
        element.addEventListener('playing', retry);
        return;
      }
      const source = trackSource(currentObject instanceof MediaStream
        ? bridgeContext.createMediaStreamSource(currentObject)
        : bridgeContext.createMediaElementSource(element));
      nativeAudioNodeConnect.call(source, outgoingDestination);
      capturedElements.set(element, { source, srcObject: currentObject });
      state.outputSources += 1;
      state.activeOutputKind = 'media-element';
      resumeBridge();
    } catch (error) {
      // A media element can only be wrapped by createMediaElementSource once.
      // Preserve the first working route and record only genuinely new failures.
      if (!existing) recordFailure('capture-media-element', error);
    }
  };

  const nativeCreateMediaElementSource = NativeAudioContext.prototype.createMediaElementSource;
  if (nativeCreateMediaElementSource) {
    patchPrototype(NativeAudioContext.prototype, 'createMediaElementSource', function meetronCreateMediaElementSource(element) {
      const existing = capturedElements.get(element);
      if (existing?.source) {
        disconnectSource(existing.source);
        state.outputSources = Math.max(0, state.outputSources - 1);
      }
      capturedElements.set(element, { graph: true, source: null, srcObject: element.srcObject || null });
      return nativeCreateMediaElementSource.call(this, element);
    });
  }

  // Nodes the page routed through a mirror destination instead of its own
  // AudioDestinationNode. Uninstall has to hand those connections back, or the
  // page stays silent to its own speakers after teardown.
  const mirroredConnections = [];
  if (nativeAudioNodeConnect && globalThis.AudioDestinationNode) {
    patchPrototype(globalThis.AudioNode.prototype, 'connect', function meetronLoopbackConnect(destination, ...args) {
      if (destination instanceof AudioDestinationNode && this.context !== bridgeContext) {
        try {
          let mirror = mirroredContexts.get(this.context);
          if (!mirror) {
            const destinationNode = this.context.createMediaStreamDestination();
            const source = trackSource(bridgeContext.createMediaStreamSource(destinationNode.stream));
            nativeAudioNodeConnect.call(source, outgoingDestination);
            retainedSources.add(source);
            mirror = destinationNode;
            mirroredContexts.set(this.context, mirror);
            state.outputContexts += 1;
            state.activeOutputKind = 'audio-context';
            state.capturedOutputStream = destinationNode.stream;
            state.activeOutputDestination = destinationNode;
          }
          nativeAudioNodeConnect.call(this, mirror, ...args);
          if (mirroredConnections.length < 256) {
            mirroredConnections.push({ node: this, mirror, destination, args });
          }
          resumeBridge();
          return destination;
        } catch (error) {
          recordFailure('capture-audio-context', error);
        }
      }
      return nativeAudioNodeConnect.call(this, destination, ...args);
    });
    if (nativeAudioNodeDisconnect) {
      patchPrototype(globalThis.AudioNode.prototype, 'disconnect', function meetronLoopbackDisconnect(...args) {
        if (args[0] instanceof AudioDestinationNode) {
          const mirror = mirroredContexts.get(this.context);
          if (mirror) return nativeAudioNodeDisconnect.call(this, mirror, ...args.slice(1));
        }
        return nativeAudioNodeDisconnect.apply(this, args);
      });
    }
  }

  if (nativeGetUserMedia) {
    patchPrototype(globalThis.MediaDevices.prototype, 'getUserMedia', async function meetronLoopbackGetUserMedia(constraints = {}) {
      const audioRequested = Boolean(constraints?.audio);
      const videoRequested = Boolean(constraints?.video);
      if (!audioRequested) {
        // The dedicated participant never publishes a camera. Returning an
        // empty stream keeps provider previews from touching a physical camera.
        return videoRequested && role === 'meeting'
          ? new MediaStream()
          : nativeGetUserMedia.call(this, constraints);
      }
      state.inputRequests += 1;
      resumeBridge();
      const track = incomingTrack.clone();
      // Providers re-request the microphone on every device change and unmute,
      // so this list grows for the life of the tab unless retired clones are
      // pruned and the array is bounded.
      clonedInputTracks.add(track);
      track.addEventListener('ended', () => {
        clonedInputTracks.delete(track);
        const index = state.inputTracks.findIndex((entry) => entry.id === track.id);
        if (index >= 0) state.inputTracks.splice(index, 1);
      }, { once: true });
      if (state.inputTracks.length >= 32) state.inputTracks.shift();
      state.inputTracks.push({
        id: track.id,
        kind: track.kind,
        label: 'Meetron WebRTC loopback',
      });
      return new MediaStream([track]);
    });
  }

  if (nativeSetSinkId) {
    patchPrototype(globalThis.HTMLMediaElement.prototype, 'setSinkId', function meetronLoopbackSetSinkId() {
      captureMediaElement(this);
      return Promise.resolve(undefined);
    });
  }
  const nativePlay = globalThis.HTMLMediaElement?.prototype?.play;
  if (nativePlay) {
    patchPrototype(globalThis.HTMLMediaElement.prototype, 'play', function meetronLoopbackPlay(...args) {
      captureMediaElement(this);
      resumeBridge();
      return nativePlay.apply(this, args);
    });
  }
  const sourceObjectDescriptor = globalThis.HTMLMediaElement && Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    'srcObject',
  );
  if (sourceObjectDescriptor?.get && sourceObjectDescriptor?.set && sourceObjectDescriptor.configurable) {
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      ...sourceObjectDescriptor,
      get: sourceObjectDescriptor.get,
      set(value) {
        sourceObjectDescriptor.set.call(this, value);
        captureMediaElement(this);
      },
    });
    restorers.push(() => Object.defineProperty(
      HTMLMediaElement.prototype,
      'srcObject',
      sourceObjectDescriptor,
    ));
  }

  const captureAddedMedia = (node) => {
    if (node instanceof HTMLMediaElement) captureMediaElement(node);
    if (node instanceof Element) node.querySelectorAll('audio,video').forEach(captureMediaElement);
  };
  const observeDocument = () => {
    if (!installed) return;
    document.querySelectorAll('audio,video').forEach(captureMediaElement);
    documentObserver = new MutationObserver((records) => {
      for (const record of records) record.addedNodes.forEach(captureAddedMedia);
    });
    documentObserver.observe(document, { childList: true, subtree: true });
  };
  if (document.documentElement) observeDocument();
  else {
    globalThis.addEventListener('DOMContentLoaded', observeDocument, { once: true });
    restorers.push(() => globalThis.removeEventListener('DOMContentLoaded', observeDocument));
  }

  // Idempotent teardown. Everything the install touched — prototype members,
  // listeners, the observer, the peer connection, the cloned input tracks and
  // the AudioContext itself — is undone here, so a page can be handed back to
  // the provider (or re-prepared from scratch) without a reload.
  const uninstall = () => {
    if (!installed) return state;
    installed = false;
    state.installed = false;
    // Restore the prototypes in reverse patch order so a member patched twice
    // still ends up holding its original value.
    for (const restore of restorers.reverse()) {
      try {
        restore();
      } catch {
        // A restore that cannot run leaves the page no worse off than skipping
        // the rest of the teardown would.
      }
    }
    restorers.length = 0;
    for (const unregisterRetry of pendingElementRetries) {
      try {
        unregisterRetry();
      } catch {
        // The element may already be gone.
      }
    }
    pendingElementRetries.clear();
    documentObserver?.disconnect();
    documentObserver = null;
    for (const { node, mirror, destination, args } of mirroredConnections) {
      try {
        nativeAudioNodeDisconnect?.call(node, mirror);
        nativeAudioNodeConnect.call(node, destination, ...args);
      } catch {
        // A node from a closed context can no longer be rewired.
      }
    }
    mirroredConnections.length = 0;
    for (const source of [...managedSources, ...retainedSources]) disconnectSource(source);
    managedSources.clear();
    retainedSources.clear();
    incomingSources.clear();
    for (const track of [outgoingTrack, incomingTrack, ...clonedInputTracks]) {
      try {
        track?.stop();
      } catch {
        // An already-ended track needs no stopping.
      }
    }
    clonedInputTracks.clear();
    pendingCandidates.length = 0;
    paired = false;
    try {
      peer.close();
    } catch {
      // A peer connection that is already closed throws nothing worth keeping.
    }
    state.connectionState = 'closed';
    state.signalingState = 'closed';
    try {
      if (bridgeContext.state !== 'closed') void bridgeContext.close().catch(() => {});
    } catch {
      // Closing an AudioContext twice is harmless.
    }
    state.bridgeContextState = 'closed';
    if (globalThis.__meetronWebRtcLoopback === state) delete globalThis.__meetronWebRtcLoopback;
    return state;
  };
  // Non-enumerable so page.evaluate() can still structured-clone the state.
  Object.defineProperty(state, 'uninstall', { value: uninstall });
  // `register` is only sent at install time and on `bridge-ready`. The MV3
  // service worker can be evicted while this side waits for a peer that has not
  // been prepared yet, and nothing re-registers on its own, so a waiter needs a
  // way to re-announce this role to the broker.
  Object.defineProperty(state, 'reregister', {
    value: () => sendToExtension('register'),
  });

  sendToExtension('register');
  return state;
}
