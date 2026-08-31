import { MeetronError } from "../core/errors.mjs";
import { createWindowsCredentialStore } from "./windows/windows-credential-store.mjs";

export function getCredentialStore(platformId, options = {}) {
  if (platformId === "win32") return createWindowsCredentialStore(options);
  throw new MeetronError(
    "CREDENTIAL_STORE_UNSUPPORTED",
    `Credential storage is not implemented for platform: ${platformId}`,
  );
}
