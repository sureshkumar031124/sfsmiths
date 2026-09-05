/**
 * Tracker adapters are READ-ONLY by construction: there is no write method in this interface.
 * Comms drafts are files for the human to paste (P — "Comms drafts never posted").
 */
export interface TicketComment {
  id: string;
  author?: string;
  created: string;
  body: string; // plain text (ADF flattened)
}

export interface TicketAttachment {
  id: string;
  filename: string;
  mimeType?: string;
  size?: number;
  created?: string;
  url?: string; // never fetched automatically by agents
}

export interface TicketSnapshot {
  key: string;
  tracker: "jira" | "file";
  fetched_at: string;
  title: string;
  description: string;         // plain text
  status?: string;
  priority?: string;
  issue_type?: string;
  labels: string[];
  components: string[];
  reporter?: string;
  assignee?: string;
  created?: string;
  updated?: string;
  acceptance_criteria?: string; // if a dedicated field/section exists
  comments: TicketComment[];
  attachments: TicketAttachment[];
  links: { type: string; key: string; title?: string }[];
  parent?: string;
  epic?: string;
  raw_hash: string;             // hash of the normalised content → cheap change detection
  source_url?: string;
}

export interface SearchHit {
  key: string;
  title: string;
  status?: string;
  updated?: string;
  resolution?: string;
  components: string[];
  labels: string[];
  score?: number;
}

export interface TrackerAdapter {
  readonly name: "jira" | "file";
  fetch(key: string): Promise<TicketSnapshot>;
  search(jql: string, max?: number): Promise<SearchHit[]>;
  /** cheap: only enough to compute raw_hash for change detection */
  probe(key: string): Promise<{ raw_hash: string; updated?: string }>;
}
