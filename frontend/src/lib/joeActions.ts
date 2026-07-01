import { supabase } from '@/integrations/supabase/client';
import { enrollPeopleInSequence } from '@/lib/enrollPeople';

export type JoeActionType =
  | 'draft_message'
  | 'enroll_in_sequence'
  | 'move_pipeline_stage'
  | 'create_task'
  | 'add_note';

export type JoeActionStatus = 'pending' | 'approved' | 'done' | 'dismissed' | 'snoozed';
export type JoeActionResolution = 'approved' | 'done' | 'dismissed' | 'snoozed';

export type JoeAction = {
  id: string;
  type: JoeActionType;
  title: string;
  preview?: string;
  params: Record<string, any>;
  route?: string | null;
  entity_type?: 'candidate' | 'contact';
};

export type JoeActionQueueItem = JoeAction & {
  source: 'briefing' | 'joe_proposal';
  status: JoeActionStatus;
  created_at: string;
  updated_at?: string | null;
  resolved_at?: string | null;
  snoozed_until?: string | null;
  history: JoeActionHistoryEvent[];
};

export type JoeActionHistoryEvent = {
  at: string;
  event: string;
  actor?: string | null;
  note?: string;
};

type QueueRow = {
  id: string;
  source: 'briefing' | 'joe_proposal';
  action_type: JoeActionType;
  entity_type?: 'candidate' | 'contact' | null;
  entity_id?: string | null;
  title: string;
  preview?: string | null;
  params?: Record<string, any> | null;
  route?: string | null;
  status: JoeActionStatus;
  created_at: string;
  updated_at?: string | null;
  resolved_at?: string | null;
  snoozed_until?: string | null;
  history?: JoeActionHistoryEvent[] | null;
};

export function queueRowToJoeAction(row: QueueRow): JoeActionQueueItem {
  return {
    id: row.id,
    type: row.action_type,
    title: row.title,
    preview: row.preview ?? undefined,
    params: row.params ?? {},
    route: row.route ?? null,
    entity_type: row.entity_type ?? undefined,
    source: row.source,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolved_at: row.resolved_at,
    snoozed_until: row.snoozed_until,
    history: Array.isArray(row.history) ? row.history : [],
  };
}

export function isJoeQueueItemVisible(item: Pick<JoeActionQueueItem, 'status' | 'snoozed_until'>, now = new Date()) {
  if (item.status === 'pending') return true;
  if (item.status !== 'snoozed') return false;
  if (!item.snoozed_until) return true;
  return new Date(item.snoozed_until).getTime() <= now.getTime();
}

export function isInlineExecutableJoeAction(action: Pick<JoeAction, 'type'>) {
  return action.type === 'add_note' || action.type === 'enroll_in_sequence' || action.type === 'create_task';
}

export function isLowRiskBatchAction(action: Pick<JoeAction, 'type'>) {
  return action.type === 'add_note' || action.type === 'create_task';
}

export async function executeJoeAction(action: JoeAction, userId?: string | null) {
  if (action.type === 'add_note') {
    const { error } = await supabase.from('notes').insert({
      entity_type: action.entity_type ?? 'candidate',
      entity_id: action.params.person_id,
      note: action.params.note,
      created_by: userId ?? null,
    } as any);
    if (error) throw error;
    return { summary: 'Note added' };
  }

  if (action.type === 'enroll_in_sequence') {
    const seqId = action.params.sequence_id as string | undefined;
    const ids = ((action.params.people as any[]) ?? [])
      .map((p) => p?.person_id)
      .filter(Boolean);
    if (!seqId || ids.length === 0) throw new Error('Nothing to enroll');
    const result = await enrollPeopleInSequence(seqId, ids);
    return { summary: summarizeEnrollment(result), result };
  }

  if (action.type === 'create_task') {
    const dueDate = action.params.due_date || new Date().toISOString().slice(0, 10);
    const { data: task, error } = await supabase
      .from('tasks')
      .insert({
        title: action.params.title || action.title.replace(/^Create task:\s*/i, ''),
        description: action.preview || null,
        priority: 'medium',
        due_date: dueDate,
        assigned_to: userId ?? null,
        created_by: userId ?? null,
        task_type: 'task',
      } as any)
      .select('id')
      .single();
    if (error) throw error;

    if (task?.id && action.params.person_id) {
      await supabase.from('task_links').insert({
        task_id: task.id,
        entity_type: action.entity_type ?? 'candidate',
        entity_id: action.params.person_id,
      } as any);
    }
    return { summary: 'Task created', taskId: task?.id };
  }

  throw new Error('This action needs review before it can be completed.');
}

function summarizeEnrollment(result: Awaited<ReturnType<typeof enrollPeopleInSequence>>) {
  const parts: string[] = [];
  if (result.enrolled) parts.push(`${result.enrolled} enrolled`);
  if (result.skipped) parts.push(`${result.skipped} already in sequence`);
  if (result.blocked) parts.push(`${result.blocked} skipped (do-not-contact)`);
  if (result.unresolved) parts.push(`${result.unresolved} not found`);
  if (result.initFailed) parts.push(`${result.initFailed} pre-schedule failed`);
  return parts.join(' · ') || 'No changes';
}

export async function persistJoeActionProposal(action: JoeAction, ownerUserId: string) {
  const now = new Date().toISOString();
  const history: JoeActionHistoryEvent[] = [{ at: now, event: 'proposed', actor: 'joe' }];
  const { data, error } = await (supabase.from('joe_action_queue' as any) as any)
    .upsert({
      id: action.id,
      owner_user_id: ownerUserId,
      source: 'joe_proposal',
      action_type: action.type,
      entity_type: action.entity_type ?? null,
      entity_id: action.params.person_id ?? action.params.job_id ?? null,
      title: action.title,
      preview: action.preview ?? null,
      params: action.params ?? {},
      route: action.route ?? null,
      status: 'pending',
      snoozed_until: null,
      history,
      updated_at: now,
    }, { onConflict: 'id' })
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data ? queueRowToJoeAction(data as QueueRow) : null;
}

export async function updateJoeActionQueueStatus(
  id: string,
  status: JoeActionResolution,
  options: { actor?: string | null; note?: string; snoozedUntil?: Date | string | null } = {},
) {
  const { data: existing, error: fetchError } = await (supabase.from('joe_action_queue' as any) as any)
    .select('history')
    .eq('id', id)
    .maybeSingle();
  if (fetchError) throw fetchError;

  const now = new Date().toISOString();
  const history = Array.isArray(existing?.history) ? existing.history : [];
  const snoozedUntil =
    status === 'snoozed'
      ? typeof options.snoozedUntil === 'string'
        ? options.snoozedUntil
        : (options.snoozedUntil ?? tomorrowMorning()).toISOString()
      : null;
  const patch: Record<string, unknown> = {
    status,
    updated_at: now,
    resolved_at: status === 'snoozed' ? null : now,
    snoozed_until: snoozedUntil,
    history: [
      ...history,
      {
        at: now,
        event: status,
        actor: options.actor ?? 'recruiter',
        ...(options.note ? { note: options.note } : {}),
      },
    ],
  };

  const { error } = await (supabase.from('joe_action_queue' as any) as any)
    .update(patch)
    .eq('id', id);
  if (error) throw error;
}

function tomorrowMorning() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(8, 0, 0, 0);
  return date;
}
