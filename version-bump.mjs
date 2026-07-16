import { readFileSync, writeFileSync } from "fs";

const target = process.argv[2] ?? "0.0.1";
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = target;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[target] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");