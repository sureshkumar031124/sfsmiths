/**
 * config.ts — loads config/*.yaml, validates against schemas/config/*.schema.json.
 *
 * Config files are the SOURCE OF TRUTH (the UI is only an editor for them).
 * Nothing company-specific lives in code: org aliases, roles, tracker project key,
 * allowed test emails, naming patterns, model aliases — all here.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { projectPaths, packageRoot, type ProjectPaths } from "./paths.js";
import { exists, SfsmithsError } from "./util.js";
import { validateAgainst } from "./schema.js";

export type OrgRole = "development" | "preprod" | "evidence";
export type Keychain = "agent" | "engine";

export interface OrgConfig {
  alias: string;
  role: OrgRole;
  keychain: Keychain;
  write: boolean;
  readonly_user?: string | null;
  email_deliverability?: "system_only" | "no_access" | "all_email" | "unknown";
  deliverability_verified_on?: string | null;
  deliverability_verified_by?: string | null;
  instance_url?: string | null;
  notes?: string | null;
}

export interface OrgsConfig {
  version: number;
  default_count: number;
  orgs: OrgConfig[];
}

export interface ModelsConfig {
  version: number;
  agents: Record<string, string>; // agent name → model alias (opus|sonnet|haiku|fable|inherit|full id)
  fallback?: string;
}

export type Tier = "LOW" | "MEDIUM" | "HIGH";
export type GateMode = "ask" | "auto";

export interface AutonomyConfig {
  version: number;
  tiers: Record<Tier, { human_gates: Record<string, GateMode> }>;
  agents: Record<string, GateMode | "inherit">;
  hard_floor: string[];
}

export interface BudgetsConfig {
  version: number;
  per_ticket: { tokens: number; usd: number; wall_minutes: number };
  daily_usd: number;
  on_exceed: "park";
  pipeline_max_budget_usd: number;
}

export interface SafetyConfig {
  version: number;
  allowed_test_emails: string[];
  refuse_field_types: string[];
  require_canary_before_data_stages: boolean;
  canary_max_age_minutes: number;
  canary_recipient_env: string;
  test_tag_field: string;
  test_tag_prefix: string;
  ui: { prod_refuse: boolean; deny_url_patterns: string[]; uat_test_user_only: boolean };
}

export interface NamingRule {
  pattern: string;      // regex the name must match
  min_words?: number;   // descriptive words required (ticket key not counted)
  examples_good?: string[];
  examples_bad?: string[];
}

export interface NamingConfig {
  version: number;
  ticket_key_regex: string;
  forbid_ticket_only_names: boolean;
  rules: {
    apex_class: NamingRule;
    apex_test_class: NamingRule;
    apex_trigger: NamingRule;
    flow: NamingRule;
    custom_field: NamingRule;
    custom_object: NamingRule;
    validation_rule: NamingRule;
    test_record: NamingRule;
    permission_set: NamingRule;
  };
}

export interface RewardsConfig {
  version: number;
  events: Record<string, number>;
  weights?: { escaped_defect_stage_split?: Record<string, number> };
}

export interface LearningConfig {
  version: number;
  inject_cap: number;
  auto_promote: {
    enabled: boolean;
    types: string[];
    min_confirmations: number;
    max_negatives: number;
    live_reverify: boolean;
  };
  mechanical_promotion: { min_hits: number; max_cumulative_score: number };
  negative_streak_tickets: number;
  golden: { min_fail_to_pass: number; max_nonexistent_components: number };
  weekly_review_day: string;
}

export interface PolicyConfig {
  version: number;
  allowed_deploy_targets: string[]; // aliases (development role)
  alias_map: Record<string, string>; // legacy alias/username → canonical alias
  deny: {
    prod_raw_soql: boolean;
    bluecanvas_git_push: boolean;
    home_override: boolean;
    sf_env_override: boolean;
    engine_home_access: boolean;
    human_verbs_from_agent: boolean;
  };
  bluecanvas_remote_patterns: string[];
  baseline_sync?: { uat_newer: "apply_and_notify" | "ask"; dev_newer: "manual"; both_changed: "manual"; unknown_ancestor: "manual"; max_components?: number };
}

export interface MaskingObject {
  allow: string[];
  summarise_long_text?: boolean;
  max_rows?: number;
}

export interface MaskingConfig {
  version: number;
  on_unlisted: "refuse";
  refuse_field_types: string[];
  refuse_field_name_patterns: string[];
  default_max_rows: number;
  objects: Record<string, MaskingObject>;
}

export interface TrackerConfig {
  version: number;
  adapter: "jira" | "file";
  project_key: string;
  jira: {
    base_url: string;
    email_env: string;
    token_env: string;
    prior_art_jql: string;
    max_results: number;
  };
  post_draft: "disabled";
}

export interface NotifyConfig {
  version: number;
  slack: { enabled: boolean; webhook_env: string; on: string[] };
}

export interface CalendarConfig {
  version: number;
  timezone: string;
  freeze_windows: { name: string; from: string; to: string; note?: string }[];
}

export interface ApproversConfig {
  version: number;
  approvers: { name: string; role: string; slack?: string; stages?: string[] }[];
}

export interface AllConfig {
  orgs: OrgsConfig;
  models: ModelsConfig;
  autonomy: AutonomyConfig;
  budgets: BudgetsConfig;
  safety: SafetyConfig;
  naming: NamingConfig;
  rewards: RewardsConfig;
  learning: LearningConfig;
  policy: PolicyConfig;
  masking: MaskingConfig;
  tracker: TrackerConfig;
  notify: NotifyConfig;
  calendar: CalendarConfig;
  approvers: ApproversConfig;
}

export const CONFIG_FILES: (keyof AllConfig)[] = [
  "orgs", "models", "autonomy", "budgets", "safety", "naming", "rewards",
  "learning", "policy", "masking", "tracker", "notify", "calendar", "approvers",
];

function schemaPath(name: string): string | undefined {
  // prefer project schemas (user may extend), fall back to the package's own
  const candidates = [
    path.join(projectPaths().schemas, "config", `${name}.schema.json`),
    path.join(packageRoot(), "schemas", "config", `${name}.schema.json`),
  ];
  return candidates.find((c) => exists(c));
}

export function loadConfigFile<K extends keyof AllConfig>(name: K, p: ProjectPaths = projectPaths()): AllConfig[K] {
  const file = path.join(p.config, `${name}.yaml`);
  if (!exists(file)) {
    throw new SfsmithsError(`Missing config/${name}.yaml — run \`sfsmiths-human setup\` (no silent defaults for orgs/emails).`, "CONFIG_MISSING", { file });
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new SfsmithsError(`config/${name}.yaml is not valid YAML: ${(e as Error).message}`, "CONFIG_INVALID", { file });
  }
  const sp = schemaPath(name);
  if (sp) {
    const errors = validateAgainst(sp, parsed);
    if (errors.length) {
      throw new SfsmithsError(`config/${name}.yaml failed validation:\n  - ${errors.join("\n  - ")}`, "CONFIG_INVALID", { file, errors });
    }
  }
  return parsed as AllConfig[K];
}

let cache: { root: string; cfg: AllConfig } | undefined;

export function loadConfig(p: ProjectPaths = projectPaths(), opts: { fresh?: boolean } = {}): AllConfig {
  if (!opts.fresh && cache && cache.root === p.root) return cache.cfg;
  const cfg = Object.fromEntries(CONFIG_FILES.map((n) => [n, loadConfigFile(n, p)])) as unknown as AllConfig;
  cache = { root: p.root, cfg };
  return cfg;
}

/** Partial loader for hooks/doctor: returns what loads, reports what doesn't. */
export function tryLoadConfig(p: ProjectPaths = projectPaths()): { cfg: Partial<AllConfig>; errors: Record<string, string> } {
  const cfg: Partial<AllConfig> = {};
  const errors: Record<string, string> = {};
  for (const n of CONFIG_FILES) {
    try {
      (cfg as Record<string, unknown>)[n] = loadConfigFile(n, p);
    } catch (e) {
      errors[n] = (e as Error).message;
    }
  }
  return { cfg, errors };
}

export function orgByRole(cfg: AllConfig, role: OrgRole): OrgConfig | undefined {
  return cfg.orgs.orgs.find((o) => o.role === role);
}

export function orgByAlias(cfg: AllConfig, alias: string): OrgConfig | undefined {
  const canon = cfg.policy.alias_map[alias] ?? alias;
  return cfg.orgs.orgs.find((o) => o.alias === canon || o.alias.toLowerCase() === canon.toLowerCase());
}

export function devOrg(cfg: AllConfig): OrgConfig {
  const o = orgByRole(cfg, "development");
  if (!o) throw new SfsmithsError("No org with role=development in config/orgs.yaml", "CONFIG_INVALID");
  return o;
}

export function preprodOrg(cfg: AllConfig): OrgConfig | undefined {
  return orgByRole(cfg, "preprod");
}

export function evidenceOrg(cfg: AllConfig): OrgConfig | undefined {
  return orgByRole(cfg, "evidence");
}

export function writeConfigFile<K extends keyof AllConfig>(name: K, value: AllConfig[K], p: ProjectPaths = projectPaths()): void {
  const sp = schemaPath(name);
  if (sp) {
    const errors = validateAgainst(sp, value);
    if (errors.length) throw new SfsmithsError(`Refusing to write invalid config/${name}.yaml:\n  - ${errors.join("\n  - ")}`, "CONFIG_INVALID", { errors });
  }
  fs.mkdirSync(p.config, { recursive: true });
  const header = `# config/${name}.yaml — edited by sfsmiths-human setup/ui. Source of truth (UI is only an editor).\n`;
  fs.writeFileSync(path.join(p.config, `${name}.yaml`), header + YAML.stringify(value), "utf8");
  cache = undefined;
}
