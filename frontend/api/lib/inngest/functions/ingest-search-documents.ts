import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import { indexSearchDocuments, type SearchDoc } from "../../search-index.js";

/**
 * Populate the unified `search_documents` index so Joe can search across
 * resumes, notes, and AI call notes (messages have their own backfill and
 * can be added here later).
 *
 * Incremental + idempotent: for each source_kind we load the set of
 * already-indexed source ids (and their source_updated_at), then scan the
 * source table oldest-first and collect rows that are either not yet
 * indexed or whose source row is newer than what we indexed. Upsert is
 * keyed on (source_kind, source_id), so re-runs never duplicate. Each run
 * is bounded so a Vercel/Inngest step never times out; successive cron
 * runs drain the backlog.
 *
 * Runs every 15 min, and on demand via the `search/ingest.requested`
 * event.
 */

const PER_KIND_BATCH = 100; // rows (re)indexed per kind per run
const SCAN_PAGE = 500;
const MAX_SCAN_PAGES = 60; // up to 30k rows scanned per kind per run

type IndexedMap = Map<string, string | null>; // source_id -> source_updated_at

async function loadIndexed(supabase: any, kind: string): Promise<IndexedMap> {
  const map: IndexedMap = new Map();
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await supabase
      .from("search_documents")
      .select("source_id, source_updated_at")
      .eq("source_kind", kind)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`load indexed ${kind}: ${error.message}`);
    if (!data?.length) break;
    for (const r of data as any[]) map.set(r.source_id, r.source_updated_at);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return map;
}

/** True when a source row needs (re)indexing given what's already indexed. */
function needsIndex(indexed: IndexedMap, id: string, sourceUpdatedAt: string | null): boolean {
  if (!indexed.has(id)) return true;
  const prev = indexed.get(id) || null;
  if (sourceUpdatedAt && prev && new Date(prev) < new Date(sourceUpdatedAt)) return true;
  return false;
}

/** Generic oldest-first scan that collects up to PER_KIND_BATCH source
 *  rows needing indexing, then maps them to SearchDocs via `toDoc`. */
async function collect(
  supabase: any,
  kind: string,
  table: string,
  columns: string,
  toDoc: (row: any) => SearchDoc | null,
): Promise<SearchDoc[]> {
  const indexed = await loadIndexed(supabase, kind);
  const out: SearchDoc[] = [];
  let from = 0;
  for (let page = 0; page < MAX_SCAN_PAGES && out.length < PER_KIND_BATCH; page++) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order("created_at", { ascending: true })
      .range(from, from + SCAN_PAGE - 1);
    if (error) throw new Error(`scan ${table}: ${error.message}`);
    if (!data?.length) break;
    for (const row of data as any[]) {
      const doc = toDoc(row);
      if (!doc) continue;
      if (needsIndex(indexed, doc.source_id, doc.source_updated_at ?? null)) {
        out.push(doc);
        if (out.length >= PER_KIND_BATCH) break;
      }
    }
    if (data.length < SCAN_PAGE) break;
    from += SCAN_PAGE;
  }
  return out;
}

async function runIngest({ logger }: { logger: any }) {
    const supabase = getSupabaseAdmin();
    const results: Record<string, number> = {};

    // ── Resumes ──────────────────────────────────────────────────────
    {
      const docs = await collect(
        supabase,
        "resume",
        "resumes",
        "id, candidate_id, file_name, raw_text, parsed_json, created_at, updated_at",
        (r) => {
          const body =
            (r.raw_text && r.raw_text.trim())
            || (r.parsed_json ? JSON.stringify(r.parsed_json) : "");
          if (!body) return null;
          return {
            source_kind: "resume",
            source_id: r.id,
            title: r.file_name || "Resume",
            subtitle: "Resume",
            body,
            candidate_id: r.candidate_id || null,
            person_id: r.candidate_id || null,
            role_context: "candidate",
            source_updated_at: r.updated_at || r.created_at || null,
          };
        },
      );
      results.resume = await indexSearchDocuments(supabase, docs);
    }

    // ── Notes (entity_type tells us candidate/contact/company) ───────
    {
      const docs = await collect(
        supabase,
        "note",
        "notes",
        "id, entity_id, entity_type, note, note_source, created_at",
        (r) => {
          if (!r.note || !r.entity_id) return null;
          const et = String(r.entity_type || "").toLowerCase();
          return {
            source_kind: "note",
            source_id: r.id,
            title: r.note_source ? `Note (${r.note_source})` : "Note",
            subtitle: null,
            body: r.note,
            person_id: et === "candidate" || et === "contact" ? r.entity_id : null,
            candidate_id: et === "candidate" ? r.entity_id : null,
            contact_id: et === "contact" ? r.entity_id : null,
            company_id: et === "company" ? r.entity_id : null,
            role_context: et || null,
            source_updated_at: r.created_at || null,
          };
        },
      );
      results.note = await indexSearchDocuments(supabase, docs);
    }

    // ── AI call notes ────────────────────────────────────────────────
    {
      const docs = await collect(
        supabase,
        "call_note",
        "ai_call_notes",
        "id, candidate_id, contact_id, ai_summary, extracted_notes, transcript, ai_action_items, call_started_at, created_at",
        (r) => {
          const body = [r.ai_summary, r.extracted_notes, r.transcript]
            .filter(Boolean)
            .join("\n\n");
          if (!body.trim()) return null;
          const personId = r.candidate_id || r.contact_id || null;
          return {
            source_kind: "call_note",
            source_id: r.id,
            title: "Call note",
            subtitle: r.ai_summary ? String(r.ai_summary).slice(0, 200) : null,
            body,
            person_id: personId,
            candidate_id: r.candidate_id || null,
            contact_id: r.contact_id || null,
            role_context: r.candidate_id ? "candidate" : r.contact_id ? "contact" : null,
            source_updated_at: r.call_started_at || r.created_at || null,
          };
        },
      );
      results.call_note = await indexSearchDocuments(supabase, docs);
    }

    logger.info("search_documents ingest complete", results);
    return results;
}

export const ingestSearchDocuments = inngest.createFunction(
  { id: "ingest-search-documents", name: "Ingest resumes/notes/calls → search_documents" },
  { cron: "*/15 * * * *" },
  runIngest,
);

export const ingestSearchDocumentsOnce = inngest.createFunction(
  { id: "ingest-search-documents-once", name: "Ingest search_documents (on demand)" },
  { event: "search/ingest.requested" },
  runIngest,
);
