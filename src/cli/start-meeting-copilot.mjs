#!/usr/bin/env node

import { resolve } from "node:path";
import { repoRoot, spawnNode, waitForChild, runMain } from "./cli-utils.mjs";

runMain(async () => {
  process.stderr.write("[NOTICE] start-meeting-copilot is kept for compatibility. Use start-meetron.\n");
  const child = spawnNode(resolve(repoRoot, "src/cli/start-meetron.mjs"), process.argv.slice(2));
  return (await waitForChild(child)).exitCode;
});
