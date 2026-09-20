/**
 * mcp/ui-fence.ts — the pure part of the browser fence (no server, no side effects) so it can be unit-tested and reused:
 * which hosts belong to an org, and whether a URL may be navigated to. ui-server.ts imports it; importing ui-server.ts
 * itself starts the MCP stdio server, which is why these live apart.
 */
function globToRe(g: string): RegExp {
  return new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
}

/** A Salesforce org answers on several hosts: instance (*.my.salesforce.com), Lightning (*.lightning.force.com),
 *  Visualforce/content (*.vf.force.com, *.file.force.com) and Experience sites (*.my.site.com). Derive them all
 *  from the instance host so the allow/deny decision covers the whole org, including the post-login redirect. */
export function relatedHosts(host: string): string[] {
  const h = host.toLowerCase();
  const out = new Set<string>([h]);
  const m = /^([a-z0-9-]+)(\.sandbox|\.develop|\.scratch|\.demo|\.patch|\.trailblaze)?\.my\.salesforce\.com$/.exec(h);
  if (m) {
    const [, name, kind = ""] = m;
    for (const suffix of ["lightning.force.com", "vf.force.com", "file.force.com", "my.site.com", "my.salesforce-sites.com", "builder.salesforce-experience.com"]) out.add(`${name}${kind}.${suffix}`);
  }
  return [...out];
}

export interface UiHosts { allow: Set<string>; deny: Set<string>; denyPaths: RegExp[] }

export function checkUrl(u: string, h: UiHosts): { ok: true } | { ok: false; reason: string } {
  let url: URL;
  try { url = new URL(u); } catch { return { ok: false, reason: `not a URL: ${u}` }; }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) return { ok: false, reason: "only https (or http://localhost) is allowed" };
  const host = url.host.toLowerCase();
  if (h.deny.has(host)) return { ok: false, reason: `PRODUCTION/LOGIN host refused: ${host} (safety.ui.prod_refuse)` };
  if (!h.allow.has(host)) return { ok: false, reason: `host not in the UI allowlist: ${host} (allowed: ${[...h.allow].join(", ") || "none — is the development org's instance_url resolvable?"})` };
  if (h.denyPaths.some((re) => re.test(url.pathname))) return { ok: false, reason: `Setup/system URL refused: ${url.pathname}` };
  return { ok: true };
}

export { globToRe };
