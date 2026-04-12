import { useState, useEffect, useCallback } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useJobs } from '@/hooks/useData';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BulkAddCandidatesDialog } from '@/components/source/BulkAddCandidatesDialog';
import { BulkAddContactsDialog } from '@/components/source/BulkAddContactsDialog';
import {
  Loader2, ChevronDown, ChevronRight, Users, UserCheck, Contact,
  FileText, CheckSquare, Square, Briefcase,
} from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type RecruiterFilter = 'all' | 'ashley' | 'nancy' | 'chris';
type ProjectLabel = 'candidate' | 'contact';

interface AccountOption {
  label: string;
  mode: RecruiterFilter;
  accountId: string | null;
  ownerUserId: string | null;
}

interface HiringProject {
  id: string;
  title: string;
  created_at?: string;
  updated_at?: string;
  applicant_count?: number;
  status?: string;
  account_id: string;
  recruiter: string;
  // raw fields from Unipile (names vary)
  [key: string]: any;
}

interface Applicant {
  id: string;
  first_name: string;
  last_name: string;
  headline?: string;
  current_title?: string;
  current_company?: string;
  location?: string;
  linkedin_url?: string;
  profile_picture_url?: string;
  stage?: string;
  has_resume?: boolean;
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
  return {
    ...raw,
    id: raw.id || raw.project_id || raw.urn || `proj-${Math.random()}`,
    title: raw.title || raw.name || raw.project_name || 'Untitled Project',
    created_at: raw.created_at || raw.createdAt || raw.creation_date || null,
    updated_at: raw.updated_at || raw.updatedAt || raw.modified_date || null,
    applicant_count: raw.applicant_count ?? raw.total_applicants ?? raw.num_applicants ?? null,
    status: raw.status || null,
    account_id: accountId,
    recruiter,
  };
}

function normalizeApplicant(raw: any): Applicant {
  return {
    ...raw,
    id: raw.id || raw.applicant_id || raw.urn || `app-${Math.random()}`,
    first_name: raw.first_name || raw.firstName || '',
    last_name: raw.last_name || raw.lastName || '',
    headline: raw.headline || '',
    current_title: raw.title || raw.current_title || raw.headline || '',
    current_company: raw.company || raw.current_company || raw.company_name || '',
    location: raw.location || raw.region || '',
    linkedin_url: raw.linkedin_url || raw.public_profile_url || raw.url || '',
    profile_picture_url: raw.profile_picture_url || raw.picture_url || raw.avatar_url || '',
    stage: raw.stage || raw.status || raw.pipeline_stage || 'unknown',
    has_resume: raw.has_resume ?? raw.resume_available ?? false,
  };
}

const STAGE_ORDER = ['new', 'screen', 'interview', 'offer', 'hired', 'rejected', 'unknown'];
const STAGE_COLORS: Record<string, string> = {
  new: 'bg-blue-500/10 text-blue-400',
  screen: 'bg-yellow-500/10 text-yellow-400',
  interview: 'bg-purple-500/10 text-purple-400',
  offer: 'bg-emerald-500/10 text-emerald-400',
  hired: 'bg-green-500/10 text-green-400',
  rejected: 'bg-red-500/10 text-red-400',
  unknown: 'bg-muted text-muted-foreground',
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function Source() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: allJobs = [] } = useJobs();
  const warmHotJobs = allJobs.filter((j: any) => j.stage === 'warm' || j.stage === 'hot');

  // ---- Account state ----
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [recruiterFilter, setRecruiterFilter] = useState<RecruiterFilter>('all');

  // ---- Projects state ----
  const [projects, setProjects] = useState<HiringProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectLabels, setProjectLabels] = useState<Record<string, ProjectLabel>>({});
  const [projectJobs, setProjectJobs] = useState<Record<string, string>>({});

  // ---- Expanded project + applicants ----
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const [applicants, setApplicants] = useState<Applicant[]>([]);
  const [applicantsLoading, setApplicantsLoading] = useState(false);
  const [selectedApplicantIds, setSelectedApplicantIds] = useState<Set<string>>(new Set());

  // ---- Dialogs ----
  const [candidateDialogOpen, setCandidateDialogOpen] = useState(false);
  const [contactDialogOpen, setContactDialogOpen] = useState(false);

  // ---- Load accounts on mount ----
  useEffect(() => {
    if (!user) return;
    (async () => {
      setAccountsLoading(true);
      try {
        const [{ data: ashley }, { data: nancy }, { data: chris }] = await Promise.all([
          supabase.from('integration_accounts').select('unipile_account_id, owner_user_id')
            .ilike('account_label', '%Ashley%').eq('is_active', true).maybeSingle(),
          supabase.from('integration_accounts').select('unipile_account_id, owner_user_id')
            .ilike('account_label', '%Nancy%').eq('is_active', true).maybeSingle(),
          supabase.from('integration_accounts').select('unipile_account_id, owner_user_id')
            .ilike('account_label', '%Chris Sullivan%').eq('is_active', true).maybeSingle(),
        ]);
        setAccounts([
          { label: 'Ashley', mode: 'ashley', accountId: ashley?.unipile_account_id ?? null, ownerUserId: ashley?.owner_user_id ?? null },
          { label: 'Nancy', mode: 'nancy', accountId: nancy?.unipile_account_id ?? null, ownerUserId: nancy?.owner_user_id ?? null },
          { label: 'Chris', mode: 'chris', accountId: chris?.unipile_account_id ?? null, ownerUserId: chris?.owner_user_id ?? null },
        ]);
      } catch (err) {
        console.error('Failed to load accounts', err);
      } finally {
        setAccountsLoading(false);
      }
    })();
  }, [user]);

  // ---- Fetch projects when accounts loaded or filter changes ----
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
      for (const r of results) {
        if (r.status === 'fulfilled') merged.push(...r.value);
      }

      // Sort newest first
      merged.sort((a, b) => {
        const da = a.created_at ? new Date(a.created_at).getTime() : 0;
        const db = b.created_at ? new Date(b.created_at).getTime() : 0;
        return db - da;
      });

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

  // ---- Fetch applicants for a project ----
  const fetchApplicants = async (project: HiringProject) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    setApplicantsLoading(true);
    setApplicants([]);
    setSelectedApplicantIds(new Set());
    try {
      const data = await callSourceApi({
        action: 'list_applicants',
        account_id: project.account_id,
        job_id: project.id,
      }, session);

      const items = data.items || data.results || data || [];
      const normalized = (Array.isArray(items) ? items : []).map(normalizeApplicant);
      setApplicants(normalized);
    } catch (err: any) {
      console.error('Failed to fetch applicants', err);
      toast.error(err.message || 'Failed to load applicants');
    } finally {
      setApplicantsLoading(false);
    }
  };

  // ---- Expand/collapse project ----
  const toggleProject = (project: HiringProject) => {
    if (expandedProjectId === project.id) {
      setExpandedProjectId(null);
      setApplicants([]);
      setSelectedApplicantIds(new Set());
    } else {
      setExpandedProjectId(project.id);
      fetchApplicants(project);
    }
  };

  // ---- Selection helpers ----
  const toggleApplicant = (id: string) => {
    setSelectedApplicantIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAllApplicants = () => {
    if (selectedApplicantIds.size === applicants.length) {
      setSelectedApplicantIds(new Set());
    } else {
      setSelectedApplicantIds(new Set(applicants.map(a => a.id)));
    }
  };

  // ---- Group applicants by stage ----
  const applicantsByStage = applicants.reduce<Record<string, Applicant[]>>((acc, a) => {
    const stage = a.stage || 'unknown';
    if (!acc[stage]) acc[stage] = [];
    acc[stage].push(a);
    return acc;
  }, {});
  const sortedStages = Object.keys(applicantsByStage).sort(
    (a, b) => (STAGE_ORDER.indexOf(a) === -1 ? 99 : STAGE_ORDER.indexOf(a)) -
              (STAGE_ORDER.indexOf(b) === -1 ? 99 : STAGE_ORDER.indexOf(b))
  );

  // ---- Get selected applicant objects ----
  const selectedApplicants = applicants.filter(a => selectedApplicantIds.has(a.id));
  const expandedProject = projects.find(p => p.id === expandedProjectId);
  const expandedLabel = expandedProjectId ? (projectLabels[expandedProjectId] || 'candidate') : 'candidate';
  const expandedJobId = expandedProjectId ? projectJobs[expandedProjectId] : undefined;

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */
  return (
    <MainLayout>
      <PageHeader
        title="Source"
        description="Import applicants from LinkedIn Hiring Projects"
      />

      {/* ── Controls bar ── */}
      <div className="flex items-center gap-4 mb-6">
        <Select
          value={recruiterFilter}
          onValueChange={(val) => setRecruiterFilter(val as RecruiterFilter)}
        >
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Filter by recruiter" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Recruiters</SelectItem>
            <SelectItem value="ashley">Ashley</SelectItem>
            <SelectItem value="nancy">Nancy</SelectItem>
            <SelectItem value="chris">Chris</SelectItem>
          </SelectContent>
        </Select>

        <Button variant="outline" size="sm" onClick={fetchProjects} disabled={projectsLoading}>
          {projectsLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
          Refresh
        </Button>
      </div>

      {/* ── Loading ── */}
      {(accountsLoading || projectsLoading) && projects.length === 0 && (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin mr-2" />
          Loading projects…
        </div>
      )}

      {/* ── Empty state ── */}
      {!accountsLoading && !projectsLoading && projects.length === 0 && (
        <div className="text-center py-20 text-muted-foreground">
          No hiring projects found. Make sure your LinkedIn Recruiter accounts are connected.
        </div>
      )}

      {/* ── Projects list ── */}
      <div className="space-y-2">
        {projects.map((project) => {
          const isExpanded = expandedProjectId === project.id;
          const label = projectLabels[project.id] || 'candidate';
          const jobId = projectJobs[project.id];

          return (
            <div key={project.id} className="border border-border rounded-lg overflow-hidden">
              {/* Project header */}
              <div className="flex items-center gap-3 px-4 py-3 bg-card hover:bg-accent/5 transition-colors">
                {/* Expand toggle */}
                <button
                  onClick={() => toggleProject(project)}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>

                {/* Title + meta */}
                <button
                  onClick={() => toggleProject(project)}
                  className="flex-1 text-left min-w-0"
                >
                  <div className="font-medium text-sm truncate">{project.title}</div>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                    <span>{project.recruiter}</span>
                    {project.applicant_count != null && (
                      <>
                        <span>·</span>
                        <span>{project.applicant_count} applicant{project.applicant_count !== 1 ? 's' : ''}</span>
                      </>
                    )}
                    {project.created_at && (
                      <>
                        <span>·</span>
                        <span>{new Date(project.created_at).toLocaleDateString()}</span>
                      </>
                    )}
                  </div>
                </button>

                {/* Candidate / Contact toggle */}
                <div className="flex items-center bg-muted rounded-md p-0.5 shrink-0">
                  <button
                    onClick={() => setProjectLabels(prev => ({ ...prev, [project.id]: 'candidate' }))}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                      label === 'candidate' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <UserCheck className="h-3 w-3" />
                    Candidate
                  </button>
                  <button
                    onClick={() => setProjectLabels(prev => ({ ...prev, [project.id]: 'contact' }))}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                      label === 'contact' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Contact className="h-3 w-3" />
                    Contact
                  </button>
                </div>

                {/* Job picker (only for candidate label) */}
                {label === 'candidate' && (
                  <Select
                    value={jobId || ''}
                    onValueChange={(val) => setProjectJobs(prev => ({ ...prev, [project.id]: val }))}
                  >
                    <SelectTrigger className="w-52 shrink-0">
                      <div className="flex items-center gap-1.5 truncate">
                        <Briefcase className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <SelectValue placeholder="Select job…" />
                      </div>
                    </SelectTrigger>
                    <SelectContent>
                      {warmHotJobs.length === 0 && (
                        <div className="px-3 py-2 text-sm text-muted-foreground">No warm/hot jobs</div>
                      )}
                      {warmHotJobs.map((job: any) => (
                        <SelectItem key={job.id} value={job.id}>
                          <span className="truncate">{job.title} — {job.company}</span>
                          <Badge variant="outline" className="ml-2 text-[10px]">{job.stage}</Badge>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {/* Expanded: Applicants */}
              {isExpanded && (
                <div className="border-t border-border bg-background">
                  {/* Bulk action bar */}
                  {selectedApplicantIds.size > 0 && (
                    <div className="flex items-center gap-3 px-4 py-2 bg-accent/10 border-b border-border">
                      <span className="text-sm text-muted-foreground">
                        {selectedApplicantIds.size} selected
                      </span>
                      {expandedLabel === 'candidate' ? (
                        <Button
                          size="sm"
                          variant="gold"
                          onClick={() => {
                            if (!expandedJobId) {
                              toast.error('Please select a job for this project first');
                              return;
                            }
                            setCandidateDialogOpen(true);
                          }}
                        >
                          <UserCheck className="h-3.5 w-3.5 mr-1" />
                          Import as Candidates
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="gold"
                          onClick={() => setContactDialogOpen(true)}
                        >
                          <Contact className="h-3.5 w-3.5 mr-1" />
                          Import as Contacts
                        </Button>
                      )}
                    </div>
                  )}

                  {/* Loading */}
                  {applicantsLoading && (
                    <div className="flex items-center justify-center py-10 text-muted-foreground">
                      <Loader2 className="h-5 w-5 animate-spin mr-2" />
                      Loading applicants…
                    </div>
                  )}

                  {/* Empty */}
                  {!applicantsLoading && applicants.length === 0 && (
                    <div className="text-center py-10 text-muted-foreground text-sm">
                      No applicants found in this project
                    </div>
                  )}

                  {/* Applicants grouped by stage */}
                  {!applicantsLoading && sortedStages.map((stage) => (
                    <div key={stage}>
                      <div className="flex items-center gap-2 px-4 py-2 bg-muted/30 border-b border-border">
                        <Badge className={STAGE_COLORS[stage] || STAGE_COLORS.unknown}>
                          {stage.charAt(0).toUpperCase() + stage.slice(1)}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {applicantsByStage[stage].length} applicant{applicantsByStage[stage].length !== 1 ? 's' : ''}
                        </span>
                      </div>

                      <table className="w-full">
                        <thead>
                          <tr className="border-b border-border text-xs text-muted-foreground">
                            <th className="w-10 px-4 py-2 text-left">
                              <button onClick={toggleAllApplicants} className="hover:text-foreground">
                                {selectedApplicantIds.size === applicants.length && applicants.length > 0
                                  ? <CheckSquare className="h-3.5 w-3.5" />
                                  : <Square className="h-3.5 w-3.5" />
                                }
                              </button>
                            </th>
                            <th className="px-2 py-2 text-left">Name</th>
                            <th className="px-2 py-2 text-left">Title</th>
                            <th className="px-2 py-2 text-left">Company</th>
                            <th className="px-2 py-2 text-left">Location</th>
                            <th className="w-10 px-2 py-2 text-center" title="Resume">
                              <FileText className="h-3.5 w-3.5 inline" />
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {applicantsByStage[stage].map((applicant) => (
                            <tr
                              key={applicant.id}
                              className="border-b border-border/50 hover:bg-accent/5 text-sm"
                            >
                              <td className="px-4 py-2">
                                <button onClick={() => toggleApplicant(applicant.id)}>
                                  {selectedApplicantIds.has(applicant.id)
                                    ? <CheckSquare className="h-3.5 w-3.5 text-primary" />
                                    : <Square className="h-3.5 w-3.5 text-muted-foreground" />
                                  }
                                </button>
                              </td>
                              <td className="px-2 py-2">
                                <div className="flex items-center gap-2">
                                  {applicant.profile_picture_url ? (
                                    <img
                                      src={applicant.profile_picture_url}
                                      alt=""
                                      className="h-6 w-6 rounded-full object-cover shrink-0"
                                    />
                                  ) : (
                                    <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center text-[10px] font-medium shrink-0">
                                      {(applicant.first_name?.[0] || '') + (applicant.last_name?.[0] || '')}
                                    </div>
                                  )}
                                  <span className="font-medium truncate">
                                    {applicant.first_name} {applicant.last_name}
                                  </span>
                                </div>
                              </td>
                              <td className="px-2 py-2 text-muted-foreground truncate max-w-[200px]">
                                {applicant.current_title}
                              </td>
                              <td className="px-2 py-2 text-muted-foreground truncate max-w-[160px]">
                                {applicant.current_company}
                              </td>
                              <td className="px-2 py-2 text-muted-foreground truncate max-w-[140px]">
                                {applicant.location}
                              </td>
                              <td className="px-2 py-2 text-center">
                                {applicant.has_resume && (
                                  <FileText className="h-3.5 w-3.5 inline text-emerald-500" title="Has resume" />
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Dialogs ── */}
      <BulkAddCandidatesDialog
        open={candidateDialogOpen}
        onOpenChange={setCandidateDialogOpen}
        applicants={selectedApplicants}
        jobId={expandedJobId || ''}
        jobName={warmHotJobs.find((j: any) => j.id === expandedJobId)?.title || ''}
        project={expandedProject || null}
      />

      <BulkAddContactsDialog
        open={contactDialogOpen}
        onOpenChange={setContactDialogOpen}
        applicants={selectedApplicants}
        project={expandedProject || null}
      />
    </MainLayout>
  );
}
