import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import {
  Loader2, Users, Briefcase, Building2, Calendar, Eye, Sparkles,
  Download,
} from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type RecruiterFilter = 'all' | 'ashley' | 'nancy' | 'chris';

interface AccountOption {
  label: string;
  mode: RecruiterFilter;
  accountId: string | null;
  ownerUserId: string | null;
}

interface JobPostingChannel {
  id: string;
  name?: string;
  state?: string; // ACTIVE | CLOSED | DRAFT
  job_posting_id?: string;
}

interface HiringProject {
  id: string;
  title: string;
  created_at?: string;
  updated_at?: string;
  last_accessed_at?: string;
  applicant_count?: number;
  pipeline_count?: number;
  status?: string;
  visibility?: string;
  owner_name?: string;
  company_name?: string;
  job_title?: string;
  job_posting_id?: string;
  job_posting?: JobPostingChannel | null;
  has_recommended_matches?: boolean;
  account_id: string;
  recruiter: string;
  [key: string]: any;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function callSourceApi(body: Record<string, any>, session: any) {
  const resp = await fetch('/api/source-projects', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `API error ${resp.status}`);
  return data;
}

function normalizeProject(raw: any, accountId: string, recruiter: string): HiringProject {
  // Sum candidates_count across pipeline stages — that's the "Pipeline: N candidates"
  // figure LinkedIn shows on each project card.
  const pipelineCount = Array.isArray(raw?.pipeline?.stages)
    ? raw.pipeline.stages.reduce((n: number, s: any) => n + (Number(s?.candidates_count) || 0), 0)
    : undefined;

  const channels: any[] = Array.isArray(raw?.talent_pool?.channels) ? raw.talent_pool.channels : [];
  const jobPostingChannel = channels.find((c) => c?.type === 'JOB_POSTING') || null;
  const hasRecommendedMatches = channels.some(
    (c) => c?.type === 'JOB_POSTING_RECOMMENDED_MATCHES' && c?.state === 'ACTIVE'
  );

  return {
    ...raw,
    id: raw.id || raw.project_id || raw.urn || `proj-${Math.random()}`,
    title: raw.title || raw.name || raw.project_name || 'Untitled Project',
    created_at: raw.created_at || raw.createdAt || raw.creation_date || null,
    updated_at: raw.updated_at || raw.last_modified_at || raw.updatedAt || raw.modified_date || null,
    last_accessed_at: raw.last_accessed_at || null,
    applicant_count: raw.applicant_count ?? raw.total_applicants ?? raw.num_applicants ?? null,
    pipeline_count: pipelineCount,
    status: raw.status || null,
    visibility: raw.visibility || null,
    owner_name: raw?.owner?.name || null,
    company_name: raw?.metadata?.company?.name || null,
    job_title: raw?.metadata?.job_title || null,
    job_posting_id: raw?.metadata?.job_posting_id || jobPostingChannel?.id || null,
    job_posting: jobPostingChannel
      ? {
          id: jobPostingChannel.id,
          name: jobPostingChannel.name,
          state: jobPostingChannel.state,
          job_posting_id: jobPostingChannel.id,
        }
      : null,
    has_recommended_matches: hasRecommendedMatches,
    account_id: accountId,
    recruiter,
  };
}

function relativeTime(iso?: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function Source() {
  const { user } = useAuth();
  const navigate = useNavigate();

  // ---- Account state ----
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [recruiterFilter, setRecruiterFilter] = useState<RecruiterFilter>('all');

  // ---- Projects state ----
  const [projects, setProjects] = useState<HiringProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);

  // ---- Linked-jobs lookup ----
  // Map of (account_id|project_id) → internal job_id, used to gate the
  // Backfill button and show the "Linked" badge.
  const [linkedJobs, setLinkedJobs] = useState<Record<string, string>>({});

  // ---- Backfill progress ----
  // Keyed by project id; null = idle, object = in-flight summary.
  const [backfillStatus, setBackfillStatus] = useState<Record<string, { processed: number; created: number; updated: number; total: number | null; done?: boolean }>>({});

  const refreshLinkedJobs = useCallback(async () => {
    const { data } = await supabase
      .from('jobs')
      .select('id, linkedin_project_id, linkedin_project_account_id')
      .not('linkedin_project_id', 'is', null);
    const map: Record<string, string> = {};
    for (const row of data || []) {
      if (row.linkedin_project_account_id && row.linkedin_project_id) {
        map[`${row.linkedin_project_account_id}|${row.linkedin_project_id}`] = row.id as string;
      }
    }
    setLinkedJobs(map);
  }, []);

  useEffect(() => { refreshLinkedJobs(); }, [refreshLinkedJobs]);

  // Iterative backfill: walks pipeline candidates then talent-pool
  // applicants in 25-row batches until next_cursor is null. Each
  // iteration upserts people + sourcing rows server-side.
  const runBackfill = useCallback(async (project: HiringProject) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { toast.error('Not authenticated'); return; }

    const key = project.id;
    setBackfillStatus((s) => ({ ...s, [key]: { processed: 0, created: 0, updated: 0, total: null } }));

    let totalCreated = 0;
    let totalUpdated = 0;
    let totalProcessed = 0;
    let totalCount: number | null = null;

    for (const src of ['pipeline', 'applicants'] as const) {
      let cursor: string | null = null;
      // Safety cap so a runaway cursor doesn't loop forever.
      for (let iter = 0; iter < 80; iter++) {
        try {
          const data = await callSourceApi({
            action: 'backfill_project',
            account_id: project.account_id,
            job_id: project.id,
            source: src,
            cursor,
            limit: 25,
          }, session);
          totalProcessed += data.processed || 0;
          totalCreated += data.created || 0;
          totalUpdated += data.updated || 0;
          if (typeof data.total_count === 'number') totalCount = data.total_count;
          setBackfillStatus((s) => ({
            ...s,
            [key]: { processed: totalProcessed, created: totalCreated, updated: totalUpdated, total: totalCount },
          }));
          cursor = data.next_cursor || null;
          if (!cursor) break;
        } catch (err: any) {
          toast.error(`Backfill ${src}: ${err.message || 'failed'}`);
          break;
        }
      }
    }

    setBackfillStatus((s) => ({
      ...s,
      [key]: { processed: totalProcessed, created: totalCreated, updated: totalUpdated, total: totalCount, done: true },
    }));
    toast.success(`Backfilled ${totalCreated} new + ${totalUpdated} updated from "${project.title}"`);
  }, []);

  // ---- Load accounts on mount ----
  useEffect(() => {
    if (!user) return;
    (async () => {
      setAccountsLoading(true);
      try {
        // Hiring Projects only exist on LinkedIn Recruiter seats. Pin
        // account_type='linkedin_recruiter' explicitly — without this
        // we accidentally pick the recruiter's Outlook row (also
        // unipile-wired now) and hit Unipile with an email account id.
        const [{ data: ashley }, { data: nancy }, { data: chris }] = await Promise.all([
          supabase.from('integration_accounts').select('unipile_account_id, owner_user_id')
            .ilike('account_label', '%Ashley%')
            .eq('account_type', 'linkedin_recruiter')
            .eq('is_active', true)
            .not('unipile_account_id', 'is', null).maybeSingle(),
          supabase.from('integration_accounts').select('unipile_account_id, owner_user_id')
            .ilike('account_label', '%Nancy%')
            .eq('account_type', 'linkedin_recruiter')
            .eq('is_active', true)
            .not('unipile_account_id', 'is', null).maybeSingle(),
          supabase.from('integration_accounts').select('unipile_account_id, owner_user_id')
            .ilike('account_label', '%Chris Sullivan%')
            .eq('account_type', 'linkedin_recruiter')
            .eq('is_active', true)
            .not('unipile_account_id', 'is', null).maybeSingle(),
        ]);
        setAccounts([
          { label: 'Ashley Leichner', mode: 'ashley', accountId: ashley?.unipile_account_id ?? null, ownerUserId: ashley?.owner_user_id ?? null },
          { label: 'Nancy Eberlein', mode: 'nancy', accountId: nancy?.unipile_account_id ?? null, ownerUserId: nancy?.owner_user_id ?? null },
          { label: 'Chris Sullivan', mode: 'chris', accountId: chris?.unipile_account_id ?? null, ownerUserId: chris?.owner_user_id ?? null },
        ]);
      } catch (err) {
        console.error('Failed to load accounts', err);
      } finally {
        setAccountsLoading(false);
      }
    })();
  }, [user]);

  // ---- Fetch projects ----
  const fetchProjects = useCallback(async () => {
    const filtered = recruiterFilter === 'all'
      ? accounts.filter(a => a.accountId)
      : accounts.filter(a => a.mode === recruiterFilter && a.accountId);

    if (filtered.length === 0) { setProjects([]); return; }

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { toast.error('Not authenticated'); return; }

    setProjectsLoading(true);
    try {
      const results = await Promise.allSettled(
        filtered.map(async (acct) => {
          const data = await callSourceApi({
            action: 'list_projects',
            account_id: acct.accountId,
          }, session);
          const items = data.items || data.results || data || [];
          return (Array.isArray(items) ? items : []).map((p: any) =>
            normalizeProject(p, acct.accountId!, acct.label)
          );
        })
      );

      const merged: HiringProject[] = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const acctLabel = filtered[i]?.label || `Account ${i + 1}`;
        if (r.status === 'fulfilled') {
          merged.push(...r.value);
        } else {
          const errMsg = r.reason?.message || 'Unknown error';
          toast.error(`${acctLabel}: ${errMsg}`);
          console.error(`[Source] ${acctLabel} project fetch failed:`, errMsg);
        }
      }

      // Match LinkedIn's "Last used by me" default: most-recently-accessed first,
      // falling back to last-modified, then created.
      const recencyKey = (p: HiringProject) => {
        const v = p.last_accessed_at || p.updated_at || p.created_at;
        return v ? new Date(v).getTime() : 0;
      };
      merged.sort((a, b) => recencyKey(b) - recencyKey(a));

      setProjects(merged);
    } catch (err: any) {
      console.error('Failed to fetch projects', err);
      toast.error(err.message || 'Failed to load projects');
    } finally {
      setProjectsLoading(false);
    }
  }, [accounts, recruiterFilter]);

  useEffect(() => {
    if (accounts.length > 0) fetchProjects();
  }, [accounts, recruiterFilter, fetchProjects]);

  // ---- Navigate to project detail ----
  const openProject = (project: HiringProject) => {
    const params = new URLSearchParams({
      account_id: project.account_id,
      title: project.title,
      recruiter: project.recruiter,
    });
    navigate(`/source/${encodeURIComponent(project.id)}?${params}`);
  };

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */
  return (
    <MainLayout>
      <PageHeader
        title={`Source${projects.length > 0 ? ` (${projects.length})` : ''}`}
        description="Import applicants from LinkedIn Hiring Projects"
      />

      {/* Controls bar */}
      <div className="flex items-center gap-4 mb-6">
        <Select
          value={recruiterFilter}
          onValueChange={(val) => setRecruiterFilter(val as RecruiterFilter)}
        >
          <SelectTrigger className="w-52">
            <SelectValue placeholder="Filter by recruiter" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Recruiters</SelectItem>
            <SelectItem value="ashley">Ashley Leichner</SelectItem>
            <SelectItem value="nancy">Nancy Eberlein</SelectItem>
            <SelectItem value="chris">Chris Sullivan</SelectItem>
          </SelectContent>
        </Select>

        <Button variant="outline" size="sm" onClick={fetchProjects} disabled={projectsLoading}>
          {projectsLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
          Refresh
        </Button>
      </div>

      {/* Loading */}
      {(accountsLoading || projectsLoading) && projects.length === 0 && (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin mr-2" />
          Loading projects…
        </div>
      )}

      {/* Empty state */}
      {!accountsLoading && !projectsLoading && projects.length === 0 && (
        <div className="text-center py-20 text-muted-foreground">
          No hiring projects found. Make sure your LinkedIn Recruiter accounts are connected.
        </div>
      )}

      {/* Projects list — rich cards modeled after LinkedIn Recruiter's project list */}
      <div className="space-y-3">
        {projects.map((project) => {
          const jp = project.job_posting;
          const jpState = jp?.state ? jp.state.toLowerCase() : null;
          const createdDate = project.created_at
            ? new Date(project.created_at).toLocaleDateString()
            : null;
          const viewedAgo = relativeTime(project.last_accessed_at);
          const linkKey = `${project.account_id}|${project.id}`;
          const isLinked = !!linkedJobs[linkKey];
          const backfill = backfillStatus[project.id];
          const backfillInFlight = backfill && !backfill.done;
          return (
            <div
              key={project.id}
              className="bg-card border border-border rounded-lg hover:border-foreground/20 transition-colors"
            >
            <button
              onClick={() => openProject(project)}
              className="w-full text-left p-4 hover:bg-accent/5"
            >
              {/* Title row */}
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-base truncate">{project.title}</div>
                  {(project.company_name || project.owner_name || createdDate) && (
                    <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
                      {project.company_name && (
                        <span className="inline-flex items-center gap-1">
                          <Building2 className="h-3 w-3" />
                          {project.company_name}
                        </span>
                      )}
                      {project.owner_name && (
                        <>
                          <span aria-hidden>·</span>
                          <span>Owner: {project.owner_name}</span>
                        </>
                      )}
                      {createdDate && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="inline-flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            Created {createdDate}
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <Badge variant="outline" className="text-[10px] shrink-0">{project.recruiter}</Badge>
              </div>

              {/* Stats row: pipeline count + viewed */}
              <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                {project.pipeline_count != null && (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
                    <Users className="h-3 w-3" />
                    Pipeline: {project.pipeline_count} candidate{project.pipeline_count === 1 ? '' : 's'}
                  </span>
                )}
                {viewedAgo && (
                  <span className="inline-flex items-center gap-1">
                    <Eye className="h-3 w-3" />
                    Viewed {viewedAgo}
                  </span>
                )}
                {project.has_recommended_matches && (
                  <span className="inline-flex items-center gap-1 text-emerald-500">
                    <Sparkles className="h-3 w-3" />
                    Recommended matches active
                  </span>
                )}
              </div>

              {/* Tagged job posting (if linked on LinkedIn) */}
              {jp && (
                <div className="mt-2 flex items-center gap-2 text-xs">
                  <Briefcase className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">Job</span>
                  {jp.id && <span className="text-muted-foreground">({jp.id}):</span>}
                  <span className="font-medium truncate">{jp.name || project.job_title || 'Untitled'}</span>
                  {jpState && (
                    <Badge
                      variant="outline"
                      className={
                        jpState === 'active'
                          ? 'text-[10px] border-emerald-500/30 text-emerald-500'
                          : jpState === 'closed'
                          ? 'text-[10px] border-red-500/30 text-red-500'
                          : 'text-[10px]'
                      }
                    >
                      {jpState}
                    </Badge>
                  )}
                </div>
              )}
            </button>

            {/* Action row — Backfill button (only when linked) + status */}
            {(isLinked || backfill) && (
              <div className="px-4 py-2 border-t border-border flex items-center gap-3 text-xs">
                {isLinked && (
                  <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-500">
                    Linked
                  </Badge>
                )}
                {backfill && (
                  <span className="text-muted-foreground">
                    {backfill.done ? 'Backfilled' : 'Backfilling…'} {backfill.created} new + {backfill.updated} updated
                    {backfill.total != null && !backfill.done ? ` (${backfill.processed} of ~${backfill.total})` : ''}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  {isLinked && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!!backfillInFlight}
                      onClick={(e) => { e.stopPropagation(); runBackfill(project); }}
                    >
                      {backfillInFlight
                        ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                        : <Download className="h-3.5 w-3.5 mr-1" />}
                      {backfill?.done ? 'Re-import' : 'Backfill'}
                    </Button>
                  )}
                </div>
              </div>
            )}
            </div>
          );
        })}
      </div>
    </MainLayout>
  );
}
