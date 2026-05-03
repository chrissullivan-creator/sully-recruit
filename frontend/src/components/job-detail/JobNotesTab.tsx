import { EntityNotesTab } from '@/components/shared/EntityNotesTab';

export function JobNotesTab({ jobId }: { jobId: string }) {
  return <EntityNotesTab entityType="job" entityId={jobId} placeholder="Add a note about this job — call summary, client preferences, anything the team should see…" />;
}
