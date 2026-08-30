export const WEBRTC_LOOPBACK_BACKEND_ID = "webrtc-loopback";
export const WEBRTC_LOOPBACK_CHANNEL = "meetron-webrtc-loopback";

// This function is serialized by Playwright into the page's main world. Keep
// it self-contained: imported bindings are not available after serialization.
export function installWebRtcLoopbackPage({ role, channel = "meetron-webrtc-loopback" } = {}) {
  if (!['chatgpt', 'meeting'].includes(role)) {
    throw new Error('Meetron WebRTC loopback requires a chatgpt or meeting role.');
  }
  if (globalThis.__meetronWebRtcLoopback) return;

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
  const capturedElements = new WeakMap();
  const mirroredContexts = new WeakMap();
  const retainedSources = new Set();
  const pendingCandidates = [];
  let makingOffer = false;
  let paired = false;
  let ignoreOffer = false;

  const state = {
    backend: 'webrtc-loopback',
    role,
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
    }
  }

  const recordFailure = (stage, error) => {
    if (state.failures.length < 20) {
      state.failures.push({ stage, message: error?.message || String(error) });
    }
  };
  const resumeBridge = () => {
    if (bridgeContext.state === 'suspended') {
      void bridgeContext.resume()
        .then(() => { state.bridgeContextState = bridgeContext.state; })
        .catch((error) => recordFailure('resume-bridge', error));
    } else {
      state.bridgeContextState = bridgeContext.state;
    }
  };
  const sendToExtension = (type, payload = {}) => {
    globalThis.postMessage({
      channel,
      direction: 'page-to-extension',
      type,
      role,
      ...payload,
    }, location.origin);
  };

  peer.addTrack(outgoingTrack, outgoingDestination.stream);
  peer.addEventListener('track', (event) => {
    try {
      const stream = event.streams[0] || new MediaStream([event.track]);
      const source = bridgeContext.createMediaStreamSource(stream);
      nativeAudioNodeConnect.call(source, incomingDestination);
      retainedSources.add(source);
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

  const applySignal = async ({ description, candidate }) => {
    state.signalMessages += 1;
    if (description) {
      const offerCollision = description.type === 'offer' &&
        (makingOffer || peer.signalingState !== 'stable');
      ignoreOffer = role === 'chatgpt' && offerCollision;
      if (ignoreOffer) return;
      if (offerCollision) await peer.setLocalDescription({ type: 'rollback' });
      await peer.setRemoteDescription(description);
      while (pendingCandidates.length) await peer.addIceCandidate(pendingCandidates.shift());
      if (description.type === 'offer') {
        await peer.setLocalDescription(await peer.createAnswer());
        sendToExtension('signal', { description: peer.localDescription.toJSON() });
      }
      return;
    }
    if (candidate) {
      if (ignoreOffer) return;
      if (peer.remoteDescription) await peer.addIceCandidate(candidate);
      else pendingCandidates.push(candidate);
    }
  };

  globalThis.addEventListener('message', (event) => {
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
      return;
    }
    if (event.data.type === 'signal') {
      void applySignal(event.data).catch((error) => recordFailure('apply-signal', error));
    }
  });

  const captureMediaElement = (element) => {
    if (!(element instanceof HTMLMediaElement)) return;
    const currentObject = element.srcObject || null;
    const existing = capturedElements.get(element);
    if (existing?.srcObject === currentObject) return;
    try {
      existing?.source?.disconnect();
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
        const source = bridgeContext.createMediaStreamSource(capturedStream);
        nativeAudioNodeConnect.call(source, outgoingDestination);
        capturedElements.set(element, { source, srcObject: currentObject });
        state.outputSources += 1;
        state.activeOutputKind = 'media-stream-track';
        state.activeOutputStream = capturedStream;
        resumeBridge();
        return;
      }
      if (capturedStream) {
        capturedElements.set(element, { pending: true, source: null, srcObject: currentObject });
        const retry = () => {
          capturedElements.delete(element);
          captureMediaElement(element);
        };
        element.addEventListener('loadedmetadata', retry, { once: true });
        element.addEventListener('playing', retry, { once: true });
        return;
      }
      const source = currentObject instanceof MediaStream
        ? bridgeContext.createMediaStreamSource(currentObject)
        : bridgeContext.createMediaElementSource(element);
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
    NativeAudioContext.prototype.createMediaElementSource = function meetronCreateMediaElementSource(element) {
      const existing = capturedElements.get(element);
      if (existing?.source) {
        existing.source.disconnect();
        state.outputSources = Math.max(0, state.outputSources - 1);
      }
      capturedElements.set(element, { graph: true, source: null, srcObject: element.srcObject || null });
      return nativeCreateMediaElementSource.call(this, element);
    };
  }

  if (nativeAudioNodeConnect && globalThis.AudioDestinationNode) {
    globalThis.AudioNode.prototype.connect = function meetronLoopbackConnect(destination, ...args) {
      if (destination instanceof AudioDestinationNode && this.context !== bridgeContext) {
        try {
          let mirror = mirroredContexts.get(this.context);
          if (!mirror) {
            const destinationNode = this.context.createMediaStreamDestination();
            const source = bridgeContext.createMediaStreamSource(destinationNode.stream);
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
          resumeBridge();
          return destination;
        } catch (error) {
          recordFailure('capture-audio-context', error);
        }
      }
      return nativeAudioNodeConnect.call(this, destination, ...args);
    };
    if (nativeAudioNodeDisconnect) {
      globalThis.AudioNode.prototype.disconnect = function meetronLoopbackDisconnect(...args) {
        if (args[0] instanceof AudioDestinationNode) {
          const mirror = mirroredContexts.get(this.context);
          if (mirror) return nativeAudioNodeDisconnect.call(this, mirror, ...args.slice(1));
        }
        return nativeAudioNodeDisconnect.apply(this, args);
      };
    }
  }

  if (nativeGetUserMedia) {
    globalThis.MediaDevices.prototype.getUserMedia = async function meetronLoopbackGetUserMedia(constraints = {}) {
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
      state.inputTracks.push({
        id: track.id,
        kind: track.kind,
        label: 'Meetron WebRTC loopback',
      });
      return new MediaStream([track]);
    };
  }

  if (nativeSetSinkId) {
    globalThis.HTMLMediaElement.prototype.setSinkId = function meetronLoopbackSetSinkId() {
      captureMediaElement(this);
      return Promise.resolve(undefined);
    };
  }
  const nativePlay = globalThis.HTMLMediaElement?.prototype?.play;
  if (nativePlay) {
    globalThis.HTMLMediaElement.prototype.play = function meetronLoopbackPlay(...args) {
      captureMediaElement(this);
      resumeBridge();
      return nativePlay.apply(this, args);
    };
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
  }

  const captureAddedMedia = (node) => {
    if (node instanceof HTMLMediaElement) captureMediaElement(node);
    if (node instanceof Element) node.querySelectorAll('audio,video').forEach(captureMediaElement);
  };
  const observeDocument = () => {
    document.querySelectorAll('audio,video').forEach(captureMediaElement);
    new MutationObserver((records) => {
      for (const record of records) record.addedNodes.forEach(captureAddedMedia);
    }).observe(document, { childList: true, subtree: true });
  };
  if (document.documentElement) observeDocument();
  else globalThis.addEventListener('DOMContentLoaded', observeDocument, { once: true });

  sendToExtension('register');
}
