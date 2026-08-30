import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bumpType = process.argv[2] ?? "patch";
const dryRun = process.argv.includes("--dry-run");

if (!["major", "minor", "patch"].includes(bumpType)) {
  throw new Error("사용법: node scripts/bump-version.mjs [major|minor|patch] [--dry-run]");
}

const packagePath = path.join(root, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const currentVersion = packageJson.version;
const versionParts = currentVersion.split(".").map(Number);

if (
  versionParts.length !== 3 ||
  versionParts.some((part) => !Number.isInteger(part) || part < 0)
) {
  throw new Error(`유효하지 않은 현재 버전입니다: ${currentVersion}`);
}

const nextParts = [...versionParts];
const bumpIndex = { major: 0, minor: 1, patch: 2 }[bumpType];
nextParts[bumpIndex] += 1;
for (let index = bumpIndex + 1; index < nextParts.length; index += 1) {
  nextParts[index] = 0;
}
const nextVersion = nextParts.join(".");

const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
const cargo = fs.readFileSync(cargoPath, "utf8");
const cargoVersion = cargo.match(/^version = "([^"]+)"/m)?.[1];
const tauriConfigPath = path.join(root, "src-tauri", "tauri.conf.json");
const tauriConfig = fs.readFileSync(tauriConfigPath, "utf8");
const tauriVersion = tauriConfig.match(/"version": "([^"]+)"/)?.[1];
const appPath = path.join(root, "src", "App.tsx");
const app = fs.readFileSync(appPath, "utf8");
const appVersion = app.match(/const APP_VERSION = "v([^"]+)";/)?.[1];

for (const [file, version] of [
  ["package.json", currentVersion],
  ["src-tauri/Cargo.toml", cargoVersion],
  ["src-tauri/tauri.conf.json", tauriVersion],
  ["src/App.tsx", appVersion],
]) {
  if (version !== currentVersion) {
    throw new Error(`${file} 버전(${version ?? "없음"})이 package.json(${currentVersion})과 다릅니다.`);
  }
}

const lockPath = path.join(root, "package-lock.json");
const lock = fs.readFileSync(lockPath, "utf8");
const lockTop = lock.replace(
  new RegExp(`^(\\s*"version": ")${currentVersion.replaceAll(".", "\\.")}("[,\\n])`, "m"),
  `$1${nextVersion}$2`,
);
const lockRoot = lockTop.replace(
  new RegExp(`(\\n\\s*"": \\{\\n\\s*"name": "pair-picker",\\n\\s*"version": ")${currentVersion.replaceAll(".", "\\.")}("[,\\n])`),
  `$1${nextVersion}$2`,
);
if (lockRoot === lock) {
  throw new Error("package-lock.json의 프로젝트 버전을 찾지 못했습니다.");
}

const updatedCargo = cargo.replace(
  /^version = "[^"]+"/m,
  `version = "${nextVersion}"`,
);
const updatedTauriConfig = tauriConfig.replace(
  /("version": ")[^"]+(")/,
  `$1${nextVersion}$2`,
);
const updatedApp = app.replace(
  /const APP_VERSION = "v[^"]+";/,
  `const APP_VERSION = "v${nextVersion}";`,
);

console.log(`${currentVersion} → ${nextVersion}${dryRun ? " (dry-run)" : ""}`);
if (dryRun) process.exit(0);

packageJson.version = nextVersion;
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
fs.writeFileSync(lockPath, lockRoot);
fs.writeFileSync(cargoPath, updatedCargo);
fs.writeFileSync(tauriConfigPath, updatedTauriConfig);
fs.writeFileSync(appPath, updatedApp);
