/**
 * tests-ui/auth.setup.ts — logs the browser into the DEVELOPMENT org via the sf frontdoor URL and saves storageState.
 * HARD RULES (do not edit this guard; the write-guard/review will flag it):
 *   - production hosts (login.salesforce.com and the evidence org's instance) are refused
 *   - only orgs with role=development in config/orgs.yaml are accepted, unless SFSMITHS_UI_ALLOW_HOSTS names the host
 *     (the engine sets that for preprod runs as the least-privilege test user)
 */
import { test as setup, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROD_HOSTS = ["login.salesforce.com"];

setup("authenticate against the development org", async ({ page }) => {
  const alias = process.env.SFSMITHS_UI_ORG ?? "DevSandbox";
  const out = execFileSync("sf", ["org", "open", "-o", alias, "--url-only", "--json"], { encoding: "utf8" });
  const url = String(JSON.parse(out).result?.url ?? "");
  const host = new URL(url).host.toLowerCase();
  const allow = (process.env.SFSMITHS_UI_ALLOW_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (PROD_HOSTS.includes(host) || /(^|\.)my\.salesforce\.com$/.test(host) && !/sandbox|develop|scratch/.test(host) && !allow.includes(host)) {
    throw new Error(`REFUSED: ${host} looks like production. tests-ui only runs against sandboxes (P1).`);
  }
  await page.goto(url);
  await expect(page).toHaveURL(/lightning|salesforce|force\.com/);
  const dir = path.resolve(__dirname, "..", ".sfsmiths", "ui");
  fs.mkdirSync(dir, { recursive: true });
  await page.context().storageState({ path: path.join(dir, "storageState.json") });
});
