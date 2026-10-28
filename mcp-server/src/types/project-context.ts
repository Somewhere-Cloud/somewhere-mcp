/** The labelled context attached to project_get. Note bodies stay in
 *  project_context so every project_get stays small. */
export type DeliveredProjectContext =
  | {
    source: string;
    trust: 'untrusted_project_data';
    instructions: string | null;
    design_principles: string | null;
    note_topics: string[];
    /** Who last saved each entry (platform user id) and when. */
    attribution: { kind: string; topic: string; updated_by: string | null; updated_at: string | null }[];
    updated_at: string | null;
  }
  | { source: string; unavailable: string };
