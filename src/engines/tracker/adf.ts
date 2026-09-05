/**
 * adf.ts — Atlassian Document Format → plain text (Jira Cloud v3 returns ADF for description/comments).
 * Deterministic, loses formatting on purpose: the text is EVIDENCE for agents (P7), not markup.
 */
export interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export function adfToText(node: AdfNode | string | null | undefined): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  const out: string[] = [];
  walk(node, out, 0);
  return out
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function walk(n: AdfNode, out: string[], depth: number): void {
  const t = n.type ?? "";
  const children = () => (n.content ?? []).forEach((c) => walk(c, out, depth + 1));
  switch (t) {
    case "text":
      out.push(n.text ?? "");
      if (n.marks?.some((m) => m.type === "link")) {
        const href = n.marks.find((m) => m.type === "link")?.attrs?.href;
        if (href && href !== n.text) out.push(` (${String(href)})`);
      }
      return;
    case "hardBreak":
      out.push("\n");
      return;
    case "paragraph":
      children();
      out.push("\n\n");
      return;
    case "heading": {
      const lvl = Number(n.attrs?.level ?? 1);
      out.push("#".repeat(Math.min(6, Math.max(1, lvl))) + " ");
      children();
      out.push("\n\n");
      return;
    }
    case "bulletList":
    case "orderedList": {
      (n.content ?? []).forEach((li, i) => {
        out.push(t === "orderedList" ? `${i + 1}. ` : "- ");
        const before = out.length;
        walk(li, out, depth + 1);
        // list items end with paragraph newlines; collapse to single newline
        const joined = out.splice(before).join("").replace(/\n+$/g, "");
        out.push(joined + "\n");
      });
      out.push("\n");
      return;
    }
    case "listItem":
      children();
      return;
    case "codeBlock":
      out.push("```\n");
      children();
      out.push("\n```\n\n");
      return;
    case "blockquote":
      out.push("> ");
      children();
      return;
    case "rule":
      out.push("\n---\n");
      return;
    case "mention":
      out.push(String(n.attrs?.text ?? "@user"));
      return;
    case "emoji":
      out.push(String(n.attrs?.text ?? n.attrs?.shortName ?? ""));
      return;
    case "inlineCard":
    case "blockCard":
    case "embedCard":
      out.push(String(n.attrs?.url ?? ""));
      return;
    case "mediaSingle":
    case "mediaGroup":
    case "media":
      out.push(`[attachment: ${String(n.attrs?.alt ?? n.attrs?.id ?? "media")}]`);
      if (n.content) children();
      return;
    case "table":
      (n.content ?? []).forEach((row) => {
        const cells = (row.content ?? []).map((cell) => {
          const tmp: string[] = [];
          walk(cell, tmp, depth + 2);
          return tmp.join("").replace(/\s+/g, " ").trim();
        });
        out.push("| " + cells.join(" | ") + " |\n");
      });
      out.push("\n");
      return;
    case "tableRow":
    case "tableCell":
    case "tableHeader":
      children();
      return;
    case "panel":
    case "expand":
    case "nestedExpand":
      if (n.attrs?.title) out.push(`${String(n.attrs.title)}: `);
      children();
      return;
    case "status":
      out.push(`[${String(n.attrs?.text ?? "status")}]`);
      return;
    case "date":
      out.push(n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : "[date]");
      return;
    default:
      children();
  }
}
