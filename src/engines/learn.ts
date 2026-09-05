/**
 * learn.ts — Reward ledger (code), lesson candidates, daily learn, lesson governance, skill generation (Part 11 §12, P11).
 *
 * Scores are computed from events.jsonl ONLY. They never reach a prompt as "you scored X";
 * they rank lessons, drive promotion proposals and alerts.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadConfig, type AllConfig } from "../core/config.js";
import { readAllEvents, readEvents, emitEvent, type SfEvent } from "../core/events.js";
import { listTickets, loadManifest, tryLoadManifest } from "../core/manifest.js";
import { projectPaths, vaultDir, type ProjectPaths } from "../core/paths.js";
import { STAGE_BY_ID, AGENT_NAMES } from "../core/state-machine.js";
import { appendLine, ensureDir, exists, listFiles, nowIso, readJsonOr, readText, sha256, slug, tsCompact, writeJsonAtomic, writeTextAtomic } from "../core/util.js";
import { notify } from "./notify.js";

/* ---------------- rewards ---------------- */

export interface RewardItem { id: string; ts: string; ticket: string; agent: string; key: string; points: number; stage?: string; note?: string }

export interface RewardSummary {
  computed_at: string;
  total: number;
  by_agent: Record<string, number>;
  by_ticket: Record<string, number>;
  by_key: Record<string, number>;
  items: RewardItem[];
}

function agentFor(ev: SfEvent): string {
  return ev.agent ?? (ev.stage ? STAGE_BY_ID[ev.stage]?.agent ?? "conductor" : "conductor");
}

export function computeRewards(events: SfEvent[], cfg: AllConfig): RewardSummary {
  const pts = cfg.rewards.events;
  const items: RewardItem[] = [];
  const push = (ev: SfEvent, key: string, agent = agentFor(ev), note?: string) => {
    const points = pts[key];
    if (points === undefined) return;
    items.push({ id: sha256(`${ev.ts}|${ev.ticket}|${ev.type}|${key}|${agent}|${JSON.stringify(ev.data ?? {})}`).slice(0, 16), ts: ev.ts, ticket: ev.ticket, agent, key, points, stage: ev.stage, note });
  };
  const escaped = new Set(events.filter((e) => e.type === "escaped_defect").map((e) => e.ticket));
  for (const ev of events) {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    switch (ev.type) {
      case "gate.passed": if (d.first_try) push(ev, "gate.passed.first_try"); break;
      case "gate.failed":
        push(ev, "gate.failed");
        for (const k of (d.reward_events as string[] | undefined) ?? []) push(ev, k);
        break;
      case "stage.started": if (Number(d.attempt ?? 1) > 1) push(ev, "stage.retry"); break;
      case "stage.bounced":
        // only QA-initiated bounces score against the developer/architect; self-retries are covered by stage.retry
        if (/^qa_/.test(String(d.from ?? ev.stage ?? ""))) push(ev, d.to === "plan" ? "bounce.qa_to_plan" : "bounce.qa_to_develop", d.to === "plan" ? "a3-architect" : "a4-developer");
        break;
      case "human.approved": push(ev, "human.approved"); if (ev.stage === "review") push(ev, "deploy_brief.accepted", "a6-reviewer"); break;
      case "human.approved_with_edits": push(ev, "human.approved_with_edits"); break;
      case "human.rejected": push(ev, "human.rejected"); break;
      case "escalation.honest": push(ev, "escalation.honest", ev.agent ?? agentFor(ev)); break;
      case "escalation.weak": push(ev, "escalation.weak", ev.agent ?? agentFor(ev)); break;
      case "policy.denied": push(ev, "policy.denied", ev.agent ?? "conductor"); break;
      case "write.denied": push(ev, "write.denied", ev.agent ?? "conductor"); break;
      case "agent.spawn_denied": push(ev, "agent.spawn_denied", "conductor"); break;
      case "email_guard.blocked": push(ev, "email_guard.blocked", ev.agent ?? "a2-repro"); break;
      case "ticket.parked": push(ev, "budget.exceeded", "ticket"); break;
      case "stop.cap_hit": push(ev, "stop.cap_hit", "conductor"); break;
      case "lesson.approved": push(ev, "lesson.approved", "a7-coach"); break;
      case "lesson.rejected": push(ev, "lesson.rejected", "a7-coach"); break;
      case "escaped_defect": {
        const total = pts["escaped_defect"] ?? -20;
        const split = cfg.rewards.weights?.escaped_defect_stage_split ?? { "a3-architect": 0.4, "a4-developer": 0.3, "a5-qa": 0.2, "a6-reviewer": 0.1 };
        for (const [agent, w] of Object.entries(split)) items.push({ id: sha256(`${ev.ts}|${ev.ticket}|escaped|${agent}`).slice(0, 16), ts: ev.ts, ticket: ev.ticket, agent, key: "escaped_defect", points: Math.round(total * w * 100) / 100, stage: ev.stage });
        break;
      }
      case "prod.verified": {
        // +5 only when 7 days have passed with no escaped defect
        const ageDays = (Date.now() - new Date(ev.ts).getTime()) / 86_400_000;
        if (ageDays >= 7 && !escaped.has(ev.ticket) && Number(d.total ?? 0) > 0 && Number(d.passed ?? 0) === Number(d.total ?? 0)) push(ev, "prod.verified_clean_7d", "ticket");
        break;
      }
      default: break;
    }
  }
  const sum: RewardSummary = { computed_at: nowIso(), total: 0, by_agent: {}, by_ticket: {}, by_key: {}, items };
  for (const it of items) {
    sum.total += it.points;
    sum.by_agent[it.agent] = (sum.by_agent[it.agent] ?? 0) + it.points;
    sum.by_ticket[it.ticket] = (sum.by_ticket[it.ticket] ?? 0) + it.points;
    sum.by_key[it.key] = (sum.by_key[it.key] ?? 0) + it.points;
  }
  return sum;
}

export function persistRewards(sum: RewardSummary, p: ProjectPaths): void {
  writeJsonAtomic(path.join(p.metrics, "rewards.json"), sum);
  const ledger = path.join(p.knowledge, "rewards.jsonl");
  const seen = new Set(exists(ledger) ? readText(ledger).split("\n").map((l) => { try { return (JSON.parse(l) as RewardItem).id; } catch { return ""; } }) : []);
  for (const it of sum.items) if (!seen.has(it.id)) appendLine(ledger, JSON.stringify(it));
}

/* ---------------- lesson candidates ---------------- */

export type LessonType = "org-fact" | "convention" | "reuse-hint" | "process" | "safety" | "mechanical";
export type LessonStatus = "pending" | "approved" | "auto" | "rejected" | "promoted" | "retired";

export interface Lesson {
  id: string;
  title: string;
  type: LessonType;
  status: LessonStatus;
  agents: string[];
  ticket?: string;
  triggers: string[];
  evidence: string[];    // event refs / file paths
  severity: number;      // 1-5
  hits: number;
  last_hit?: string;
  created: string;
  body: string;
  confirmations?: number;
  negatives?: number;
  reward_delta?: number;
}

export function lessonsDir(p: ProjectPaths): string {
  return path.join(p.knowledge, "lessons");
}

export function parseLesson(file: string): Lesson | undefined {
  const txt = readText(file);
  const m = txt.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return undefined;
  try {
    const fm = YAML.parse(m[1]) as Partial<Lesson>;
    return { id: fm.id ?? path.basename(file, ".md"), title: fm.title ?? "", type: (fm.type ?? "process") as LessonType, status: (fm.status ?? "pending") as LessonStatus, agents: fm.agents ?? [], ticket: fm.ticket, triggers: fm.triggers ?? [], evidence: fm.evidence ?? [], severity: Number(fm.severity ?? 3), hits: Number(fm.hits ?? 1), last_hit: fm.last_hit, created: fm.created ?? nowIso(), body: m[2].trim(), confirmations: fm.confirmations, negatives: fm.negatives, reward_delta: fm.reward_delta };
  } catch {
    return undefined;
  }
}

export function writeLesson(p: ProjectPaths, l: Lesson): string {
  const dir = l.status === "pending" ? path.join(lessonsDir(p), "PENDING") : l.status === "retired" || l.status === "rejected" ? path.join(lessonsDir(p), "RETIRED") : lessonsDir(p);
  ensureDir(dir);
  const fm = { id: l.id, title: l.title, type: l.type, status: l.status, agents: l.agents, ticket: l.ticket, triggers: l.triggers, evidence: l.evidence, severity: l.severity, hits: l.hits, last_hit: l.last_hit, created: l.created, confirmations: l.confirmations ?? 0, negatives: l.negatives ?? 0, reward_delta: l.reward_delta ?? 0 };
  const file = path.join(dir, `${l.id}.md`);
  // remove stale copies in other folders
  for (const d of [lessonsDir(p), path.join(lessonsDir(p), "PENDING"), path.join(lessonsDir(p), "RETIRED")]) { const f = path.join(d, `${l.id}.md`); if (f !== file && exists(f)) fs.unlinkSync(f); }
  writeTextAtomic(file, `---\n${YAML.stringify(fm)}---\n\n${l.body.trim()}\n`);
  return file;
}

export function allLessons(p: ProjectPaths): Lesson[] {
  const out: Lesson[] = [];
  for (const d of [lessonsDir(p), path.join(lessonsDir(p), "PENDING"), path.join(lessonsDir(p), "RETIRED")]) for (const f of listFiles(d, (n) => /^L-.*\.md$/.test(n))) { const l = parseLesson(f); if (l) out.push(l); }
  return out;
}

function candidateFrom(ev: SfEvent, type: LessonType, title: string, body: string, agents: string[], severity: number, triggers: string[] = []): Lesson {
  const id = `L-${ev.ts.slice(0, 10).replace(/-/g, "")}-${slug(title).slice(0, 40)}`;
  return { id, title, type, status: "pending", agents, ticket: ev.ticket, triggers, evidence: [`events:${ev.ticket}:${ev.ts}:${ev.type}`], severity, hits: 1, last_hit: ev.ts, created: nowIso(), body };
}

export function candidatesFromEvents(events: SfEvent[], ticket: string, p: ProjectPaths): Lesson[] {
  const out: Lesson[] = [];
  const scope = readJsonOr<{ components?: string[] }>(path.join(vaultDir(p, ticket), "scope.json"), {}).components ?? [];
  const gateFails = new Map<string, SfEvent[]>();
  for (const ev of events) {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    if (ev.type === "human.rejected" || ev.type === "human.approved_with_edits") {
      const reason = String(d.reason ?? d.edits ?? "").trim();
      if (reason) out.push(candidateFrom(ev, "process", `Human ${ev.type === "human.rejected" ? "rejected" : "corrected"} ${ev.stage}: ${reason.slice(0, 60)}`, `**Signal:** ${ev.type} at stage ${ev.stage} on ${ev.ticket}.\n**Human said:** ${reason}\n\n**Proposed lesson (needs your wording):** what should the ${STAGE_BY_ID[ev.stage ?? ""]?.agent ?? "agent"} do differently next time?`, [STAGE_BY_ID[ev.stage ?? ""]?.agent ?? "conductor"], 4, scope));
    }
    if (ev.type === "gate.failed") { const g = String(d.gate); (gateFails.get(g) ?? gateFails.set(g, []).get(g)!).push(ev); }
    if (ev.type === "email_guard.blocked") out.push(candidateFrom(ev, "safety", `email-guard blocked at ${ev.stage}`, `A non-allowlisted address reached a test-data or code artifact. Review how the agent built the data (${String(d.reason ?? d.why ?? "")}).`, [ev.agent ?? "a2-repro"], 5, scope));
    if (ev.type === "ticket.escalated") out.push(candidateFrom(ev, "process", `Escalation at ${ev.stage}: ${String(d.reason ?? "").slice(0, 50)}`, `Reason: ${String(d.reason ?? "")}. Was the escalation honest (evidence attached) or premature?`, [STAGE_BY_ID[ev.stage ?? ""]?.agent ?? "conductor"], 3, scope));
  }
  for (const [gate, evs] of gateFails) if (evs.length >= 2) out.push(candidateFrom(evs[evs.length - 1], gate === "plan-lint" || gate === "semantic-check" ? "org-fact" : "process", `${gate} failed ${evs.length}× on ${ticket}`, `Repeated failures of **${gate}**:\n${evs.map((e) => `- ${e.ts}: ${String((e.data as Record<string, unknown>)?.reason ?? "")}`).join("\n")}\n\nIf this is an org fact (a name that does not exist / a field that is read-only), record the verified fact with its describe evidence.`, [evs[0].agent ?? STAGE_BY_ID[evs[0].stage ?? ""]?.agent ?? "conductor"], 3, scope));
  // agent notes (quarantined): each note is a candidate that NEEDS evidence
  const notes = path.join(vaultDir(p, ticket), "agent-notes.md");
  if (exists(notes)) for (const line of readText(notes).split("\n").filter((l) => l.startsWith("- "))) {
    const ev: SfEvent = { ts: nowIso(), ticket, type: "lesson.candidate" };
    out.push({ ...candidateFrom(ev, "process", `Agent note: ${line.slice(2, 62)}`, `${line.slice(2)}\n\n_Source: agent note — UNVERIFIED. Attach evidence (describe/Tooling/vault file) before approving._`, ["a7-coach"], 2, scope), evidence: [`vault:${ticket}:agent-notes.md`] });
  }
  return dedupeLessons(out, allLessons(p));
}

export function dedupeLessons(cands: Lesson[], existing: Lesson[]): Lesson[] {
  const key = (l: Lesson) => `${l.type}|${slug(l.title).replace(/-\d+x?-on-[a-z0-9-]+$/, "")}`;
  const seen = new Map(existing.map((l) => [key(l), l]));
  const out: Lesson[] = [];
  for (const c of cands) {
    const k = key(c);
    const prev = seen.get(k);
    if (prev) { prev.hits += 1; prev.last_hit = c.last_hit; prev.evidence = [...new Set([...prev.evidence, ...c.evidence])]; continue; }
    seen.set(k, c);
    out.push(c);
  }
  return out;
}

/* ---------------- retro per ticket ---------------- */

export async function ticketRetro(ticket: string, p: ProjectPaths = projectPaths()): Promise<{ rewards: RewardSummary; candidates: Lesson[] }> {
  const cfg = loadConfig(p);
  const events = readEvents(ticket, p);
  const rewards = computeRewards(events, cfg);
  const candidates = candidatesFromEvents(events, ticket, p);
  for (const c of candidates) { writeLesson(p, c); emitEvent({ ticket, type: "lesson.candidate", stage: "learn", agent: "a7-coach", data: { id: c.id, type: c.type } }, p); }
  const m = tryLoadManifest(ticket, p);
  const vault = vaultDir(p, ticket);
  writeJsonAtomic(path.join(vault, "09-retro.json"), { ticket, computed_at: nowIso(), rewards: { total: rewards.total, by_agent: rewards.by_agent, by_key: rewards.by_key }, candidates: candidates.map((c) => c.id), lessons: candidates.map((c) => c.title) });
  writeTextAtomic(path.join(vault, "09-retro.md"), [
    `# 09 — Retro · ${ticket}`, ``,
    `Computed ${nowIso()} by the toolkit from events.jsonl (Bowden rule: scores are code, not opinion).`, ``,
    `**Outcome:** ${m?.status ?? "?"} · **Tier:** ${m?.tier ?? "?"} · **Attempts:** ${m ? Object.values(m.stages).reduce((a, s) => a + s.attempts, 0) : "?"} · **Bounces:** ${m?.bounces.length ?? 0} · **Tokens:** ${m?.budget.tokens ?? 0}`, ``,
    `## Rewards (${rewards.total >= 0 ? "+" : ""}${rewards.total})`, `| Agent | Points |`, `|---|---|`, ...Object.entries(rewards.by_agent).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v >= 0 ? "+" : ""}${v} |`), ``,
    `| Event | Points |`, `|---|---|`, ...Object.entries(rewards.by_key).map(([k, v]) => `| ${k} | ${v >= 0 ? "+" : ""}${v} |`), ``,
    `## Lesson candidates (${candidates.length}) — pending your review (\`sfsmiths-human lessons review\`)`, ...candidates.map((c) => `- **${c.id}** [${c.type}] ${c.title} → ${c.agents.join(", ")}`), ``,
    `## Coach notes`, `_A7 may append verified observations below. Only events.jsonl, rewards and human feedback count as evidence._`, ``,
  ].join("\n"));
  persistRewards(computeRewards(readAllEvents(p), cfg), p);
  return { rewards, candidates };
}

/* ---------------- daily learn ---------------- */

export interface LearnRunResult { rewards: RewardSummary; new_candidates: number; auto_promoted: string[]; negative_streaks: { agent: string; net: number; tickets: string[] }[]; digest_file: string; synced_skills: string[] }

export async function learnDaily(p: ProjectPaths = projectPaths(), opts: { sync?: boolean } = {}): Promise<LearnRunResult> {
  const cfg = loadConfig(p);
  const all = readAllEvents(p);
  const rewards = computeRewards(all, cfg);
  persistRewards(rewards, p);
  let newCands = 0;
  const stateFile = path.join(p.state, "learn-state.json");
  const state = readJsonOr<{ digested: Record<string, string> }>(stateFile, { digested: {} });
  for (const t of listTickets(p)) {
    const m = tryLoadManifest(t, p);
    if (!m) continue;
    const key = `${t}:${m.updated_at}`;
    if (state.digested[t] === key) continue;
    const r = await ticketRetro(t, p);
    newCands += r.candidates.length;
    state.digested[t] = key;
  }
  writeJsonAtomic(stateFile, state);
  const confirmed = mergeCoachConfirmations(p);
  // negative streaks: net negative on the last N tickets per agent
  const streaks: LearnRunResult["negative_streaks"] = [];
  const recentTickets = listTickets(p).map((t) => tryLoadManifest(t, p)).filter((m): m is NonNullable<typeof m> => !!m).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, cfg.learning.negative_streak_tickets).map((m) => m.ticket);
  for (const agent of AGENT_NAMES) {
    const per = recentTickets.map((t) => rewards.items.filter((i) => i.ticket === t && i.agent === agent).reduce((a, i) => a + i.points, 0));
    if (per.length >= cfg.learning.negative_streak_tickets && per.every((x) => x < 0)) streaks.push({ agent, net: per.reduce((a, b) => a + b, 0), tickets: recentTickets });
  }
  // auto-promotion (Phase 3+): low-risk types only, with confirmations, no negatives
  const auto: string[] = [];
  if (cfg.learning.auto_promote.enabled) {
    for (const l of allLessons(p).filter((x) => x.status === "pending" && cfg.learning.auto_promote.types.includes(x.type))) {
      if ((l.confirmations ?? 0) >= cfg.learning.auto_promote.min_confirmations && (l.negatives ?? 0) <= cfg.learning.auto_promote.max_negatives) {
        l.status = "auto";
        writeLesson(p, l);
        auto.push(l.id);
        emitEvent({ ticket: l.ticket ?? "-", type: "lesson.approved", stage: "learn", agent: "a7-coach", data: { id: l.id, auto: true } }, p);
      }
    }
  }
  const pending = allLessons(p).filter((l) => l.status === "pending");
  const digest = path.join(p.knowledge, `DIGEST-${nowIso().slice(0, 10)}.md`);
  writeTextAtomic(digest, [
    `# Learn digest — ${nowIso().slice(0, 10)}`, ``,
    `Total reward points to date: ${rewards.total}. New lesson candidates today: ${newCands}. Pending review: ${pending.length}. Auto-promoted: ${auto.length}. Coach confirmations merged: ${confirmed.length}.`, ``,
    `## By agent (all time)`, ...Object.entries(rewards.by_agent).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v >= 0 ? "+" : ""}${v}`), ``,
    `## Negative streaks`, ...(streaks.length ? streaks.map((s) => `- ⚠ ${s.agent}: net ${s.net} over ${s.tickets.join(", ")}`) : ["- none"]), ``,
    `## Pending lessons (review with \`sfsmiths-human lessons review\`)`, ...pending.slice(0, 30).map((l) => `- ${l.id} [${l.type}] ${l.title} (${l.agents.join(", ")}) hits=${l.hits}`), ``,
    `## Model suggestions`, ...modelSuggestions(rewards, all), ``,
  ].join("\n"));
  for (const s of streaks) await notify(cfg, "negative_streak", `${s.agent} net ${s.net} over last ${s.tickets.length} tickets`);
  const synced = opts.sync === false ? [] : learnSync(p);
  return { rewards, new_candidates: newCands, auto_promoted: auto, negative_streaks: streaks, digest_file: path.relative(p.root, digest), synced_skills: synced };
}

/**
 * A7 (coach) cannot edit approved lessons (write-guard). It files knowledge/lessons/PENDING/CONFIRM-<lesson-id>-<date>.md
 * with new evidence refs; the daily learn run merges them: +1 confirmation, +1 hit, evidence appended, file moved to RETIRED/processed.
 */
export function mergeCoachConfirmations(p: ProjectPaths): string[] {
  const pend = path.join(lessonsDir(p), "PENDING");
  const done: string[] = [];
  for (const f of listFiles(pend, (n) => /^CONFIRM-.*\.md$/.test(n))) {
    const name = path.basename(f, ".md");
    const m = /^CONFIRM-(L-[A-Za-z0-9-]+?)(?:-\d{4}-\d{2}-\d{2}|-\d{8})?$/.exec(name);
    const target = m ? allLessons(p).find((l) => l.id === m[1] || name.startsWith(`CONFIRM-${l.id}`)) : allLessons(p).find((l) => name.startsWith(`CONFIRM-${l.id}`));
    const processed = path.join(lessonsDir(p), "RETIRED", "processed");
    ensureDir(processed);
    if (!target) { fs.renameSync(f, path.join(processed, `${name}.unmatched.md`)); continue; }
    const txt = readText(f);
    const fm = txt.match(/^---\n([\s\S]*?)\n---/);
    let evidence: string[] = [];
    try { evidence = ((fm ? YAML.parse(fm[1]) : {}) as { evidence?: string[] }).evidence ?? []; } catch { /* ignore */ }
    // only event/reward/human refs count as evidence (P6)
    evidence = evidence.filter((e) => /^(events?|rewards?|human):/i.test(String(e)));
    if (!evidence.length) { fs.renameSync(f, path.join(processed, `${name}.no-evidence.md`)); continue; }
    target.confirmations = (target.confirmations ?? 0) + 1;
    target.hits += 1;
    target.last_hit = nowIso();
    target.evidence = [...new Set([...target.evidence, ...evidence])];
    writeLesson(p, target);
    fs.renameSync(f, path.join(processed, `${name}.md`));
    emitEvent({ ticket: target.ticket ?? "-", type: "lesson.candidate", stage: "learn", agent: "a7-coach", data: { id: target.id, confirmation: true, evidence: evidence.length } }, p);
    done.push(target.id);
  }
  return done;
}

function modelSuggestions(rewards: RewardSummary, events: SfEvent[]): string[] {
  const out: string[] = [];
  const bounces = events.filter((e) => e.type === "stage.bounced");
  const qaRuns = events.filter((e) => e.type === "stage.started" && e.stage === "qa_dev").length;
  if (qaRuns >= 5 && bounces.length / qaRuns > 0.3) out.push(`- a5-qa bounce rate ${(100 * bounces.length / qaRuns).toFixed(0)}% over ${qaRuns} runs — consider a stronger model alias for a4-developer or a5-qa (config/models.yaml)`);
  for (const [agent, pts] of Object.entries(rewards.by_agent)) if (pts <= -15) out.push(`- ${agent} is at ${pts} points — review its pending lessons before changing its model`);
  return out.length ? out : ["- none yet (needs more tickets)"];
}

/* ---------------- lesson governance (human) ---------------- */

export function decideLesson(p: ProjectPaths, id: string, decision: "approve" | "reject" | "promote" | "retire", opts: { reason?: string; agents?: string[]; type?: LessonType } = {}): Lesson {
  const l = allLessons(p).find((x) => x.id === id);
  if (!l) throw new Error(`lesson ${id} not found`);
  if (opts.agents?.length) l.agents = opts.agents;
  if (opts.type) l.type = opts.type;
  if (decision === "approve") { if (l.type === "safety") l.body += `\n\n_Safety lesson approved by human on ${nowIso()}_`; l.status = "approved"; }
  if (decision === "reject") { l.status = "rejected"; l.body += `\n\n_Rejected: ${opts.reason ?? "no reason"}_`; }
  if (decision === "retire") l.status = "retired";
  if (decision === "promote") { l.status = "promoted"; l.body += `\n\n_Promoted to a mechanical check on ${nowIso()} — implement the rule/gate and reference it here._`; }
  writeLesson(p, l);
  emitEvent({ ticket: l.ticket ?? "-", type: decision === "approve" ? "lesson.approved" : decision === "reject" ? "lesson.rejected" : decision === "promote" ? "lesson.promoted" : "lesson.retired", stage: "learn", agent: "a7-coach", data: { id, reason: opts.reason } }, p);
  return l;
}

/* ---------------- skill generation (approved lessons → agents) ---------------- */

export function rankLesson(l: Lesson): number {
  const ageDays = l.last_hit ? (Date.now() - new Date(l.last_hit).getTime()) / 86_400_000 : 365;
  const recency = Math.max(0.2, 1 - ageDays / 365);
  return l.severity * recency * Math.log2(1 + l.hits) * (1 + Math.max(0, l.reward_delta ?? 0) / 10);
}

export function learnSync(p: ProjectPaths = projectPaths()): string[] {
  const cfg = loadConfig(p);
  const approved = allLessons(p).filter((l) => l.status === "approved" || l.status === "auto" || l.status === "promoted");
  const out: string[] = [];
  for (const agent of AGENT_NAMES) {
    const mine = approved.filter((l) => l.agents.includes(agent)).sort((a, b) => rankLesson(b) - rankLesson(a)).slice(0, cfg.learning.inject_cap);
    const dir = path.join(p.skills, `lessons-${agent}`);
    ensureDir(dir);
    const body = [
      `---`,
      `name: lessons-${agent}`,
      `description: Approved lessons for ${agent} (generated by sfsmiths-human learn sync — do not edit by hand; edit knowledge/lessons/*.md and re-sync). ${mine.length} lesson(s).`,
      `---`,
      ``,
      `# Lessons for ${agent}`,
      ``,
      mine.length ? `These are HUMAN-APPROVED (or evidence-verified) lessons, ranked. Apply them; if one seems wrong for this ticket, say so in your output with evidence — do not silently ignore it.` : `_No approved lessons yet. Work from the standards skills and the org conventions._`,
      ``,
      ...mine.map((l, i) => `## ${i + 1}. ${l.title}  \`${l.id}\` · ${l.type} · ${l.status}\n\n${l.body.split("\n").filter((x) => !x.startsWith("_")).join("\n").trim()}\n${l.triggers.length ? `\n_Triggers: ${l.triggers.join(", ")}_` : ""}`),
      ``,
    ].join("\n");
    writeTextAtomic(path.join(dir, "SKILL.md"), body);
    out.push(`lessons-${agent} (${mine.length})`);
  }
  return out;
}

/* ---------------- memory audit ---------------- */

export function memoryAudit(p: ProjectPaths = projectPaths()): { file: string; findings: string[] } {
  const guardsFile = path.join(p.knowledge, "guards", "injection-patterns.txt");
  const patterns = exists(guardsFile) ? readText(guardsFile).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => new RegExp(l, "i")) : [/ignore (all )?previous/i, /you must now/i, /system prompt/i, /disregard/i];
  const findings: string[] = [];
  for (const agent of AGENT_NAMES) {
    const f = path.join(p.agentMemory, agent, "MEMORY.md");
    if (!exists(f)) continue;
    const lines = readText(f).split("\n");
    lines.forEach((line, i) => {
      if (patterns.some((r) => r.test(line))) findings.push(`${agent}:${i + 1} injection-like text: ${line.slice(0, 80)}`);
      if (/\b(always|never|must)\b/i.test(line) && /deploy|approve|production|email|skip|bypass/i.test(line)) findings.push(`${agent}:${i + 1} note reads like a policy — notes cannot set policy (P11): ${line.slice(0, 80)}`);
      for (const m of line.matchAll(/\b[A-Z][A-Za-z0-9_]+__c\b/g)) {
        const name = m[0];
        const cached = listFiles(path.join(p.state, "cache", "describe"), (n) => n.endsWith(".json")).some((df) => readText(df).includes(`"${name}"`));
        if (!cached) findings.push(`${agent}:${i + 1} unverified API name in note: ${name}`);
      }
    });
    if (lines.length > 200) findings.push(`${agent}: MEMORY.md has ${lines.length} lines — only the first 200 are injected; curate`);
  }
  const file = path.join(p.knowledge, "lessons", `MEMORY-AUDIT-${nowIso().slice(0, 10)}.md`);
  writeTextAtomic(file, `# Agent memory audit — ${nowIso()}\n\n${findings.length ? findings.map((f) => `- ${f}`).join("\n") : "- no findings"}\n\nNotes are never rules. Useful notes become lesson candidates only with evidence.\n`);
  return { file: path.relative(p.root, file), findings };
}

export function lessonFromHumanFeedback(p: ProjectPaths, text: string, opts: { ticket?: string; agents?: string[]; type?: LessonType } = {}): Lesson {
  const l: Lesson = { id: `L-${tsCompact().slice(0, 10).replace(/-/g, "")}-${slug(text).slice(0, 40)}`, title: text.slice(0, 80), type: opts.type ?? "process", status: "approved", agents: opts.agents ?? ["conductor"], ticket: opts.ticket, triggers: [], evidence: [`human:feedback:${nowIso()}`], severity: 4, hits: 1, last_hit: nowIso(), created: nowIso(), body: text };
  writeLesson(p, l);
  emitEvent({ ticket: opts.ticket ?? "-", type: "human.feedback", stage: "learn", data: { id: l.id } }, p);
  emitEvent({ ticket: opts.ticket ?? "-", type: "lesson.approved", stage: "learn", agent: "a7-coach", data: { id: l.id, from: "human-feedback" } }, p);
  return l;
}
