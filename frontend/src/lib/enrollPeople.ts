import { supabase } from '@/integrations/supabase/client';

export interface EnrollResult {
  enrolled: number; // newly inserted enrollment rows
  skipped: number; // already enrolled in this sequence
  blocked: number; // do_not_contact — never enrolled
  unresolved: number; // unknown id / soft-deleted
  initFailed: number; // enrollment-init trigger that didn't fire
}

/**
 * Enroll a set of people into a sequence and fan out the
 * `sequence/enrollment-init.requested` trigger so each enrollment's steps get
 * pre-scheduled. Mirrors EnrollInSequenceDialog's proven path — resolve from
 * `people` (covers candidates + clients, both FK to people), pick the
 * candidate_id/contact_id column by role, skip people already enrolled, then
 * POST /api/trigger-sequence-enroll per inserted row.
 *
 * Adds one guard the manual dialog doesn't need: it hard-skips
 * `do_not_contact` people. This helper backs Joe's one-click enroll card, so a
 * DNC contact must never be enrolled even if it slips into the proposal.
 */
export async function enrollPeopleInSequence(
  sequenceId: string,
  personIds: string[],
): Promise<EnrollResult> {
  const result: EnrollResult = { enrolled: 0, skipped: 0, blocked: 0, unresolved: 0, initFailed: 0 };
  const ids = [...new Set(personIds.filter(Boolean))];
  if (!sequenceId || ids.length === 0) return result;

  const userId = (await supabase.auth.getUser()).data.user?.id ?? null;

  // Resolve straight from `people` rather than cached candidate/contact lists —
  // both candidate_id and contact_id FK to people, so one lookup covers either.
  const { data: peopleRows, error: peopleErr } = await supabase
    .from('people')
    .select('id, type, roles, do_not_contact')
    .in('id', ids)
    .is('deleted_at', null);
  if (peopleErr) throw peopleErr;
  const personById = new Map((peopleRows ?? []).map((p: any) => [p.id, p]));

  // Existing enrollments → skip duplicates. Both columns hold people ids, so a
  // single set keyed on the person id covers candidate + contact rows.
  const { data: existing } = await supabase
    .from('sequence_enrollments')
    .select('candidate_id, contact_id')
    .eq('sequence_id', sequenceId);
  const existingIds = new Set<string>();
  for (const e of existing ?? []) {
    if (e.candidate_id) existingIds.add(e.candidate_id);
    if (e.contact_id) existingIds.add(e.contact_id);
  }

  const enrollments: any[] = [];
  for (const personId of ids) {
    const row: any = personById.get(personId);
    if (!row) { result.unresolved++; continue; }
    if (row.do_not_contact) { result.blocked++; continue; }
    if (existingIds.has(personId)) { result.skipped++; continue; }
    const roles: string[] = Array.isArray(row.roles) ? row.roles : [];
    // Clients enroll via contact_id; candidates (incl. dual-role) via candidate_id.
    const isClient = row.type === 'client' || (roles.includes('client') && !roles.includes('candidate'));
    enrollments.push({
      sequence_id: sequenceId,
      ...(isClient ? { contact_id: personId } : { candidate_id: personId }),
      status: 'active',
      enrolled_by: userId,
    });
  }

  if (enrollments.length > 0) {
    const { data: inserted, error } = await supabase
      .from('sequence_enrollments')
      .insert(enrollments)
      .select('id, sequence_id, candidate_id, contact_id, enrolled_by');
    if (error) throw error;

    // Fan out the enrollment-init trigger per row — without it no
    // sequence_step_logs get pre-scheduled and the enrollment sits dormant.
    const authToken = (await supabase.auth.getSession()).data.session?.access_token;
    const initResults = await Promise.allSettled(
      (inserted ?? []).map(async (row: any) => {
        const resp = await fetch('/api/trigger-sequence-enroll', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({
            enrollment_id: row.id,
            sequence_id: row.sequence_id,
            candidate_id: row.candidate_id,
            contact_id: row.contact_id,
            enrolled_by: row.enrolled_by,
          }),
        });
        if (!resp.ok) {
          const detail = await resp.text().catch(() => '');
          throw new Error(`enroll-init ${resp.status}: ${detail.slice(0, 120)}`);
        }
      }),
    );
    result.enrolled = enrollments.length;
    result.initFailed = initResults.filter((r) => r.status === 'rejected').length;
  }

  return result;
}
