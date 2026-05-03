import type { QueryClient } from '@tanstack/react-query';

/**
 * Centralised cache-invalidation helpers.
 *
 * Anywhere a mutation touches a person / send-out / job / message / note,
 * call the matching helper instead of manually listing query keys. Each
 * helper is a *superset* — it invalidates every surface that could render
 * the changed data, even if the immediate caller only cares about one. The
 * cost is cheap (react-query just refetches the active queries) and avoids
 * the "I added a thing and the success toast fires but nothing shows up"
 * class of bug.
 *
 * Add a key here whenever you introduce a new useQuery somewhere in the app.
 */

const PEOPLE_KEYS = [
  'people', 'candidates', 'contacts',
  'candidate', 'contact',
  'candidate_send_outs', 'contact_send_outs', 'contact_jobs',
  'candidate_documents', 'candidate_education', 'candidate_work_history',
  'companies_autocomplete', 'companies_for_add_candidate',
];

const SEND_OUT_KEYS = [
  'send_outs_list', 'send_out_board', 'send_outs_job',
  'candidate_send_outs', 'contact_send_outs',
];

const JOB_VIEW_KEYS = [
  'job', 'jobs',
  'job_pipeline_kanban', 'job_funnel', 'job_quick_stats', 'job_activity',
  'candidate_jobs_funnel',
];

const COMMS_KEYS = [
  'inbox_threads', 'inbox_thread', 'messages',
  'conversations', 'contact_conversations',
];

const NOTES_KEYS = ['notes', 'job_notes'];

const TASKS_KEYS = ['entity_tasks', 'tasks', 'sidebar_tasks_due'];

const DASHBOARD_KEYS = ['dashboard_metrics'];

const COMPANY_KEYS = ['companies', 'company'];

function bulk(qc: QueryClient, keys: string[]) {
  for (const k of keys) qc.invalidateQueries({ queryKey: [k] });
}

export function invalidatePersonScope(qc: QueryClient) {
  bulk(qc, PEOPLE_KEYS);
  bulk(qc, DASHBOARD_KEYS);
}

export function invalidateSendOutScope(qc: QueryClient) {
  bulk(qc, SEND_OUT_KEYS);
  bulk(qc, JOB_VIEW_KEYS);
  bulk(qc, PEOPLE_KEYS);
  bulk(qc, DASHBOARD_KEYS);
}

export function invalidateJobScope(qc: QueryClient) {
  bulk(qc, JOB_VIEW_KEYS);
  bulk(qc, SEND_OUT_KEYS);
  bulk(qc, PEOPLE_KEYS);
  bulk(qc, DASHBOARD_KEYS);
}

export function invalidateCommsScope(qc: QueryClient) {
  bulk(qc, COMMS_KEYS);
  bulk(qc, ['sidebar_inbox_unread']);
}

export function invalidateNoteScope(qc: QueryClient) {
  bulk(qc, NOTES_KEYS);
  bulk(qc, JOB_VIEW_KEYS); // job_activity feed pulls notes
}

export function invalidateTaskScope(qc: QueryClient) {
  bulk(qc, TASKS_KEYS);
}

export function invalidateCompanyScope(qc: QueryClient) {
  bulk(qc, COMPANY_KEYS);
  bulk(qc, JOB_VIEW_KEYS);
}

/** Mutation that touches everything (e.g. stage moves with a side effect on
 *  the person row + a send-out + the funnel). Use sparingly. */
export function invalidateAll(qc: QueryClient) {
  invalidatePersonScope(qc);
  invalidateSendOutScope(qc);
  invalidateJobScope(qc);
  invalidateCommsScope(qc);
  invalidateNoteScope(qc);
  invalidateTaskScope(qc);
  invalidateCompanyScope(qc);
}
