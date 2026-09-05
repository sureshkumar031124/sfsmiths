#!/usr/bin/env node
/**
 * scripts/install-toolkit.mjs — install the toolkit OUTSIDE the repo so hooks run a copy agents cannot edit.
 *
 *   npm run install:toolkit
 *
 * What it does:
 *   1. `npm run build` (dist/ must be fresh)
 *   2. `npm pack` → sfsmiths-<version>.tgz
 *   3. `npm install --prefix ~/.sfsmiths/toolkit <tgz>` (production deps only)
 *   4. writes launchers into ~/.sfsmiths/bin/{sfsmiths,sfsmiths-human,sfsmiths-hook,sfsmiths-mcp-evidence,sfsmiths-mcp-ui}
 *   5. prints the PATH line to add
 * Override the home with SFSMITHS_HOME. Windows: .cmd launchers are written too (Phase 4 — verify).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.SFSMITHS_HOME || path.join(os.homedir(), ".sfsmiths");
const toolkit = path.join(home, "toolkit");
const bin = path.join(home, "bin");
const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: repo, stdio: "inherit", ...opts });
const runOut = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: repo, encoding: "utf8", ...opts });
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

console.log(`SFsmiths toolkit install → ${home}`);
run(npm, ["run", "build"]);
const packOut = runOut(npm, ["pack", "--json", "--pack-destination", os.tmpdir()]);
const tgzName = JSON.parse(packOut)[0].filename;
const tgz = path.join(os.tmpdir(), tgzName);
fs.mkdirSync(toolkit, { recursive: true });
fs.mkdirSync(bin, { recursive: true });
if (!fs.existsSync(path.join(toolkit, "package.json"))) fs.writeFileSync(path.join(toolkit, "package.json"), JSON.stringify({ name: "sfsmiths-toolkit-home", private: true, description: "installed copy of the SFsmiths toolkit — do not edit; reinstall with npm run install:toolkit" }, null, 2));
run(npm, ["install", "--omit=dev", "--no-audit", "--no-fund", "--prefix", toolkit, tgz]);
fs.rmSync(tgz, { force: true });

const installedBin = (name) => path.join(toolkit, "node_modules", "sfsmiths", "bin", `${name}.js`);
for (const name of Object.keys(pkg.bin)) {
  const target = installedBin(name);
  if (!fs.existsSync(target)) throw new Error(`installed launcher missing: ${target}`);
  const sh = path.join(bin, name);
  fs.writeFileSync(sh, `#!/usr/bin/env sh\n# SFsmiths launcher (installed copy ${pkg.version}) — reinstall with: npm run install:toolkit\nexec node "${target}" "$@"\n`);
  fs.chmodSync(sh, 0o755);
  fs.writeFileSync(path.join(bin, `${name}.cmd`), `@echo off\r\nnode "${target}" %*\r\n`);
}
fs.writeFileSync(path.join(home, "INSTALLED.json"), JSON.stringify({ version: pkg.version, installed_at: new Date().toISOString(), from: repo }, null, 2));
fs.mkdirSync(path.join(home, "engine"), { recursive: true });

console.log(`\n✅ installed sfsmiths ${pkg.version}\n   launchers: ${bin}\n   engine keychain home: ${path.join(home, "engine")}\n`);
const onPath = (process.env.PATH || "").split(path.delimiter).includes(bin);
if (!onPath) {
  console.log(`Add to your shell profile (needed for hooks + \`sfsmiths\` on the command line):\n\n   export PATH="${bin}:$PATH"\n`);
  if (process.platform === "win32") console.log(`   (Windows: add ${bin} to the user PATH; hooks in .claude/settings.json use $HOME/.sfsmiths/bin — Phase 4 verifies the shell used by Claude Code on Windows)`);
}
console.log("Next: sfsmiths-human setup  →  sfsmiths-human org login …  →  sfsmiths-human doctor");
