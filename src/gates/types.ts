/**
 * Gate contract. Every gate returns passed | failed | unavailable — never a fourth state.
 * `unavailable` means "could not check" and NEVER counts as passed (P8).
 */
import type { AllConfig } from "../core/config.js";
import type { Manifest, GateStatus } from "../core/manifest.js";
import type { ProjectPaths } from "../core/paths.js";

export interface GateContext {
  p: ProjectPaths;
  cfg: AllConfig;
  ticket: string;
  stage: string;
  manifest: Manifest;
  vault: string;                 // work/<TICKET>
  agent?: string;
  options: Record<string, string>; // --scope tests, --phase fail|pass|uat, etc.
}

export interface GateOutcome {
  name: string;
  status: GateStatus;
  reason?: string;
  artifact_hash?: string;        // hash of what was checked; if the artifact changes, the result is void
  details?: unknown;             // written to validations/<stage>-<gate>.json
  reward_events?: string[];      // extra reward event keys (e.g. "email_guard.blocked")
}

export interface Gate {
  name: string;
  description: string;
  run(ctx: GateContext): Promise<GateOutcome>;
}

export function passed(name: string, reason?: string, extra: Partial<GateOutcome> = {}): GateOutcome {
  return { name, status: "passed", reason, ...extra };
}
export function failed(name: string, reason: string, extra: Partial<GateOutcome> = {}): GateOutcome {
  return { name, status: "failed", reason, ...extra };
}
export function unavailable(name: string, reason: string, extra: Partial<GateOutcome> = {}): GateOutcome {
  return { name, status: "unavailable", reason: `unavailable: ${reason}`, ...extra };
}
