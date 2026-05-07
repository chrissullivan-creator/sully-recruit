import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
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
import { HorizontalTableScroll } from '@/components/shared/HorizontalTableScroll';
import {
  Loader2, ArrowLeft, Users, UserCheck, Contact,
  FileText, CheckSquare, Square, Briefcase,
  ChevronLeft, ChevronRight,
} from 'lucide-react';

const PAGE_SIZE = 25;

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type ProjectLabel = 'candidate' | 'contact';

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

function normalizeApplicant(raw: any): Applicant {
  // v2 talent-pool applicant shape mostly mirrors v1 but renames a few
  // fields. Read both so we keep working if Unipile flips the response
  // shape mid-deploy or one stage of the pipeline still returns the
  // legacy keys.
  const display =
    raw.display_name ||
    [raw.first_name || raw.firstName, raw.last_name || raw.lastName].filter(Boolean).join(" ");
  const [firstFromDisplay, ...restFromDisplay] = (display || "").split(/\s+/);
  const work = (raw.work_experience && raw.work_experience[0]) || raw.work_experience || {};

  return {
    ...raw,
    id: raw.candidate_id || raw.applicant_id || raw.id || raw.urn || `app-${Math.random()}`,
    first_name: raw.first_name || raw.firstName || firstFromDisplay || '',
    last_name: raw.last_name || raw.lastName || restFromDisplay.join(' ') || '',
    headline: raw.headline || '',
    current_title:
      raw.current_title || raw.title || work?.job_title || work?.role || raw.headline || '',
    current_company:
      raw.current_company || raw.company || work?.company?.name || work?.company || raw.company_name || '',
    location: raw.location || raw.region || '',
    linkedin_url: raw.profile_url || raw.linkedin_url || raw.public_profile_url || raw.url || '',
    profile_picture_url:
      raw.public_picture_url || raw.profile_picture_url || raw.picture_url || raw.avatar_url || '',
    // Backend already canonicalised stage; keep that. pipeline_stage is
    // the v2 raw column name, kept as a passthrough fallback.
    stage: (raw.stage || raw.pipeline_stage || 'unknown').toLowerCase(),
    has_resume: raw.has_resume ?? raw.resume_available ?? false,
  };
}

const STAGE_ORDER = ['uncontacted', 'contacted', 'replied', 'in_review', 'offer', 'hired', 'rejected', 'unknown'];
const STAGE_COLORS: Record<string, string> = {
  uncontacted: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  contacted: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  replied: 'bg-green-500/10 text-green-400 border-green-500/20',
  in_review: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  offer: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  hired: 'bg-success/10 text-success border-success/20',
  rejected: 'bg-red-500/10 text-red-400 border-red-500/20',
  unknown: 'bg-muted text-muted-foreground border-border',
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function SourceProject() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: allJobs = [] } = useJobs();
  const openJobs = allJobs.filter((j: any) => j.status !== 'closed_lost' && j.status !== 'closed_won');

  // State from URL search params
  const params = new URLSearchParams(window.location.search);
  const accountId = params.get('account_id') || '';
  const projectTitle = decodeURIComponent(params.get('title') || 'Project');
  const recruiterName = decodeURIComponent(params.get('recruiter') || '');

  // ---- State ----
  const [applicants, setApplicants] = useState<Applicant[]>([]);
  const [projectData, setProjectData] = useState<any>(null);
  const [debug, setDebug] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [label, setLabel] = useState<ProjectLabel>('candidate');
  const [jobId, setJobId] = useState('');

  // ---- Dialogs ----
  const [candidateDialogOpen, setCandidateDialogOpen] = useState(false);
  const [contactDialogOpen, setContactDialogOpen] = useState(false);

  // ---- Per-stage pagination (25/page so "select all on this page" stays sane) ----
  const [stagePages, setStagePages] = useState<Record<string, number>>({});
  const pageOf = (stage: string) => stagePages[stage] ?? 0;
  const setPageOf = (stage: string, page: number) =>
    setStagePages((prev) => ({ ...prev, [stage]: page }));

  // ---- Load project detail + applicants ----
  const fetchProject = useCallback(async () => {
    // Guards: if id or account_id are missing, surface that instead of hanging
    // on the loading spinner forever. Both come from the URL — if the user
    // navigated here without query params we want them to see why.
    if (!id || !accountId) {
      setLoading(false);
      if (!accountId) toast.error('Missing account_id in URL — open this project from the Source list.');
      return;
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { setLoading(false); return; }

    setLoading(true);
    try {
      const data = await callSourceApi({
        action: 'list_applicants',
        account_id: accountId,
        job_id: id,
      }, session);

      setProjectData(data.project || null);
      setDebug(data.debug || null);
      const items = data.items || [];
      setApplicants((Array.isArray(items) ? items : []).map(normalizeApplicant));
    } catch (err: any) {
      console.error('Failed to load project', err);
      toast.error(err.message || 'Failed to load project');
    } finally {
      setLoading(false);
    }
  }, [id, accountId]);

  useEffect(() => { fetchProject(); }, [fetchProject]);

  // ---- Resume download ----
  const handleDownloadResume = async (applicant: Applicant) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    try {
      const data = await callSourceApi({
        action: 'download_resume',
        account_id: accountId,
        job_id: id,
        applicant_id: applicant.id,
      }, session);
      if (data.data_base64) {
        const contentType = data.content_type || 'application/pdf';
        const bytes = Uint8Array.from(atob(data.data_base64), c => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: contentType });
        window.open(URL.createObjectURL(blob), '_blank');
      } else {
        toast.error('No resume data returned');
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to download resume');
    }
  };

  // ---- Selection helpers ----
  const toggleApplicant = (appId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(appId)) next.delete(appId); else next.add(appId);
      return next;
    });
  };

  const toggleStageApplicants = (stageApplicants: Applicant[]) => {
    const stageIds = stageApplicants.map(a => a.id);
    const allSelected = stageIds.every(appId => selectedIds.has(appId));
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (allSelected) stageIds.forEach(appId => next.delete(appId));
      else stageIds.forEach(appId => next.add(appId));
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === applicants.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(applicants.map(a => a.id)));
  };

  // ---- Group by stage ----
  const byStage = applicants.reduce<Record<string, Applicant[]>>((acc, a) => {
    const stage = a.stage || 'unknown';
    if (!acc[stage]) acc[stage] = [];
    acc[stage].push(a);
    return acc;
  }, {});
  const sortedStages = Object.keys(byStage).sort(
    (a, b) => (STAGE_ORDER.indexOf(a) === -1 ? 99 : STAGE_ORDER.indexOf(a)) -
              (STAGE_ORDER.indexOf(b) === -1 ? 99 : STAGE_ORDER.indexOf(b))
  );

  const selectedApplicants = applicants.filter(a => selectedIds.has(a.id));
  const project = { id: id || '', account_id: accountId };

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */
  return (
    <MainLayout>
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="sm" onClick={() => navigate('/source')}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold truncate">{projectTitle}</h1>
          <p className="text-sm text-muted-foreground">
            {recruiterName}{applicants.length > 0 ? ` · ${applicants.length} applicant${applicants.length !== 1 ? 's' : ''}` : ''}
          </p>
        </div>
      </div>

      {/* Controls bar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        {/* Candidate / Contact dropdown */}
        <Select value={label} onValueChange={(val) => setLabel(val as ProjectLabel)}>
          <SelectTrigger className="w-44">
            <div className="flex items-center gap-1.5">
              {label === 'candidate'
                ? <UserCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                : <Contact className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              }
              <SelectValue />
            </div>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="candidate">Candidate</SelectItem>
            <SelectItem value="contact">Contact</SelectItem>
          </SelectContent>
        </Select>

        {/* Job picker (candidate mode) */}
        {label === 'candidate' && (
          <Select value={jobId} onValueChange={setJobId}>
            <SelectTrigger className="w-64">
              <div className="flex items-center gap-1.5 truncate">
                <Briefcase className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <SelectValue placeholder="Tag to job…" />
              </div>
            </SelectTrigger>
            <SelectContent>
              {openJobs.length === 0 && (
                <div className="px-3 py-2 text-sm text-muted-foreground">No open jobs</div>
              )}
              {openJobs.map((job: any) => (
                <SelectItem key={job.id} value={job.id}>
                  <span className="truncate">{job.title} — {job.company_name}</span>
                  <Badge variant="outline" className="ml-2 text-[10px]">{job.status}</Badge>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Bulk actions */}
        {selectedIds.size > 0 && (
          <>
            <div className="h-6 w-px bg-border" />
            <button onClick={toggleAll} className="text-xs text-muted-foreground hover:text-foreground underline">
              {selectedIds.size === applicants.length ? 'Deselect all' : 'Select all'}
            </button>
            <span className="text-sm text-muted-foreground">{selectedIds.size} selected</span>
            {label === 'candidate' ? (
              <Button
                size="sm"
                variant="gold"
                onClick={() => {
                  if (!jobId) { toast.error('Please select a job first'); return; }
                  setCandidateDialogOpen(true);
                }}
              >
                <UserCheck className="h-3.5 w-3.5 mr-1" />
                Import as Candidates
              </Button>
            ) : (
              <Button size="sm" variant="gold" onClick={() => setContactDialogOpen(true)}>
                <Contact className="h-3.5 w-3.5 mr-1" />
                Import as Contacts
              </Button>
            )}
          </>
        )}
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin mr-2" />
          Loading applicants…
        </div>
      )}

      {/* Empty */}
      {!loading && applicants.length === 0 && (
        <div className="text-center py-20 text-muted-foreground space-y-3">
          <p>No applicants found in this project.</p>
          {debug?.tries && (
            <details className="mt-4 max-w-2xl mx-auto text-left text-xs">
              <summary className="cursor-pointer text-amber-700 underline">
                Show endpoint diagnostics ({debug.tries.length} attempted)
              </summary>
              <pre className="mt-2 bg-muted/40 p-3 rounded overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(debug.tries, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Pipeline stages */}
      {!loading && sortedStages.length > 0 && (
        <div className="space-y-6">
          {/* Stage summary cards */}
          <div className="flex gap-3 flex-wrap">
            {sortedStages.map((stage) => (
              <div
                key={stage}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border ${STAGE_COLORS[stage] || STAGE_COLORS.unknown}`}
              >
                <span className="font-medium text-sm capitalize">{stage}</span>
                <span className="text-lg font-bold">{byStage[stage].length}</span>
              </div>
            ))}
          </div>

          {/* Applicant tables by stage */}
          {sortedStages.map((stage) => {
            const stageApplicants = byStage[stage];
            const totalPages = Math.max(1, Math.ceil(stageApplicants.length / PAGE_SIZE));
            const currentPage = Math.min(pageOf(stage), totalPages - 1);
            const start = currentPage * PAGE_SIZE;
            const visible = stageApplicants.slice(start, start + PAGE_SIZE);

            return (
            <div key={stage} className="border border-border rounded-lg overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 bg-card border-b border-border">
                <Badge className={STAGE_COLORS[stage] || STAGE_COLORS.unknown}>
                  {stage.charAt(0).toUpperCase() + stage.slice(1)}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  {stageApplicants.length} applicant{stageApplicants.length !== 1 ? 's' : ''}
                  {stageApplicants.length > PAGE_SIZE && (
                    <> · page {currentPage + 1} of {totalPages}</>
                  )}
                </span>
              </div>

              <HorizontalTableScroll minWidth={1100}>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="w-10 px-4 py-2 text-left">
                      <button
                        onClick={() => toggleStageApplicants(visible)}
                        className="hover:text-foreground"
                        title={`Select all on this page (${visible.length})`}
                      >
                        {visible.length > 0 && visible.every(a => selectedIds.has(a.id))
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
                  {visible.map((applicant) => (
                    <tr key={applicant.id} className="border-b border-border/50 hover:bg-accent/5 text-sm">
                      <td className="px-4 py-2">
                        <button onClick={() => toggleApplicant(applicant.id)}>
                          {selectedIds.has(applicant.id)
                            ? <CheckSquare className="h-3.5 w-3.5 text-primary" />
                            : <Square className="h-3.5 w-3.5 text-muted-foreground" />
                          }
                        </button>
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-2">
                          {applicant.profile_picture_url ? (
                            <img src={applicant.profile_picture_url} alt="" className="h-7 w-7 rounded-full object-cover shrink-0" />
                          ) : (
                            <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center text-[10px] font-medium shrink-0">
                              {(applicant.first_name?.[0] || '') + (applicant.last_name?.[0] || '')}
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="font-medium truncate">{applicant.first_name} {applicant.last_name}</div>
                            {applicant.headline && applicant.headline !== applicant.current_title && (
                              <div className="text-xs text-muted-foreground truncate">{applicant.headline}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-2 text-muted-foreground truncate max-w-[200px]">{applicant.current_title}</td>
                      <td className="px-2 py-2 text-muted-foreground truncate max-w-[160px]">{applicant.current_company}</td>
                      <td className="px-2 py-2 text-muted-foreground truncate max-w-[140px]">{applicant.location}</td>
                      <td className="px-2 py-2 text-center">
                        {applicant.has_resume && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDownloadResume(applicant); }}
                            className="hover:text-emerald-400 transition-colors"
                            title="View resume"
                          >
                            <FileText className="h-3.5 w-3.5 inline text-emerald-500" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </HorizontalTableScroll>

              {totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-card/50 text-xs text-muted-foreground">
                  <span>
                    Showing {start + 1}–{Math.min(start + PAGE_SIZE, stageApplicants.length)} of {stageApplicants.length}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      disabled={currentPage === 0}
                      onClick={() => setPageOf(stage, currentPage - 1)}
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </Button>
                    <span className="px-2">{currentPage + 1} / {totalPages}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      disabled={currentPage >= totalPages - 1}
                      onClick={() => setPageOf(stage, currentPage + 1)}
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
          })}
        </div>
      )}

      {/* Dialogs */}
      <BulkAddCandidatesDialog
        open={candidateDialogOpen}
        onOpenChange={setCandidateDialogOpen}
        applicants={selectedApplicants}
        jobId={jobId}
        jobName={openJobs.find((j: any) => j.id === jobId)?.title || ''}
        project={project}
      />
      <BulkAddContactsDialog
        open={contactDialogOpen}
        onOpenChange={setContactDialogOpen}
        applicants={selectedApplicants}
        project={project}
      />
    </MainLayout>
  );
}
