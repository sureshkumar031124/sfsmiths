import type { AllConfig } from "../../core/config.js";
import { JiraAdapter } from "./jira.js";
import { FileAdapter } from "./file.js";
import type { TrackerAdapter } from "./types.js";

export * from "./types.js";
export { adfToText } from "./adf.js";
export { snapshotHash, extractAcceptanceCriteria } from "./jira.js";
export { parseMarkdownTicket } from "./file.js";

export function trackerFor(cfg: AllConfig, env: NodeJS.ProcessEnv = process.env): TrackerAdapter {
  if (cfg.tracker.adapter === "jira") return new JiraAdapter(cfg.tracker.jira, env);
  return new FileAdapter();
}

/** Never let a tracker key pass through unchecked (used in file names). */
export function assertTicketKey(cfg: AllConfig, key: string): string {
  const k = key.trim().toUpperCase();
  const re = new RegExp(`^${cfg.tracker.project_key ? escapeRe(cfg.tracker.project_key) : "[A-Z][A-Z0-9_]*"}-\\d+$`);
  if (!re.test(k)) {
    // allow other project keys too (linked issues), but must look like a key
    if (!/^[A-Z][A-Z0-9_]{0,15}-\d{1,8}$/.test(k)) throw new Error(`"${key}" is not a ticket key`);
  }
  return k;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
