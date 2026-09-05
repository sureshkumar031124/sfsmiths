/**
 * notify.ts — Slack incoming webhook (optional). URL comes from an env var named in config/notify.yaml.
 * Never includes untrusted ticket text verbatim beyond the title (P7 surface).
 */
import type { AllConfig } from "../core/config.js";
import { appendLine, nowIso } from "../core/util.js";
import path from "node:path";
import { projectPaths } from "../core/paths.js";

export type NotifyKind = "gate_manual" | "escalation" | "budget" | "ready_for_deploy" | "negative_streak" | "canary_fail" | "stop_cap" | "info";

export async function notify(cfg: AllConfig | undefined, kind: NotifyKind, text: string, meta: Record<string, unknown> = {}): Promise<{ sent: boolean; reason?: string }> {
  // always log locally
  try {
    appendLine(path.join(projectPaths().state, "notifications.jsonl"), JSON.stringify({ ts: nowIso(), kind, text, meta }));
  } catch { /* ignore */ }
  if (!cfg?.notify?.slack?.enabled) return { sent: false, reason: "slack disabled" };
  if (!cfg.notify.slack.on.includes(kind) && kind !== "info") return { sent: false, reason: `kind ${kind} not enabled` };
  const url = process.env[cfg.notify.slack.webhook_env];
  if (!url) return { sent: false, reason: `env ${cfg.notify.slack.webhook_env} not set` };
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `SFsmiths · ${kind}: ${text}` }) });
    return { sent: res.ok, reason: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (e) {
    return { sent: false, reason: (e as Error).message };
  }
}
