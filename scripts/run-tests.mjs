#!/usr/bin/env node
/**
 * scripts/run-tests.mjs — run the offline test suite with an explicit file list (works on Node 20 and 22 alike).
 *
 *   node scripts/run-tests.mjs            # every test/*.test.mjs
 *   node scripts/run-tests.mjs 03 hooks   # only files whose name contains one of the words
 *
 * Why not `node --test "test/**\/*.test.mjs"`: Node 20 does not expand glob patterns in `--test` arguments
 * ("Could not find 'test/**\/*.test.mjs'"), and a bare `node --test` would also pick up test/helpers.mjs and
 * test/fixtures/** through the default `**\/test/**` pattern. Listing the files keeps the run identical everywhere.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const filters = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const passthrough = process.argv.slice(2).filter((a) => a.startsWith("--")); // e.g. --test-name-pattern=referee

const files = fs
  .readdirSync(path.join(repo, "test"))
  .filter((f) => f.endsWith(".test.mjs"))
  .filter((f) => filters.length === 0 || filters.some((w) => f.includes(w)))
  .sort()
  .map((f) => path.join("test", f));

if (files.length === 0) {
  console.error(`run-tests: no test file matches ${JSON.stringify(filters)} in test/`);
  process.exit(1);
}

const r = spawnSync(process.execPath, ["--test", ...passthrough, ...files], { cwd: repo, stdio: "inherit" });
process.exit(r.status ?? 1);
