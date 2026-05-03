-- Pass 9: terminology cleanup. Drop one zombie column. Add COMMENT ON COLUMN to
-- document canonical meaning where the schema is ambiguous.
-- See TERMINOLOGY.md for the full naming guide.

-- Drop candidates.stage (100% NULL, no rationale)
ALTER TABLE candidates DROP COLUMN IF EXISTS stage;

-- Person reference column comments
COMMENT ON COLUMN candidates.id IS 'Person UUID. After Pass 5a unification, this PK is shared by both candidate-type and client-type rows. All foreign keys named candidate_id or contact_id elsewhere reference this column.';
COMMENT ON COLUMN candidates.type IS 'candidate | client. Determines which UI surfaces the row appears on. Use type=candidate for talent, type=client for hiring managers / contacts at client companies.';
COMMENT ON COLUMN candidates.linked_contact_id IS 'Self-reference: links a candidate to their counterpart-as-client (or vice versa). Used when the same person is both a candidate AND a client at different times.';

-- Owner / actor column comments
COMMENT ON COLUMN candidates.owner_user_id IS 'Recruiter who currently owns this person. CANONICAL OWNER FIELD. Other tables use owner_id (deprecated alias) — see TERMINOLOGY.md.';
COMMENT ON COLUMN candidates.created_by_user_id IS 'User who first created this row. Never changes. For "who edited last" use updated_at + audit log.';
COMMENT ON COLUMN messages.owner_id IS 'User who sent (outbound) or owns (inbound) this message. Should match candidates.owner_user_id. Will be renamed to owner_user_id in a future pass.';
COMMENT ON COLUMN call_logs.owner_id IS 'User who placed/received the call. Will be renamed owner_user_id in a future pass.';
COMMENT ON COLUMN conversations.owner_id IS 'User who owns this conversation thread. Will be renamed owner_user_id in a future pass.';
COMMENT ON COLUMN send_outs.recruiter_id IS 'Recruiter who sent the candidate to client. Synonym for owner_user_id, kept for legacy reasons.';
COMMENT ON COLUMN tasks.created_by IS 'User who created the task. Equivalent to created_by_user_id elsewhere.';
COMMENT ON COLUMN tasks.assigned_to IS 'User the task is currently assigned to (may differ from creator). Equivalent to assigned_user_id elsewhere.';

-- Status / stage clarity
COMMENT ON COLUMN candidates.status IS 'Person engagement state: new | reached_out | engaged. CHECK-constrained. Distinct from candidate_jobs.pipeline_stage which tracks per-job pipeline.';
COMMENT ON COLUMN candidates.job_status IS 'DEPRECATED — duplicates candidate_jobs.pipeline_stage. 200 rows still populated (old data). New code should write to candidate_jobs.pipeline_stage instead. Will be dropped after frontend migration.';
COMMENT ON COLUMN candidate_jobs.pipeline_stage IS 'Per-(candidate, job) pipeline stage: lead | new | reached_out | pitch | pitched | sendout | sent | submitted | interview | interviewing | offer | placed | rejected | withdrew. CANONICAL pipeline-stage field.';
COMMENT ON COLUMN send_outs.stage IS 'Sendout-specific lifecycle stage (NOT the candidate_jobs pipeline). Tracks where this single sendout is in its own micro-flow.';
COMMENT ON COLUMN interviews.stage IS 'Per-interview stage: scheduled | completed | cancelled. Independent of candidate_jobs.pipeline_stage.';
COMMENT ON COLUMN sequence_enrollments.status IS 'Sequence enrollment lifecycle: active | paused | stopped | completed. Independent of candidate engagement status.';
COMMENT ON COLUMN jobs.status IS 'Job opening state: open | on_hold | filled | closed. Lifecycle of the job itself, not of any candidate-job pairing.';

-- Activity-source table tags
COMMENT ON COLUMN status_change_log.entity_type IS 'candidate | contact. Both now point to candidates table (contacts is a view).';
COMMENT ON COLUMN stage_transitions.entity_type IS 'candidate | candidate_job. For per-job pipeline movement, use candidate_job.';
COMMENT ON COLUMN notes.entity_type IS 'candidate | contact | candidate_job | job. Determines which table entity_id resolves against.';
COMMENT ON COLUMN meeting_attendees.entity_type IS 'candidate | contact. After Pass 5a, both resolve via candidates table.';
