#!/usr/bin/env node

import { resolve } from "node:path";
import { repoRoot, runMain, runVisible } from "./cli-utils.mjs";

runMain(async () => {
  await runVisible("swift", [
    "build",
    "--package-path", resolve(repoRoot, "native/audio-control"),
    "-c", "release",
    "--arch", "arm64",
    "--arch", "x86_64",
  ]);
});
