/**
 * schema.ts — JSON-schema validation (Ajv) shared by config loading and contract-check.
 * Schemas are plain JSON files under schemas/ so agents and humans can read them too.
 */
import fs from "node:fs";
import path from "node:path";
import Ajv2020Mod, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsMod from "ajv-formats";

// ajv ships CJS; under NodeNext ESM interop the default export may be nested.
const Ajv2020 = ((Ajv2020Mod as unknown as { default?: unknown }).default ?? Ajv2020Mod) as unknown as new (o: Record<string, unknown>) => import("ajv/dist/2020.js").default;
const addFormats = ((addFormatsMod as unknown as { default?: unknown }).default ?? addFormatsMod) as unknown as (a: unknown) => void;
import { projectPaths, packageRoot } from "./paths.js";
import { exists } from "./util.js";

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);

const compiled = new Map<string, ValidateFunction>();

export function loadSchema(schemaFile: string): ValidateFunction {
  const abs = path.resolve(schemaFile);
  const hit = compiled.get(abs);
  if (hit) return hit;
  const schema = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
  // the same schema (same $id) can be loaded from several paths (project copy vs package copy vs tests) — Ajv keys
  // schemas by $id, so drop a previously registered one before compiling again
  if (typeof schema.$id === "string" && ajv.getSchema(schema.$id)) ajv.removeSchema(schema.$id);
  const v = ajv.compile(schema);
  compiled.set(abs, v);
  return v;
}

/** Returns [] when valid, else human-readable error strings. */
export function validateAgainst(schemaFile: string, data: unknown): string[] {
  const v = loadSchema(schemaFile);
  const ok = v(data);
  if (ok) return [];
  return (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}${e.params && "allowedValues" in e.params ? ` (${(e.params as { allowedValues: unknown[] }).allowedValues.join(", ")})` : ""}`);
}

/** Resolve a named artifact/contract schema: project schemas/ first, then package. */
export function resolveSchema(name: string): string {
  const file = name.endsWith(".schema.json") ? name : `${name}.schema.json`;
  const candidates = [
    path.join(projectPaths().schemas, file),
    path.join(projectPaths().schemas, "contracts", file),
    path.join(packageRoot(), "schemas", file),
    path.join(packageRoot(), "schemas", "contracts", file),
  ];
  const found = candidates.find((c) => exists(c));
  if (!found) throw new Error(`Schema not found: ${name} (looked in ${candidates.join(", ")})`);
  return found;
}

export function validateNamed(name: string, data: unknown): string[] {
  return validateAgainst(resolveSchema(name), data);
}
