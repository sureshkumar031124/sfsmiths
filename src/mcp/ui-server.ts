/**
 * mcp/ui-server.ts — `sfsmiths-mcp-ui`: Playwright verbs for the a8-ui agent, fenced to the development org.
 *
 * Hard rules (config/safety.yaml → ui):
 *   - prod_refuse: production hosts are refused, always. The evidence org's host is resolved at start and
 *     black-listed; login.salesforce.com is black-listed; any host NOT in the allowlist is refused (fail-closed).
 *   - allowlist = development org hosts (config instance_url + `sf org display` in the agent keychain)
 *                 + test.salesforce.com + SFSMITHS_UI_ALLOW_HOSTS (set by the engine for the qa_uat stage only).
 *   - deny_url_patterns (Setup, /_ui/system …) are refused on every navigation, including redirects,
 *     because they are enforced in a route handler, not just on the requested URL.
 *   - no JavaScript evaluation verb: reading is via locators/innerText only.
 *   - Playwright is an optional peer: if it is not installed every verb answers "unavailable" with the install line.
 *   - screenshots/traces go to work/<TICKET>/ui/ (or .sfsmiths/ui/) — never outside the project.
 */
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, type AllConfig } from "../core/config.js";
import { projectPaths, sanitizeTicket, vaultDir } from "../core/paths.js";
import { orgDisplay, sf } from "../core/sf.js";
import { appendLine, ensureDir, nowIso, tsCompact } from "../core/util.js";
import { checkUrl, globToRe, relatedHosts } from "./ui-fence.js";
export { relatedHosts, checkUrl };

const p = projectPaths();

type Page = { goto(u: string, o?: unknown): Promise<unknown>; url(): string; locator(s: string): Locator; getByText(t: string, o?: unknown): Locator; getByRole(r: never, o?: unknown): Locator; getByLabel(l: string, o?: unknown): Locator; screenshot(o: unknown): Promise<unknown>; waitForSelector(s: string, o?: unknown): Promise<unknown>; waitForTimeout(ms: number): Promise<void>; waitForLoadState(s?: string, o?: unknown): Promise<void>; route(u: string, h: (route: Route) => Promise<void> | void): Promise<void>; close(): Promise<void>; title(): Promise<string> };
type Locator = { click(o?: unknown): Promise<void>; fill(v: string, o?: unknown): Promise<void>; selectOption(v: string | string[]): Promise<unknown>; innerText(o?: unknown): Promise<string>; first(): Locator; count(): Promise<number>; isVisible(): Promise<boolean> };
type Route = { request(): { url(): string; isNavigationRequest(): boolean }; abort(code?: string): Promise<void>; continue(): Promise<void> };

interface Session { browser: { close(): Promise<void> }; context: { close(): Promise<void>; newPage(): Promise<Page> }; page: Page; started: string; ticket?: string }

let session: Session | undefined;
let hosts: { allow: Set<string>; deny: Set<string>; denyPaths: RegExp[]; resolved_at: string } | undefined;

function text(obj: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }], ...(isError ? { isError: true as const } : {}) };
}


async function resolveHosts(cfg: AllConfig): Promise<NonNullable<typeof hosts>> {
  if (hosts && Date.now() - Date.parse(hosts.resolved_at) < 10 * 60_000) return hosts;
  const allow = new Set<string>(["test.salesforce.com"]);
  const deny = new Set<string>(["login.salesforce.com"]);
  const hostOf = (u?: string | null) => { try { return u ? new URL(u).host.toLowerCase() : undefined; } catch { return undefined; } };
  for (const o of cfg.orgs.orgs) {
    const fromCfg = hostOf(o.instance_url);
    let live: string | undefined;
    if (o.keychain === "agent") { const d = await orgDisplay(o.alias, "agent"); live = hostOf(d.data?.instanceUrl); }
    for (const h of [fromCfg, live].flatMap((x) => (x ? relatedHosts(x) : []))) {
      if (o.role === "development") allow.add(h);
      if (o.role === "evidence" && cfg.safety.ui.prod_refuse) deny.add(h);
      // preprod hosts are NOT added — agents never UI-test preprod; the engine passes SFSMITHS_UI_ALLOW_HOSTS at qa_uat
    }
  }
  for (const h of (process.env.SFSMITHS_UI_ALLOW_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) allow.add(h);
  for (const h of deny) allow.delete(h); // deny always wins
  hosts = { allow, deny, denyPaths: cfg.safety.ui.deny_url_patterns.map(globToRe), resolved_at: nowIso() };
  return hosts;
}



function log(entry: Record<string, unknown>): void {
  appendLine(path.join(p.state, "ui.log.jsonl"), JSON.stringify({ ts: nowIso(), ...entry }));
}

async function loadPlaywright(): Promise<{ chromium: { launch(o?: unknown): Promise<{ newContext(o?: unknown): Promise<Session["context"]>; close(): Promise<void> }> } } | undefined> {
  try {
    // module name built at runtime so `tsc` does not require the optional peer to be installed
    const name = ["play", "wright"].join("");
    const mod = (await import(name)) as unknown as { chromium: { launch(o?: unknown): Promise<{ newContext(o?: unknown): Promise<Session["context"]>; close(): Promise<void> }> } };
    return mod;
  } catch { return undefined; }
}

const UNAVAILABLE = "Playwright is not installed in this project. Human: `npm i -D playwright@1.63.0 && npx playwright install chromium` (optional dependency — the rest of SFsmiths works without it).";

async function ensureSession(ticket?: string): Promise<Session | string> {
  if (session) { if (ticket) session.ticket = ticket; return session; }
  const pw = await loadPlaywright();
  if (!pw) return UNAVAILABLE;
  const cfg = loadConfig(p, { fresh: true });
  const h = await resolveHosts(cfg);
  const browser = await pw.chromium.launch({ headless: process.env.SFSMITHS_UI_HEADED !== "1" });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: false });
  const page = await context.newPage();
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (!req.isNavigationRequest()) return route.continue();
    const c = checkUrl(req.url(), h);
    if (!c.ok) { log({ refused: c.reason, url: req.url().slice(0, 300) }); return route.abort("blockedbyclient"); }
    return route.continue();
  });
  session = { browser, context, page, started: nowIso(), ticket };
  return session;
}

function outDir(ticket?: string): string {
  const d = ticket ? path.join(vaultDir(p, sanitizeTicket(ticket)), "ui") : path.join(p.state, "ui");
  ensureDir(d);
  return d;
}

const ticketArg = z.string().regex(/^[A-Z][A-Z0-9_]{0,15}-\d{1,8}$/).optional().describe("Ticket key — screenshots go to work/<KEY>/ui/");
const selectorArg = z.string().min(1).max(500).describe("Playwright selector or locator text (CSS, text=…, role=…, label=…)");

export async function main(): Promise<void> {
  const server = new McpServer({ name: "sfsmiths-ui", version: "0.2.0" }, {
    instructions: "Browser verbs fenced to the DEVELOPMENT org. Production and Setup URLs are refused at the network layer. Log in with ui_login (frontdoor via the agent keychain), then ui_goto/ui_click/ui_fill/ui_text/ui_screenshot. Always pass the ticket so evidence lands in the vault. Close with ui_close.",
  });

  server.registerTool("ui_login", {
    title: "Log the browser into the development org",
    description: "Opens the org's frontdoor URL (from `sf org open --url-only` in the agent keychain) so the browser session is authenticated. Only orgs with role=development are accepted; evidence/production is refused even though a read-only user exists.",
    inputSchema: { org_alias: z.string().regex(/^[A-Za-z][\w-]{0,40}$/).optional().describe("Defaults to the configured development org"), ticket: ticketArg },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ org_alias, ticket }) => {
    try {
      const cfg = loadConfig(p, { fresh: true });
      const org = org_alias ? cfg.orgs.orgs.find((o) => o.alias.toLowerCase() === org_alias.toLowerCase()) : cfg.orgs.orgs.find((o) => o.role === "development");
      if (!org) return text(`unknown org ${org_alias}`, true);
      if (org.role !== "development") return text(`REFUSED: ui_login is only allowed for development orgs (${org.alias} is ${org.role})`, true);
      const s = await ensureSession(ticket);
      if (typeof s === "string") return text(s, true);
      const r = await sf<{ url?: string }>(["org", "open", "-o", org.alias, "--url-only", "--json"], { keychain: "agent" });
      const url = r.data?.url;
      if (!r.ok || !url) return text(`sf org open --url-only failed: ${r.error ?? "no url"}`, true);
      const h = await resolveHosts(cfg);
      const c = checkUrl(url, h);
      if (!c.ok) return text(`REFUSED: ${c.reason}`, true);
      await s.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await s.page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
      log({ action: "login", org: org.alias, ticket, landed: s.page.url().slice(0, 200) });
      return text({ ok: true, org: org.alias, landed_on: s.page.url(), title: await s.page.title() });
    } catch (e) { return text(`ui_login failed: ${(e as Error).message}`, true); }
  });

  server.registerTool("ui_goto", {
    title: "Navigate",
    description: "Navigate the fenced browser to a URL in the development org (https only; production, login.salesforce.com and Setup paths are refused).",
    inputSchema: { url: z.string().url(), ticket: ticketArg },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ url, ticket }) => {
    try {
      const s = await ensureSession(ticket); if (typeof s === "string") return text(s, true);
      const c = checkUrl(url, await resolveHosts(loadConfig(p)));
      if (!c.ok) { log({ refused: c.reason, url }); return text(`REFUSED: ${c.reason}`, true); }
      await s.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      log({ action: "goto", url: url.slice(0, 300), ticket });
      return text({ ok: true, url: s.page.url(), title: await s.page.title() });
    } catch (e) { return text(`ui_goto failed: ${(e as Error).message}`, true); }
  });

  server.registerTool("ui_click", {
    title: "Click", description: "Click the first element matching the selector.",
    inputSchema: { selector: selectorArg, ticket: ticketArg },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ selector, ticket }) => {
    try { const s = await ensureSession(ticket); if (typeof s === "string") return text(s, true); await s.page.locator(selector).first().click({ timeout: 15_000 }); await s.page.waitForLoadState("domcontentloaded").catch(() => {}); log({ action: "click", selector, ticket }); return text({ ok: true, url: s.page.url() }); }
    catch (e) { return text(`ui_click failed: ${(e as Error).message}`, true); }
  });

  server.registerTool("ui_fill", {
    title: "Fill", description: "Fill an input/textarea (clears first). Values are logged truncated; never type real customer emails — use the allowed test domains from config/safety.yaml.",
    inputSchema: { selector: selectorArg, value: z.string().max(5000), ticket: ticketArg },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ selector, value, ticket }) => {
    try {
      const cfg = loadConfig(p);
      if (/@/.test(value) && !cfg.safety.allowed_test_emails.some((g) => globToRe(g).test(value.trim()))) { log({ refused: "email not in allowed_test_emails", selector, ticket }); return text(`REFUSED: "${value}" looks like an email that is not in safety.allowed_test_emails (${cfg.safety.allowed_test_emails.join(", ")})`, true); }
      const s = await ensureSession(ticket); if (typeof s === "string") return text(s, true);
      await s.page.locator(selector).first().fill(value, { timeout: 15_000 }); log({ action: "fill", selector, value: value.slice(0, 40), ticket }); return text({ ok: true });
    } catch (e) { return text(`ui_fill failed: ${(e as Error).message}`, true); }
  });

  server.registerTool("ui_select", {
    title: "Select option", description: "Select an option in a <select> by value or label.",
    inputSchema: { selector: selectorArg, value: z.string().max(500), ticket: ticketArg },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ selector, value, ticket }) => {
    try { const s = await ensureSession(ticket); if (typeof s === "string") return text(s, true); await s.page.locator(selector).first().selectOption(value); log({ action: "select", selector, ticket }); return text({ ok: true }); }
    catch (e) { return text(`ui_select failed: ${(e as Error).message}`, true); }
  });

  server.registerTool("ui_text", {
    title: "Read text", description: "innerText of the first matching element (or the whole body when selector is omitted), capped at 20k chars. This is your evidence — quote it with source L4 and the screenshot path.",
    inputSchema: { selector: selectorArg.optional(), ticket: ticketArg },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ selector, ticket }) => {
    try { const s = await ensureSession(ticket); if (typeof s === "string") return text(s, true); const t = await s.page.locator(selector ?? "body").first().innerText({ timeout: 15_000 }); return text({ url: s.page.url(), selector: selector ?? "body", text: t.slice(0, 20_000), truncated: t.length > 20_000 }); }
    catch (e) { return text(`ui_text failed: ${(e as Error).message}`, true); }
  });

  server.registerTool("ui_wait_for", {
    title: "Wait for selector", description: "Wait until a selector is visible (max 60s).",
    inputSchema: { selector: selectorArg, timeout_ms: z.number().int().min(100).max(60_000).default(15_000), ticket: ticketArg },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ selector, timeout_ms, ticket }) => {
    try { const s = await ensureSession(ticket); if (typeof s === "string") return text(s, true); await s.page.waitForSelector(selector, { state: "visible", timeout: timeout_ms }); return text({ ok: true }); }
    catch (e) { return text(`ui_wait_for failed: ${(e as Error).message}`, true); }
  });

  server.registerTool("ui_screenshot", {
    title: "Screenshot", description: "Full-page PNG into work/<TICKET>/ui/<name>-<ts>.png (or .sfsmiths/ui/). Returns the path — reference it in your report as evidence (source L4).",
    inputSchema: { name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/).describe("kebab-case, describes what is shown, e.g. case-page-after-save"), ticket: ticketArg },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ name, ticket }) => {
    try { const s = await ensureSession(ticket); if (typeof s === "string") return text(s, true); const file = path.join(outDir(ticket ?? s.ticket), `${name}-${tsCompact()}.png`); await s.page.screenshot({ path: file, fullPage: true }); log({ action: "screenshot", file, ticket }); return text({ ok: true, file: path.relative(p.root, file), url: s.page.url() }); }
    catch (e) { return text(`ui_screenshot failed: ${(e as Error).message}`, true); }
  });

  server.registerTool("ui_current", {
    title: "Current URL + title", description: "Where the browser is right now.", inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => { if (!session) return text({ open: false }); return text({ open: true, url: session.page.url(), title: await session.page.title(), since: session.started }); });

  server.registerTool("ui_close", {
    title: "Close browser", description: "Close the browser session (always do this at the end).", inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async () => { if (session) { await session.context.close().catch(() => {}); await session.browser.close().catch(() => {}); session = undefined; log({ action: "close" }); } return text({ ok: true }); });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const cleanup = async () => { if (session) { await session.browser.close().catch(() => {}); } process.exit(0); };
  process.on("SIGINT", cleanup); process.on("SIGTERM", cleanup);
}

main().catch((e) => { process.stderr.write(`sfsmiths-mcp-ui failed: ${(e as Error).message}\n`); process.exit(1); });
