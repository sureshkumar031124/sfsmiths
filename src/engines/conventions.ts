/**
 * conventions.ts — turn the reviewed docs/org-map/CONVENTIONS.md into agent-facing standards skills.
 * Generic defaults ship as .claude/skills/std-*; this writes the company-specific overlay skills
 * (.claude/skills/<prefix>-comment-conventions, <prefix>-naming-rules) that agents list in `skills:`.
 */
import path from "node:path";
import { projectPaths, type ProjectPaths } from "../core/paths.js";
import { ensureDir, exists, nowIso, readText, writeTextAtomic } from "../core/util.js";

export function conventionsBuild(opts: { prefix?: string; p?: ProjectPaths } = {}): { written: string[]; warnings: string[] } {
  const p = opts.p ?? projectPaths();
  const prefix = (opts.prefix ?? "org").toLowerCase().replace(/[^a-z0-9]/g, "");
  const src = path.join(p.docs, "org-map", "CONVENTIONS.md");
  const warnings: string[] = [];
  if (!exists(src)) return { written: [], warnings: [`${path.relative(p.root, src)} not found — run \`sfsmiths-human orgmap build\` first, review it, then build`] };
  const text = readText(src);
  if (/DRAFT — review once/.test(text) && !/## Your decisions \(edit here\)[\s\S]*- header format:\s*\S/.test(text)) warnings.push("CONVENTIONS.md still looks like the unreviewed draft — fill in the 'Your decisions' section");
  const section = (title: string) => { const m = text.match(new RegExp(`## ${title}[^\n]*\n([\\s\\S]*?)(?=\n## |$)`)); return m ? m[1].trim() : ""; };
  const written: string[] = [];
  const cc = path.join(p.skills, `${prefix}-comment-conventions`);
  ensureDir(cc);
  writeTextAtomic(path.join(cc, "SKILL.md"), `---
name: ${prefix}-comment-conventions
description: THIS org's comment conventions (generated ${nowIso().slice(0, 10)} from docs/org-map/CONVENTIONS.md — regenerate with sfsmiths-human conventions build). Use when writing or editing Apex, triggers, flows, fields or LWC in this repo.
---

# Comment conventions for this org

Match the EXISTING style exactly — the comment-lint gate checks: header doc block, doc comment on every public/global method, a modification-log line containing the ticket key, and a <description> on every flow/field/validation rule/permission set.

## Header (observed)
${section("Apex header comment") || "_not sampled — use ApexDoc: /** @description … @author … @date … */_"}

## Method documentation
${section("Method documentation")}

## Modification log
${section("Modification log")}

## Decisions
${section("Your decisions \\(edit here\\)") || "_none recorded yet_"}
`);
  written.push(path.relative(p.root, path.join(cc, "SKILL.md")));
  const nr = path.join(p.skills, `${prefix}-naming-rules`);
  ensureDir(nr);
  writeTextAtomic(path.join(nr, "SKILL.md"), `---
name: ${prefix}-naming-rules
description: THIS org's naming patterns (generated ${nowIso().slice(0, 10)} from docs/org-map/CONVENTIONS.md). Use when creating any component, field, flow, test class or test record.
---

# Naming rules for this org

Names say what a thing DOES. The ticket key never goes in a name — it goes in the tag field (config/safety.yaml test_tag_field). naming-lint enforces config/naming.yaml.

## Class suffixes observed
${section("Naming patterns \\(class suffixes observed\\)")}

## Flow naming (recent)
${section("Flow naming \\(recent\\)")}

## Field descriptions
${section("Field descriptions")}

## Decisions
${section("Your decisions \\(edit here\\)") || "_none recorded yet_"}
`);
  written.push(path.relative(p.root, path.join(nr, "SKILL.md")));
  return { written, warnings };
}
