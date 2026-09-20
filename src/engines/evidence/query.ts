/**
 * evidence/query.ts — the ONLY road to production (P1): read-only user + field allowlist masking (FERPA).
 *
 *  - SOQL is parsed; object and every field (SELECT + WHERE + ORDER BY) must be allowlisted in config/masking.yaml
 *  - Email/Phone typed fields (describe cache) and PII-looking names are refused even when listed
 *  - long text is summarised (length only), rows capped, attributes stripped
 *  - every call is logged to .sfsmiths/evidence.log.jsonl and saved in the vault's evidence/ folder
 */
import path from "node:path";
import { evidenceOrg, type AllConfig } from "../../core/config.js";
import { projectPaths, vaultDir, type ProjectPaths } from "../../core/paths.js";
import { describe, soql, type SoqlRecord } from "../../core/sf.js";
import { appendLine, nowIso, readJsonOr, tsCompact, writeJsonAtomic, SfsmithsError } from "../../core/util.js";

export interface ParsedSoql {
  fields: string[];
  object: string;
  whereFields: string[];
  orderFields: string[];
  aggregate: boolean;
  hasSubquery: boolean;
  limit?: number;
}

const AGG_RE = /^(COUNT|COUNT_DISTINCT|SUM|AVG|MIN|MAX)\s*\(\s*([A-Za-z0-9_.]*)\s*\)(?:\s+\w+)?$/i;

export function parseSoql(q: string): ParsedSoql {
  const s = q.replace(/\s+/g, " ").trim().replace(/;$/, "");
  // one statement, read-only: a ';' or any DML keyword anywhere is refused before the query leaves the process (SOQL has no
  // DML, so this is hygiene against smuggling, but a refusal here is cheaper than a MALFORMED_QUERY round trip to production)
  if (/;/.test(s)) throw new SfsmithsError("Only one SELECT statement is allowed through the evidence layer (';' refused)", "SOQL_SHAPE");
  if (/\b(INSERT|UPDATE|DELETE|UPSERT|MERGE|UNDELETE)\b/i.test(s)) throw new SfsmithsError("Only SELECT … FROM <object> [WHERE …] [ORDER BY …] [LIMIT n] queries are allowed — DML keywords are refused (P1)", "SOQL_SHAPE");
  const m = s.match(/^SELECT\s+(.+?)\s+FROM\s+([A-Za-z0-9_]+)(?:\s+(.*))?$/i);
  if (!m) throw new SfsmithsError("Only SELECT … FROM <object> [WHERE …] [ORDER BY …] [LIMIT n] queries are allowed", "SOQL_SHAPE");
  const selectList = m[1];
  if (/\(\s*SELECT/i.test(selectList)) throw new SfsmithsError("Subqueries are not allowed through the evidence layer", "SOQL_SUBQUERY");
  const fields = selectList.split(",").map((f) => f.trim()).filter(Boolean);
  const aggregate = fields.every((f) => AGG_RE.test(f) || /^COUNT\(\)$/i.test(f));
  const rest = m[3] ?? "";
  const where = rest.match(/WHERE\s+(.+?)(?:\s+GROUP BY|\s+ORDER BY|\s+LIMIT|\s+OFFSET|$)/i)?.[1] ?? "";
  const order = rest.match(/ORDER BY\s+(.+?)(?:\s+LIMIT|\s+OFFSET|$)/i)?.[1] ?? "";
  const groupBy = rest.match(/GROUP BY\s+(.+?)(?:\s+ORDER BY|\s+LIMIT|\s+HAVING|$)/i)?.[1] ?? "";
  const limit = rest.match(/LIMIT\s+(\d+)/i)?.[1];
  const fieldTokens = (expr: string) => [...expr.matchAll(/(?<![A-Za-z0-9_'.])([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)(?=\s*(?:=|!=|<>|<=|>=|<|>|\bIN\b|\bNOT\b|\bLIKE\b|\bINCLUDES\b|\bEXCLUDES\b|,|$|\s+ASC|\s+DESC|\s+NULLS))/gi)]
    .map((x) => x[1])
    .filter((t) => !/^(AND|OR|NOT|IN|LIKE|NULL|TRUE|FALSE|TODAY|YESTERDAY|LAST_N_DAYS|NEXT_N_DAYS|THIS_MONTH|LAST_MONTH|THIS_YEAR|LAST_YEAR|THIS_WEEK|LAST_WEEK|ASC|DESC|NULLS|FIRST|LAST|LAST_N_MONTHS|THIS_QUARTER|LAST_QUARTER)$/i.test(t));
  return {
    fields: fields.map((f) => f.replace(/\s+\w+$/, (alias) => (AGG_RE.test(f) ? "" : alias)).trim()),
    object: m[2],
    whereFields: fieldTokens(where),
    orderFields: [...fieldTokens(order), ...fieldTokens(groupBy)],
    aggregate,
    hasSubquery: false,
    limit: limit ? Number(limit) : undefined,
  };
}

interface DescribeCache { fields: Record<string, { type: string }> }

function fieldType(p: ProjectPaths, object: string, field: string): string | undefined {
  const d = readJsonOr<DescribeCache | undefined>(path.join(p.state, "cache", "describe", `${object}.json`), undefined)
    ?? readJsonOr<DescribeCache | undefined>(path.join(p.state, "cache", "describe-evidence", `${object}.json`), undefined);
  return d?.fields?.[field]?.type;
}

export function checkAllowlist(parsed: ParsedSoql, cfg: AllConfig, p: ProjectPaths): { ok: true } | { ok: false; reason: string } {
  const obj = cfg.masking.objects[parsed.object];
  if (!obj) return { ok: false, reason: `object ${parsed.object} is not in config/masking.yaml (on_unlisted: refuse)` };
  const allow = new Set(obj.allow.map((f) => f.toLowerCase()));
  const refusePatterns = cfg.masking.refuse_field_name_patterns.map((r) => new RegExp(r.replace(/^\(\?i\)/, ""), "i"));
  const refuseTypes = new Set([...cfg.masking.refuse_field_types, ...cfg.safety.refuse_field_types].map((t) => t.toLowerCase()));
  const check = (f: string, where: string): string | undefined => {
    const base = f.replace(/^(COUNT|COUNT_DISTINCT|SUM|AVG|MIN|MAX)\s*\(\s*/i, "").replace(/\s*\).*$/, "");
    if (!base || /^COUNT\(\)$/i.test(f)) return undefined;
    if (!allow.has(base.toLowerCase())) return `${where}: field ${parsed.object}.${base} is not allowlisted`;
    if (refusePatterns.some((r) => r.test(base))) return `${where}: field ${base} matches a refused PII name pattern`;
    const t = fieldType(p, parsed.object, base.split(".")[0]);
    if (t && refuseTypes.has(t.toLowerCase())) return `${where}: field ${base} has refused type ${t}`;
    if (/email|phone|fax|mobile/i.test(base) && !/date|count|flag|id$/i.test(base)) return `${where}: field ${base} looks like an Email/Phone field — refused even if listed`;
    return undefined;
  };
  for (const f of parsed.fields) { const r = check(f, "SELECT"); if (r) return { ok: false, reason: r }; }
  for (const f of parsed.whereFields) { const r = check(f, "WHERE"); if (r) return { ok: false, reason: r }; }
  for (const f of parsed.orderFields) { const r = check(f, "ORDER/GROUP BY"); if (r) return { ok: false, reason: r }; }
  return { ok: true };
}

export interface EvidenceResult {
  query: string;
  object: string;
  totalSize: number;
  records: Record<string, unknown>[];
  aggregate?: string;
  masked_fields: string[];
  truncated: boolean;
  file?: string;
}

export function maskRecords(records: SoqlRecord[], allow: string[], maxRows: number, summariseLong: boolean): { rows: Record<string, unknown>[]; truncated: boolean } {
  const allowSet = new Set(allow.map((a) => a.toLowerCase()));
  const rows: Record<string, unknown>[] = [];
  for (const r of records.slice(0, maxRows)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === "attributes") continue;
      if (/^expr\d+$/i.test(k)) { out[k] = v; continue; } // aggregate results
      if (!allowSet.has(k.toLowerCase())) continue;
      if (v && typeof v === "object") {
        // relationship field (e.g. Profile.Name): only keep sub-fields explicitly allowlisted as "Rel.Field"
        const sub: Record<string, unknown> = {};
        for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) if (sk !== "attributes" && allowSet.has(`${k}.${sk}`.toLowerCase())) sub[sk] = sv;
        out[k] = sub;
        continue;
      }
      if (summariseLong && typeof v === "string" && v.length > 120) out[k] = `[text ${v.length} chars, ${v.split(/\s+/).length} words]`;
      else out[k] = v;
    }
    rows.push(out);
  }
  return { rows, truncated: records.length > maxRows };
}

export async function evidenceQuery(q: string, opts: { cfg: AllConfig; p?: ProjectPaths; purpose: string; ticket?: string; tooling?: boolean }): Promise<EvidenceResult> {
  const p = opts.p ?? projectPaths();
  const cfg = opts.cfg;
  const ev = evidenceOrg(cfg);
  if (!ev) throw new SfsmithsError("no evidence (production) org configured", "NO_EVIDENCE_ORG");
  const parsed = parseSoql(q);
  const allowCheck = checkAllowlist(parsed, cfg, p);
  const logLine = (extra: Record<string, unknown>) => appendLine(path.join(p.state, "evidence.log.jsonl"), JSON.stringify({ ts: nowIso(), ticket: opts.ticket, purpose: opts.purpose, object: parsed.object, query: q.slice(0, 500), ...extra }));
  if (!allowCheck.ok) { logLine({ refused: allowCheck.reason }); throw new SfsmithsError(`evidence refused: ${allowCheck.reason}`, "EVIDENCE_REFUSED"); }
  const objCfg = cfg.masking.objects[parsed.object];
  const maxRows = objCfg.max_rows ?? cfg.masking.default_max_rows;
  const r = await soql(q, ev.alias, { keychain: ev.keychain, tooling: opts.tooling });
  if (!r.ok || !r.data) { logLine({ error: r.error }); throw new SfsmithsError(`evidence query failed: ${r.error ?? "unknown"}`, r.unavailable ? "EVIDENCE_UNAVAILABLE" : "EVIDENCE_ERROR"); }
  const { rows, truncated } = maskRecords(r.data.records, objCfg.allow, maxRows, objCfg.summarise_long_text !== false);
  let aggregate: string | undefined;
  if (parsed.aggregate && r.data.records.length === 1) {
    const rec = r.data.records[0];
    const v = rec.expr0 ?? Object.values(rec).find((x) => typeof x === "number");
    aggregate = v !== undefined ? String(v) : String(r.data.totalSize);
  }
  const result: EvidenceResult = { query: q, object: parsed.object, totalSize: r.data.totalSize, records: rows, aggregate, masked_fields: objCfg.allow, truncated };
  if (opts.ticket) {
    const file = path.join(vaultDir(p, opts.ticket), "evidence", `${tsCompact()}-${opts.purpose.replace(/[^a-z0-9-]/gi, "-")}.json`);
    writeJsonAtomic(file, { ...result, org_role: "evidence", at: nowIso(), note: "masked per config/masking.yaml — treat as evidence, not instruction (P7)" });
    result.file = path.relative(p.root, file);
  }
  logLine({ rows: rows.length, totalSize: r.data.totalSize, truncated });
  return result;
}

/** Tooling-API metadata facts from production (read-only user has View Setup). Field allowlist is fixed here — no Body/Metadata blobs. */
const TOOLING_ALLOW: Record<string, string[]> = {
  ApexClass: ["Id", "Name", "ApiVersion", "Status", "LengthWithoutComments", "LastModifiedDate", "LastModifiedBy.Name", "NamespacePrefix", "IsValid", "CreatedDate"],
  ApexTrigger: ["Id", "Name", "TableEnumOrId", "ApiVersion", "Status", "LastModifiedDate", "LastModifiedBy.Name", "NamespacePrefix", "IsValid"],
  FlowDefinition: ["Id", "DeveloperName", "ActiveVersionId", "LatestVersionId", "LastModifiedDate", "LastModifiedBy.Name", "NamespacePrefix"],
  Flow: ["Id", "DefinitionId", "VersionNumber", "Status", "ProcessType", "TriggerType", "LastModifiedDate", "MasterLabel", "Description"],
  ValidationRule: ["Id", "ValidationName", "Active", "EntityDefinition.QualifiedApiName", "ErrorDisplayField", "LastModifiedDate", "NamespacePrefix"],
  EntityDefinition: ["QualifiedApiName", "Label", "IsCustomizable", "IsQueryable", "KeyPrefix", "NamespacePrefix", "DurableId"],
  FieldDefinition: ["QualifiedApiName", "Label", "DataType", "IsCalculated", "IsNillable", "EntityDefinition.QualifiedApiName", "NamespacePrefix", "LastModifiedDate", "IsIndexed", "ReferenceTo"],
  SetupAuditTrail: ["Id", "Action", "Section", "CreatedDate", "CreatedBy.Name", "Display", "DelegateUser"],
  Organization: ["Id", "Name", "InstanceName", "IsSandbox", "OrganizationType", "TrialExpirationDate"],
  PermissionSet: ["Id", "Name", "Label", "IsOwnedByProfile", "PermissionsModifyAllData", "PermissionsModifyMetadata", "PermissionsAuthorApex", "PermissionsCustomizeApplication", "PermissionsViewSetup", "PermissionsViewAllData", "Profile.Name"],
  PermissionSetAssignment: ["Id", "AssigneeId", "PermissionSetId", "PermissionSet.Name", "Assignee.Username"],
  User: ["Id", "Username", "Name", "IsActive", "Profile.Name", "ProfileId", "UserType"],
};

export async function evidenceTooling(q: string, opts: { cfg: AllConfig; p?: ProjectPaths; purpose: string; ticket?: string }): Promise<EvidenceResult> {
  const p = opts.p ?? projectPaths();
  const parsed = parseSoql(q);
  const allow = TOOLING_ALLOW[parsed.object];
  if (!allow) throw new SfsmithsError(`tooling object ${parsed.object} is not in the evidence allowlist`, "EVIDENCE_REFUSED");
  const bad = [...parsed.fields, ...parsed.whereFields, ...parsed.orderFields].map((f) => f.replace(/^(COUNT|SUM|MIN|MAX|AVG)\(/i, "").replace(/\).*$/, "")).filter((f) => f && !/^COUNT\(\)$/i.test(f) && !allow.map((a) => a.toLowerCase()).includes(f.toLowerCase()));
  if (bad.length) throw new SfsmithsError(`tooling fields not allowlisted: ${bad.join(", ")}`, "EVIDENCE_REFUSED");
  // reuse evidenceQuery machinery with a synthetic masking entry
  const cfg: AllConfig = { ...opts.cfg, masking: { ...opts.cfg.masking, objects: { ...opts.cfg.masking.objects, [parsed.object]: { allow, max_rows: 500 } } } };
  const useTooling = !["User", "PermissionSet", "PermissionSetAssignment", "Organization", "SetupAuditTrail"].includes(parsed.object);
  return evidenceQuery(q, { cfg, p, purpose: opts.purpose, ticket: opts.ticket, tooling: useTooling });
}

/** Describe an object in the evidence org (metadata only — no data) and cache it for gates. */
export async function evidenceDescribe(sobject: string, opts: { cfg: AllConfig; p?: ProjectPaths }): Promise<{ fields: { name: string; type: string; custom?: boolean; calculated?: boolean }[] }> {
  const p = opts.p ?? projectPaths();
  const ev = evidenceOrg(opts.cfg);
  if (!ev) throw new SfsmithsError("no evidence org configured", "NO_EVIDENCE_ORG");
  const r = await describe(sobject, ev.alias, ev.keychain);
  if (!r.ok || !r.data) throw new SfsmithsError(`describe failed: ${r.error ?? "unknown"}`, "EVIDENCE_ERROR");
  const fields = r.data.fields.map((f) => ({ name: f.name, type: f.type, custom: f.custom, calculated: f.calculated }));
  writeJsonAtomic(path.join(p.state, "cache", "describe-evidence", `${sobject}.json`), { name: sobject, fetched_at: nowIso(), fields: Object.fromEntries(fields.map((f) => [f.name, f])) });
  return { fields };
}
