import { MeetronError } from "../core/errors.mjs";
import {
  createParticipantStatus,
  createReconciliationResult,
} from "../core/participant-state.mjs";

const DEFINITION_METHODS = Object.freeze(["matchUrl", "normalizeUrl"]);
const RUNTIME_METHODS = Object.freeze([
  "getStatus",
  "reconcileSession",
  "setMicrophone",
  "leave",
]);
const OPTIONAL_RUNTIME_METHODS = Object.freeze(["getVisualContextPage"]);
const VISUAL_CONTEXT_CAPABILITIES = new Set(["viewport-screenshot"]);
const INITIAL_PAGES = new Set(["meeting-display-url", "blank"]);
const URL_TRANSPORTS = new Set(["argument", "stdin"]);

export function assertProviderDefinition(definition) {
  if (!definition || typeof definition.id !== "string" || !definition.id) {
    throw new MeetronError("INVALID_PROVIDER", "MeetingProvider.id is required");
  }
  if (typeof definition.label !== "string" || !definition.label) {
    throw new MeetronError("INVALID_PROVIDER", `MeetingProvider ${definition.id} requires a label`);
  }
  if (!definition.automation || typeof definition.automation !== "object") {
    throw new MeetronError(
      "INVALID_PROVIDER",
      `MeetingProvider ${definition.id} requires automation settings`,
    );
  }
  if (!INITIAL_PAGES.has(definition.automation.initialPage)) {
    throw new MeetronError(
      "INVALID_PROVIDER",
      `MeetingProvider ${definition.id} has an invalid initial page`,
    );
  }
  if (
    typeof definition.automation.preparationScript !== "string" ||
    !definition.automation.preparationScript.endsWith(".mjs") ||
    !URL_TRANSPORTS.has(definition.automation.urlTransport) ||
    typeof definition.automation.supportsJoinDelay !== "boolean" ||
    typeof definition.automation.manualActionReason !== "string" ||
    !definition.automation.manualActionReason
  ) {
    throw new MeetronError(
      "INVALID_PROVIDER",
      `MeetingProvider ${definition.id} has invalid preparation settings`,
    );
  }
  for (const method of DEFINITION_METHODS) {
    if (typeof definition[method] !== "function") {
      throw new MeetronError(
        "INVALID_PROVIDER",
        `MeetingProvider ${definition.id} must implement ${method}()`,
      );
    }
  }
  if (
    definition.capabilities?.visualContext !== undefined &&
    !VISUAL_CONTEXT_CAPABILITIES.has(definition.capabilities.visualContext)
  ) {
    throw new MeetronError(
      "INVALID_PROVIDER",
      `MeetingProvider ${definition.id} has an invalid visual context capability`,
    );
  }
  return definition;
}

export function createRuntimeProvider(definition, operations) {
  assertProviderDefinition(definition);
  const supportsVisualContext = definition.capabilities?.visualContext === "viewport-screenshot";
  const implementsVisualContext = typeof operations?.getVisualContextPage === "function";
  if (supportsVisualContext !== implementsVisualContext) {
    throw new MeetronError(
      "INVALID_PROVIDER",
      `MeetingProvider ${definition.id} visual context capability and implementation must match`,
    );
  }
  const provider = { ...definition };
  for (const name of RUNTIME_METHODS) {
    if (typeof operations?.[name] !== "function") {
      throw new MeetronError(
        "INVALID_PROVIDER",
        `MeetingProvider ${definition.id} must implement ${name}()`,
      );
    }
    provider[name] = operations[name];
  }
  for (const name of OPTIONAL_RUNTIME_METHODS) {
    if (typeof operations?.[name] === "function") {
      provider[name] = operations[name];
    }
  }
  provider.getStatus = async (...args) => createParticipantStatus(
    await operations.getStatus(...args),
  );
  provider.reconcileSession = async (...args) => createReconciliationResult(
    await operations.reconcileSession(...args),
  );
  return Object.freeze(provider);
}
