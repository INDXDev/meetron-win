// One definition of the App Installer feed, shared by the generator, the
// verifier, and the tests, so the shape that ships can never drift from the
// shape that is checked.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { assertUpdateFeedUris, cliError, distinguishedNamesMatch } from "./cli-utils.mjs";

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function xmlUnescape(value) {
  return String(value)
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function attribute(element, name) {
  return xmlUnescape(element.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] || "");
}

export function renderAppInstaller({
  identityName,
  publisher,
  version,
  architecture = "x64",
  packageUri,
  appInstallerUri,
}) {
  return `<?xml version="1.0" encoding="utf-8"?>
<AppInstaller xmlns="http://schemas.microsoft.com/appx/appinstaller/2021" Version="${xmlEscape(version)}" Uri="${xmlEscape(appInstallerUri)}">
  <MainPackage Name="${xmlEscape(identityName)}" Publisher="${xmlEscape(publisher)}" Version="${xmlEscape(version)}" ProcessorArchitecture="${xmlEscape(architecture)}" Uri="${xmlEscape(packageUri)}" />
  <UpdateSettings>
    <OnLaunch HoursBetweenUpdateChecks="12" ShowPrompt="true" UpdateBlocksActivation="false" />
    <AutomaticBackgroundTask />
  </UpdateSettings>
</AppInstaller>
`;
}

export function writeAppInstaller({
  outputDir,
  identityName,
  publisher,
  version,
  architecture = "x64",
  artifactName,
  packageUri,
  appInstallerUri,
  overwrite = false,
}) {
  const { packageTarget, feedTarget } = assertUpdateFeedUris({ packageUri, appInstallerUri });
  if (packageTarget.fileName !== artifactName) {
    throw cliError(`[ERROR] --package-uri must end in the packed artifact name ${artifactName} (found ${packageTarget.fileName || "none"}).`, 1);
  }
  // The feed filename has to be the last segment of the URI it publishes itself
  // at, or App Installer polls an asset nobody ever uploaded.
  const path = resolve(outputDir, feedTarget.fileName);
  if (!overwrite && (existsSync(path) || existsSync(`${path}.sha256`))) {
    throw cliError(`[ERROR] Refusing to overwrite App Installer feed: ${path} (pass --overwrite-appinstaller).`, 1);
  }
  writeFileSync(path, renderAppInstaller({
    identityName, publisher, version, architecture, packageUri, appInstallerUri,
  }), "ascii");
  // The descriptor is never signed afterwards, so its checksum is final here.
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  writeFileSync(`${path}.sha256`, `${hash}  ${basename(path)}\n`);
  return path;
}

export function readAppInstaller(path) {
  const source = readFileSync(path, "ascii");
  const feed = source.match(/<AppInstaller\b[^>]*>/)?.[0] || "";
  const mainPackage = source.match(/<MainPackage\b[^>]*\/?>/)?.[0] || "";
  if (!feed || !mainPackage) throw cliError("[ERROR] App Installer descriptor could not be read.", 1);
  return {
    name: attribute(mainPackage, "Name"),
    publisher: attribute(mainPackage, "Publisher"),
    version: attribute(mainPackage, "Version"),
    architecture: attribute(mainPackage, "ProcessorArchitecture"),
    packageUri: attribute(mainPackage, "Uri"),
    appInstallerUri: attribute(feed, "Uri"),
  };
}

// The generator guards these URIs, but a published descriptor is a separate
// file that can be hand-edited or substituted, so re-check it against the
// package it claims to update before anything ships.
export function assertAppInstallerMatches(path, { identity, msixName, repository = "" }) {
  const descriptor = readAppInstaller(path);
  if (descriptor.name !== identity.name ||
      descriptor.version !== identity.version ||
      descriptor.architecture !== identity.architecture ||
      !distinguishedNamesMatch(descriptor.publisher, identity.publisher)) {
    throw cliError("[ERROR] App Installer identity does not match the verified package.", 1);
  }
  const { packageTarget, feedTarget } = assertUpdateFeedUris({
    packageUri: descriptor.packageUri,
    appInstallerUri: descriptor.appInstallerUri,
    repository,
    packageUriName: "The App Installer MainPackage Uri",
    appInstallerUriName: "The App Installer feed Uri",
  });
  if (packageTarget.fileName !== msixName) {
    throw cliError(`[ERROR] App Installer does not reference the verified MSIX filename (found ${packageTarget.fileName || "none"}).`, 1);
  }
  if (feedTarget.fileName !== basename(path)) {
    throw cliError(`[ERROR] App Installer publishes itself as ${feedTarget.fileName || "none"}, not ${basename(path)}; the update feed would 404.`, 1);
  }
  return descriptor;
}
