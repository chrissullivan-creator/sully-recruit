import { supabase } from '@/integrations/supabase/client';

const INTERVIEW_STAGE_VALUES = new Set(['interview', 'interviewing']);
const DEFAULT_TIMEZONE = 'America/Chicago';

export function isInterviewStage(stage: string | null | undefined) {
  return INTERVIEW_STAGE_VALUES.has(String(stage || '').toLowerCase());
}

export function normalizeInterviewStage(stage: string | null | undefined) {
  const value = String(stage || '').toLowerCase();
  return value === 'interview' ? 'interviewing' : value;
}

function addMinutes(iso: string, minutes: number) {
  return new Date(new Date(iso).getTime() + minutes * 60 * 1000).toISOString();
}

export async function ensureInterviewArtifacts(payload: {
  sendOutId: string;
  candidateId?: string | null;
  contactId?: string | null;
  jobId?: string | null;
  recruiterId?: string | null;
  stage: string;
  interviewAt?: string | null;
}) {
  if (!isInterviewStage(payload.stage)) return;

  const interviewAt = payload.interviewAt || new Date().toISOString();

  const [{ data: sendOut }, { data: actor }] = await Promise.all([
    supabase
      .from('send_outs')
      .select('id, candidate_id, contact_id, job_id, recruiter_id, interview_at')
      .eq('id', payload.sendOutId)
      .maybeSingle(),
    supabase.auth.getUser(),
  ]);

  const candidateId = payload.candidateId ?? sendOut?.candidate_id ?? null;
  const contactId = payload.contactId ?? sendOut?.contact_id ?? null;
  const jobId = payload.jobId ?? sendOut?.job_id ?? null;
  const recruiterId = payload.recruiterId ?? sendOut?.recruiter_id ?? actor.user?.id ?? null;

  const requests: Promise<any>[] = [];

  if (candidateId) {
    requests.push(
      supabase
        .from('people')
        .select('id, full_name, first_name, last_name, job_status')
        .eq('id', candidateId)
        .maybeSingle(),
    );
  } else {
    requests.push(Promise.resolve({ data: null }));
  }

  if (contactId) {
    requests.push(
      supabase
        .from('contacts')
        .select('id, full_name, first_name, last_name')
        .eq('id', contactId)
        .maybeSingle(),
    );
  } else {
    requests.push(Promise.resolve({ data: null }));
  }

  if (jobId) {
    requests.push(
      supabase
        .from('jobs')
        .select('id, title, company_name')
        .eq('id', jobId)
        .maybeSingle(),
    );
  } else {
    requests.push(Promise.resolve({ data: null }));
  }

  const [candidateRes, contactRes, jobRes] = await Promise.all(requests);
  const candidate = candidateRes.data;
  const contact = contactRes.data;
  const job = jobRes.data;

  const personName =
    candidate?.full_name ||
    `${candidate?.first_name || ''} ${candidate?.last_name || ''}`.trim() ||
    contact?.full_name ||
    `${contact?.first_name || ''} ${contact?.last_name || ''}`.trim() ||
    'Interview Candidate';

  const jobLabel = job?.title || 'Open Role';
  const companyLabel = job?.company_name ? ` at ${job.company_name}` : '';
  const title = `Interview: ${personName} — ${jobLabel}${companyLabel}`;
  const description = `Auto-created when the send-out moved to ${normalizeInterviewStage(payload.stage)}. Update the meeting details if the interview gets scheduled for a different time.`;

  const { data: existingTask } = await supabase
    .from('tasks')
    .select('id')
    .eq('related_to_type', 'send_out')
    .eq('related_to_id', payload.sendOutId)
    .eq('task_type', 'meeting')
    .maybeSingle();

  let taskId = existingTask?.id ?? null;

  if (taskId) {
    const { error } = await supabase
      .from('tasks')
      .update({
        title,
        description,
        due_date: interviewAt.split('T')[0],
        start_time: interviewAt,
        end_time: addMinutes(interviewAt, 30),
        timezone: DEFAULT_TIMEZONE,
        task_subtype: 'Interview',
        assigned_to: recruiterId,
      } as any)
      .eq('id', taskId);

    if (error) throw error;
  } else {
    const createdBy = actor.user?.id ?? recruiterId ?? null;
    const { data: createdTask, error } = await supabase
      .from('tasks')
      .insert({
        title,
        description,
        status: 'pending',
        priority: 'medium',
        due_date: interviewAt.split('T')[0],
        created_by: createdBy,
        assigned_to: recruiterId,
        task_type: 'meeting',
        start_time: interviewAt,
        end_time: addMinutes(interviewAt, 30),
        timezone: DEFAULT_TIMEZONE,
        task_subtype: 'Interview',
        related_to_type: 'send_out',
        related_to_id: payload.sendOutId,
        no_calendar_invites: true,
      } as any)
      .select('id')
      .single();

    if (error) throw error;
    taskId = createdTask.id;
  }

  if (taskId) {
    const linkRows = [
      candidateId ? { task_id: taskId, entity_type: 'candidate', entity_id: candidateId } : null,
      contactId ? { task_id: taskId, entity_type: 'contact', entity_id: contactId } : null,
      jobId ? { task_id: taskId, entity_type: 'job', entity_id: jobId } : null,
    ].filter(Boolean) as Array<{ task_id: string; entity_type: string; entity_id: string }>;

    if (linkRows.length > 0) {
      const { data: existingLinks } = await supabase
        .from('task_links')
        .select('task_id, entity_type, entity_id')
        .eq('task_id', taskId);

      const existingKeys = new Set(
        (existingLinks || []).map((row: any) => `${row.task_id}:${row.entity_type}:${row.entity_id}`),
      );

      const missingLinks = linkRows.filter(
        (row) => !existingKeys.has(`${row.task_id}:${row.entity_type}:${row.entity_id}`),
      );

      if (missingLinks.length > 0) {
        await supabase.from('task_links').insert(missingLinks as any);
      }
    }

    const attendeeRows = [
      candidateId ? { task_id: taskId, entity_type: 'candidate', entity_id: candidateId } : null,
      contactId ? { task_id: taskId, entity_type: 'contact', entity_id: contactId } : null,
    ].filter(Boolean);

    if (attendeeRows.length > 0) {
      const { data: existingAttendees } = await supabase
        .from('meeting_attendees')
        .select('task_id, entity_type, entity_id')
        .eq('task_id', taskId);

      const existingKeys = new Set(
        (existingAttendees || []).map((row: any) => `${row.task_id}:${row.entity_type}:${row.entity_id}`),
      );

      const missingAttendees = attendeeRows.filter(
        (row: any) => !existingKeys.has(`${row.task_id}:${row.entity_type}:${row.entity_id}`),
      );

      if (missingAttendees.length > 0) {
        await supabase.from('meeting_attendees').insert(missingAttendees as any);
      }
    }
  }

  if (candidateId) {
    await supabase
      .from('people')
      .update({ job_status: 'interviewing' } as any)
      .eq('id', candidateId);
  }
}
