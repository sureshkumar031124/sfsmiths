/**
 * mcp/evidence-server.ts — `sfsmiths-mcp-evidence`: the ONLY road from an agent to production data.
 *
 * Stdio MCP server (registered in .mcp.json by `sfsmiths-human sync`). Every tool goes through the evidence
 * engine, which: uses the evidence org's read-only user (agent keychain), parses the SOQL, enforces the
 * per-object field allowlist in config/masking.yaml (refuses Email/Phone/PII field types), caps rows,
 * masks values, logs every call to .sfsmiths/evidence.log.jsonl and copies the masked rows into the ticket vault.
 * There is deliberately NO write tool, NO anonymous Apex and NO metadata deploy here.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "../core/config.js";
import { projectPaths, sanitizeTicket } from "../core/paths.js";
import { evidenceDescribe, evidenceQuery, evidenceTooling } from "../engines/evidence/query.js";

const p = projectPaths();

function text(obj: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

function errorText(e: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  const err = e as Error & { code?: string };
  return { content: [{ type: "text", text: `EVIDENCE REFUSED/FAILED${err.code ? ` [${err.code}]` : ""}: ${err.message}\nIf you need a field that is not allowlisted, say so in your escalation — do not work around it.` }], isError: true };
}

const ticketArg = z.string().regex(/^[A-Z][A-Z0-9_]{0,15}-\d{1,8}$/, "ticket key like PROJ-123").optional().describe("Ticket key — the masked rows are copied into work/<KEY>/evidence/");
const purposeArg = z.string().min(8).max(300).describe("Why you need this data (logged with the query; ≥ 8 chars)");

export async function main(): Promise<void> {
  const server = new McpServer({ name: "sfsmiths-evidence", version: "0.2.0" }, {
    instructions: "Masked, read-only production evidence. SELECT-only SOQL against allowlisted objects/fields (config/masking.yaml). Rows are capped and masked; every call is logged. Never ask this server to write, and never paste raw record values into comms — cite the evidence file instead (source: L3).",
  });

  server.registerTool("prod_soql", {
    title: "Production SOQL (masked, read-only)",
    description: "Run a SELECT-only SOQL query against the evidence (production) org through the read-only user. Only allowlisted objects and fields are returned; Email/Phone/PII field types are refused; rows are capped and masked. Use for: reproducing a bug with real shapes, confirming a record state, row counts.",
    inputSchema: { query: z.string().min(10).max(4000).describe("SELECT … FROM <Object> [WHERE …] [LIMIT n]"), purpose: purposeArg, ticket: ticketArg },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ query, purpose, ticket }) => {
    try {
      const cfg = loadConfig(p, { fresh: true });
      const r = await evidenceQuery(query, { cfg, p, purpose, ticket: ticket ? sanitizeTicket(ticket) : undefined });
      return text({ source: "L3", object: r.object, totalSize: r.totalSize, returned: r.records.length, truncated: r.truncated, masked_fields: r.masked_fields, aggregate: r.aggregate, evidence_file: r.file, records: r.records });
    } catch (e) { return errorText(e); }
  });

  server.registerTool("prod_row_count", {
    title: "Production row count",
    description: "COUNT() of records matching an optional WHERE clause on an allowlisted object. Cheapest way to confirm 'does this ever happen in production'.",
    inputSchema: { object: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,80}$/), where: z.string().max(2000).optional(), purpose: purposeArg, ticket: ticketArg },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ object, where, purpose, ticket }) => {
    try {
      const cfg = loadConfig(p, { fresh: true });
      const r = await evidenceQuery(`SELECT COUNT() FROM ${object}${where ? ` WHERE ${where}` : ""}`, { cfg, p, purpose: `count: ${purpose}`, ticket: ticket ? sanitizeTicket(ticket) : undefined });
      return text({ source: "L3", object, where: where ?? null, count: r.totalSize, evidence_file: r.file });
    } catch (e) { return errorText(e); }
  });

  server.registerTool("prod_tooling", {
    title: "Production Tooling API query (metadata facts)",
    description: "SELECT-only Tooling API query for metadata facts in production (ApexClass, ApexTrigger, Flow/FlowDefinition, ValidationRule, CustomField, EntityDefinition, MetadataComponentDependency, ApexCodeCoverageAggregate, …). Returns names, dates, versions, status — never record data. Use to check 'what is really deployed in prod' and 'when did it last change'.",
    inputSchema: { query: z.string().min(10).max(4000), purpose: purposeArg, ticket: ticketArg },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ query, purpose, ticket }) => {
    try {
      const cfg = loadConfig(p, { fresh: true });
      const r = await evidenceTooling(query, { cfg, p, purpose, ticket: ticket ? sanitizeTicket(ticket) : undefined });
      return text({ source: "L3", object: r.object, totalSize: r.totalSize, returned: r.records.length, truncated: r.truncated, evidence_file: r.file, records: r.records });
    } catch (e) { return errorText(e); }
  });

  server.registerTool("prod_describe", {
    title: "Production object describe (field list)",
    description: "Field names and types of an object as they exist in PRODUCTION (name, type, custom, calculated). No data. Use before planning: it is the ground truth for 'does this field exist and what type is it'.",
    inputSchema: { object: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,80}$/) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ object }) => {
    try {
      const cfg = loadConfig(p, { fresh: true });
      const r = await evidenceDescribe(object, { cfg, p });
      return text({ source: "L3", object, field_count: r.fields.length, fields: r.fields });
    } catch (e) { return errorText(e); }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => { process.stderr.write(`sfsmiths-mcp-evidence failed: ${(e as Error).message}\n`); process.exit(1); });
