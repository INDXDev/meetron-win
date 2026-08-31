import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { getPlatformAdapter } from "../src/platform/platform-registry.mjs";

// The browser tests used to hard-code the macOS application path, so they could
// only ever run on the machine they were written on and the Windows port had no
// browser coverage at all. Resolve Chrome the way the product resolves it
// instead, so a test runs wherever Meetron itself runs.
export function findChromeExecutable(platform = getPlatformAdapter()) {
  const application = platform.chrome
    .applications({ home: process.env.HOME || homedir(), env: process.env })
    .find((candidate) => existsSync(candidate));
  return application ? platform.chrome.executable(application) : "";
}

// A missing Chrome is not a failure: the suite is expected to run on machines
// that never installed it. Report the skip in the test's own words.
export function requireChrome(description) {
  const executablePath = findChromeExecutable();
  if (executablePath) return executablePath;
  process.stdout.write(`${description} skipped: Google Chrome was not found.\n`);
  process.exit(0);
}
