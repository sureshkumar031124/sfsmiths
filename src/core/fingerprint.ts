/**
 * fingerprint.ts — content fingerprints for metadata components.
 *
 * Used by baseline sync (3-way classification) and by gates (artifact_hash: a gate result is
 * void if the checked file changed afterwards).
 */
import fs from "node:fs";
import path from "node:path";
import { sha256, walkFiles } from "./util.js";

/** Normalise metadata text so cosmetic differences don't count as drift. */
export function normalizeMetadata(text: string, filename: string): string {
  let t = text.replace(/\r\n/g, "\n");
  if (filename.endsWith(".xml") || filename.includes("-meta.xml")) {
    t = t
      .replace(/<\?xml[^>]*\?>/g, "")
      .replace(/>\s+</g, "><")
      .replace(/\s+xmlns(:\w+)?="[^"]*"/g, "")
      .trim();
  } else {
    // Apex / JS / CSS: trim trailing whitespace per line, drop empty lines at edges
    t = t
      .split("\n")
      .map((l) => l.replace(/\s+$/g, ""))
      .join("\n")
      .trim();
  }
  return t;
}

export function fileFingerprint(file: string): string {
  const text = fs.readFileSync(file, "utf8");
  return sha256(normalizeMetadata(text, path.basename(file)));
}

/**
 * Component fingerprint = hash over all files of the component (a bundle may have several).
 * `files` are relative paths inside `root`.
 */
export function componentFingerprint(root: string, files: string[]): string {
  const parts = [...files].sort().map((f) => `${f}\n${fileFingerprint(path.join(root, f))}`);
  return sha256(parts.join("\n"));
}

/** Fingerprint a whole directory tree (sorted, normalised). */
export function treeFingerprint(root: string): { hash: string; files: number } {
  const files = walkFiles(root);
  const h = componentFingerprint(root, files);
  return { hash: h, files: files.length };
}

/** Map a source-format file path to a Salesforce component key "Type:Name". */
export function componentKeyFromPath(rel: string): string | undefined {
  const p = rel.replace(/\\/g, "/");
  const m = p.match(/\/(classes|triggers|flows|objects|layouts|permissionsets|profiles|lwc|aura|pages|components|staticresources|labels|customMetadata|globalValueSets|flexipages|quickActions|tabs|applications|approvalProcesses|workflows|sharingRules|reportTypes|reports|dashboards|emailTemplates|assignmentRules|autoResponseRules|escalationRules|queues|groups|roles|settings|namedCredentials|remoteSiteSettings|connectedApps|platformEventChannels|duplicateRules|matchingRules|validationRules)\/([^/]+)/);
  if (!m) return undefined;
  const dir = m[1];
  const rest = p.slice(p.indexOf(`/${dir}/`) + dir.length + 2);
  const typeMap: Record<string, string> = {
    classes: "ApexClass", triggers: "ApexTrigger", flows: "Flow", objects: "CustomObject", layouts: "Layout",
    permissionsets: "PermissionSet", profiles: "Profile", lwc: "LightningComponentBundle", aura: "AuraDefinitionBundle",
    pages: "ApexPage", components: "ApexComponent", staticresources: "StaticResource", labels: "CustomLabels",
    customMetadata: "CustomMetadata", globalValueSets: "GlobalValueSet", flexipages: "FlexiPage", quickActions: "QuickAction",
    tabs: "CustomTab", applications: "CustomApplication", approvalProcesses: "ApprovalProcess", workflows: "Workflow",
    sharingRules: "SharingRules", reportTypes: "ReportType", reports: "Report", dashboards: "Dashboard", emailTemplates: "EmailTemplate",
    assignmentRules: "AssignmentRules", autoResponseRules: "AutoResponseRules", escalationRules: "EscalationRules", queues: "Queue",
    groups: "Group", roles: "Role", settings: "Settings", namedCredentials: "NamedCredential", remoteSiteSettings: "RemoteSiteSetting",
    connectedApps: "ConnectedApp", platformEventChannels: "PlatformEventChannel", duplicateRules: "DuplicateRule", matchingRules: "MatchingRules",
  };
  const type = typeMap[dir];
  if (!type) return undefined;
  if (dir === "objects") {
    // objects/Case/fields/Foo__c.field-meta.xml → CustomField:Case.Foo__c ; objects/Case/Case.object-meta.xml → CustomObject:Case
    const seg = rest.split("/");
    const obj = seg[0];
    if (seg[1] === "fields" && seg[2]) return `CustomField:${obj}.${seg[2].replace(/\.field-meta\.xml$/, "")}`;
    if (seg[1] === "validationRules" && seg[2]) return `ValidationRule:${obj}.${seg[2].replace(/\.validationRule-meta\.xml$/, "")}`;
    if (seg[1] === "recordTypes" && seg[2]) return `RecordType:${obj}.${seg[2].replace(/\.recordType-meta\.xml$/, "")}`;
    if (seg[1] === "listViews" && seg[2]) return `ListView:${obj}.${seg[2].replace(/\.listView-meta\.xml$/, "")}`;
    if (seg[1] === "compactLayouts" && seg[2]) return `CompactLayout:${obj}.${seg[2].replace(/\.compactLayout-meta\.xml$/, "")}`;
    if (seg[1] === "webLinks" && seg[2]) return `WebLink:${obj}.${seg[2].replace(/\.webLink-meta\.xml$/, "")}`;
    if (seg[1] === "fieldSets" && seg[2]) return `FieldSet:${obj}.${seg[2].replace(/\.fieldSet-meta\.xml$/, "")}`;
    return `CustomObject:${obj}`;
  }
  if (dir === "lwc" || dir === "aura") return `${type}:${rest.split("/")[0]}`;
  const name = rest
    .split("/")[0]
    .replace(/\.(cls|trigger|page|component|resource)(-meta\.xml)?$/, "")
    .replace(/\.[a-zA-Z]+-meta\.xml$/, "")
    .replace(/-meta\.xml$/, "");
  return `${type}:${name}`;
}

/** Group a source tree into components: key → relative files. */
export function groupComponents(root: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of walkFiles(root)) {
    const key = componentKeyFromPath(f);
    if (!key) continue;
    (out[key] ??= []).push(f);
  }
  return out;
}
