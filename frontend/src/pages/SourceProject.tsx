import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useJobs } from '@/hooks/useData';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BulkAddCandidatesDialog } from '@/components/source/BulkAddCandidatesDialog';
import { BulkAddContactsDialog } from '@/components/source/BulkAddContactsDialog';
import { LocationCombobox, type LocationOption } from '@/components/source/LocationCombobox';
import { HorizontalTableScroll } from '@/components/shared/HorizontalTableScroll';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EnrollInSequenceDialog } from '@/components/candidates/EnrollInSequenceDialog';
import {
  Loader2, ArrowLeft, Users, UserCheck, Contact,
  FileText, CheckSquare, Square, Briefcase,
  ChevronLeft, ChevronRight, Search as SearchIcon, MapPin,
  Bookmark, Download, CheckCircle2, ExternalLink, Import,
  Linkedin, Trash2, Plus, MoreHorizontal, ListPlus, Send,
} from 'lucide-react';

const PAGE_SIZE = 25;

/** A person already in the CRM, matched to a LinkedIn profile by slug. */
type CrmMatch = { id: string; type: 'candidate' | 'client'; full_name: string };

/** Extract the LinkedIn vanity slug from a profile URL (the stable key we
 *  match people on — same basis as the linkedin_url dedupe in
 *  save-to-pipeline / the bulk importers). Returns null for non-URLs / URNs. */
function slugOf(url?: string | null): string | null {
  if (!url) return null;
  const m = String(url).match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : null;
}

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
  // Unipile v2 returns several shapes depending on the endpoint:
  // - list_pipeline:        { object: 'PipelineCandidate', profile: {...} }
  // - list_job_applicants:  { object: 'JobApplicant', id, applied_at, has_resume, profile: {...} }
  // - search_people:        { object: 'PeopleSearchResult', ...profile fields at top level }
  // Collapse all three into one flat shape so the UI doesn't care.
  const profile = (raw && typeof raw === 'object' && raw.profile && typeof raw.profile === 'object')
    ? raw.profile
    : raw;

  const display =
    profile.display_name ||
    [profile.first_name || profile.firstName, profile.last_name || profile.lastName].filter(Boolean).join(' ');
  const [firstFromDisplay, ...restFromDisplay] = (display || '').split(/\s+/);
  const work = (profile.work_experience && profile.work_experience[0]) || profile.work_experience || {};

  // Stage normalisation: backend may have set a canonical .stage on the
  // outer object (pipeline route does this). Otherwise pull pipeline_stage
  // off the hiring_project nested object that LinkedIn returns.
  const rawStage = String(
    raw.stage
      ?? raw.pipeline_stage
      ?? raw.hiring_project?.pipeline_stage
      ?? profile.hiring_project?.pipeline_stage
      ?? 'unknown'
  ).toLowerCase().replace(/_/g, ' ');
  let stage = 'unknown';
  if (rawStage.includes('applied') || rawStage.includes('new') || rawStage.includes('uncontact')) stage = 'uncontacted';
  else if (rawStage.includes('contact') || rawStage.includes('reach') || rawStage.includes('sent') || rawStage.includes('inmail')) stage = 'contacted';
  else if (rawStage.includes('reply') || rawStage.includes('respond') || rawStage.includes('interest')) stage = 'replied';
  else if (rawStage.includes('screen') || rawStage.includes('interview') || rawStage.includes('review')) stage = 'in_review';
  else if (rawStage.includes('offer')) stage = 'offer';
  else if (rawStage.includes('hired') || rawStage.includes('place')) stage = 'hired';
  else if (rawStage.includes('reject') || rawStage.includes('decline') || rawStage.includes('withdrawn')) stage = 'rejected';

  return {
    ...profile,
    // Job-applicant top-level fields the UI also wants:
    applied_at: raw.applied_at || raw.appliedAt || undefined,
    has_resume: raw.has_resume ?? profile.has_resume ?? false,

    id: profile.candidate_id || profile.applicant_id || raw.id || profile.id || profile.urn || `app-${Math.random()}`,
    // Provider URN (profile.id, e.g. "AEMAA…") — the id the v2 talent-pool
    // detail/resume sub-endpoints require (NOT candidate_id / JobApplicant id).
    provider_id: profile.id || profile.provider_id || profile.urn || raw.profile?.id || undefined,
    first_name: profile.first_name || profile.firstName || firstFromDisplay || '',
    last_name: profile.last_name || profile.lastName || restFromDisplay.join(' ') || '',
    headline: profile.headline || '',
    current_title:
      profile.current_title || profile.title || work?.job_title || work?.role || profile.headline || '',
    current_company:
      profile.current_company || profile.company || work?.company?.name || work?.company || profile.company_name || '',
    location: profile.location || profile.region || '',
    linkedin_url: profile.profile_url || profile.linkedin_url || profile.public_profile_url || profile.url || '',
    profile_picture_url:
      profile.public_picture_url || profile.profile_picture_url || profile.picture_url || profile.avatar_url || '',
    network_distance: profile.network_distance,
    stage,
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

/* Internal sourcing funnel — OUR stages, aligned to LinkedIn Recruiter's
 * pipeline (Uncontacted → Contacted → Replied, plus our "Back of Resume"
 * present stage). The `sourcing` table auto-advances these from message /
 * call / meeting activity (incl. LinkedIn), so the funnel stays in step with
 * outreach. LinkedIn's own pipeline is read-only via the API, so we mirror
 * inbound activity but can't write a stage back to LinkedIn. */
type SourcingStage = 'uncontacted' | 'contacted' | 'replied' | 'back_of_resume';
const SOURCING_STAGES: { key: SourcingStage; label: string }[] = [
  { key: 'uncontacted', label: 'Uncontacted' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'replied', label: 'Replied' },
  { key: 'back_of_resume', label: 'Back of Resume' },
];
const SOURCING_STAGE_COLORS: Record<SourcingStage, string> = {
  uncontacted: STAGE_COLORS.uncontacted,
  contacted: STAGE_COLORS.contacted,
  replied: STAGE_COLORS.replied,
  back_of_resume: STAGE_COLORS.in_review,
};
interface SourcingPerson {
  id: string; full_name?: string; first_name?: string; last_name?: string;
  current_title?: string; current_company?: string;
  linkedin_current_title?: string; linkedin_current_company?: string;
  location_text?: string; avatar_url?: string; linkedin_url?: string; type?: string;
}
interface SourcingRow {
  id: string; stage: SourcingStage; candidate_id: string; updated_at?: string;
  uncontacted_at?: string | null; contacted_at?: string | null;
  replied_at?: string | null; back_of_resume_at?: string | null;
  person: SourcingPerson | null;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function SourceProject() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: allJobs = [] } = useJobs();
  const openJobs = allJobs.filter((j: any) => j.status !== 'closed_lost' && j.status !== 'filled');

  // State from URL search params
  const params = new URLSearchParams(window.location.search);
  const accountId = params.get('account_id') || '';
  const projectTitle = decodeURIComponent(params.get('title') || 'Project');
  const recruiterName = decodeURIComponent(params.get('recruiter') || '');

  // ---- Tab state ----
  type ProjectTab = 'pipeline' | 'applicants' | 'search';
  const [tab, setTab] = useState<ProjectTab>('pipeline');

  // ---- State (pipeline) ----
  // Pipeline = recruiter-curated saved candidates with stage info.
  const [pipelineCandidates, setPipelineCandidates] = useState<Applicant[]>([]);
  const [pipelineLoading, setPipelineLoading] = useState(true);

  // ---- Internal sourcing pipeline (our funnel; the Pipeline tab renders
  //      this instead of the LinkedIn talent-pool, which carried no stages) ----
  const [sourcingRows, setSourcingRows] = useState<SourcingRow[]>([]);
  const [sourcingLoading, setSourcingLoading] = useState(true);
  const [movingId, setMovingId] = useState<string | null>(null);
  // LinkedIn Recruiter's own pipeline stages (read-only reference bar).
  const [liStages, setLiStages] = useState<{ id: string | null; name: string; candidates_count: number }[]>([]);
  // Link-a-job prompt (shown when the project isn't tied to an internal job).
  const [linkSelectJobId, setLinkSelectJobId] = useState('');
  const [linkingProject, setLinkingProject] = useState(false);

  // ---- State (job applicants) ----
  // Applicants = people who applied to the linked job posting, newest first.
  const [jobApplicants, setJobApplicants] = useState<Applicant[]>([]);
  const [applicantsLoading, setApplicantsLoading] = useState(false);
  const [applicantsLoaded, setApplicantsLoaded] = useState(false);

  // ---- State (project header + diagnostics) ----
  const [projectData, setProjectData] = useState<any>(null);
  const [debug, setDebug] = useState<any>(null);

  // ---- State (search tab) ----
  const [searchKeywords, setSearchKeywords] = useState('');
  const [searchTitle, setSearchTitle] = useState('');
  const [searchCompany, setSearchCompany] = useState('');
  const [searchLocation, setSearchLocation] = useState<LocationOption | null>(null);
  const [searchResults, setSearchResults] = useState<Applicant[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchTotal, setSearchTotal] = useState<number | null>(null);

  // ---- Selection (pipeline view) ----
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // In-Sully pipeline actions: enroll the pipeline person in a Sully sequence.
  // (LinkedIn's own pipeline is read-only via the API, but these people are real
  // CRM candidates, so we can act on them in Sully.)
  const [enrollState, setEnrollState] = useState<{ ids: string[]; names: string[] } | null>(null);
  const [label, setLabel] = useState<ProjectLabel>('candidate');
  const [jobId, setJobId] = useState('');

  // ---- Dialogs ----
  const [candidateDialogOpen, setCandidateDialogOpen] = useState(false);
  const [contactDialogOpen, setContactDialogOpen] = useState(false);

  // ---- Resume viewer ----
  const [resumeView, setResumeView] = useState<{
    open: boolean;
    blobUrl: string | null;
    contentType: string;
    applicantName: string;
    loading: boolean;
  }>({ open: false, blobUrl: null, contentType: '', applicantName: '', loading: false });

  // ---- Per-stage pagination (25/page so "select all on this page" stays sane) ----
  const [stagePages, setStagePages] = useState<Record<string, number>>({});
  const pageOf = (stage: string) => stagePages[stage] ?? 0;
  const setPageOf = (stage: string, page: number) =>
    setStagePages((prev) => ({ ...prev, [stage]: page }));

  // ---- "Already in CRM" matching ----------------------------------------
  // For every LinkedIn person we display, look up whether they already exist
  // in the unified people table (matched by LinkedIn slug — the same
  // linkedin_url basis save-to-pipeline / the bulk importers dedupe on) so we
  // can badge them + link to the record instead of offering a duplicate add.
  // Accumulates across tabs; keyed by slug.
  const [crmMatches, setCrmMatches] = useState<Record<string, CrmMatch>>({});
  const [savingClientId, setSavingClientId] = useState<string | null>(null);

  const refreshCrmMatches = useCallback(async (list: Applicant[]) => {
    const slugs = [...new Set(list.map((a) => slugOf(a.linkedin_url)).filter(Boolean))] as string[];
    if (slugs.length === 0) return;
    const found: Record<string, CrmMatch> = {};
    for (let i = 0; i < slugs.length; i += 25) {
      const chunk = slugs.slice(i, i + 25);
      const orFilter = chunk.map((s) => `linkedin_url.ilike.%/${s}%`).join(',');
      const { data } = await supabase
        .from('people')
        .select('id, full_name, type, roles, linkedin_url')
        .or(orFilter)
        .is('deleted_at', null);
      for (const p of (data ?? []) as any[]) {
        // Re-derive the slug from the stored URL and key on the EXACT slug, so
        // an over-broad ilike (e.g. /john vs /john-doe) can't mis-match.
        const s = slugOf(p.linkedin_url);
        if (!s) continue;
        const roles: string[] = Array.isArray(p.roles) ? p.roles : [];
        const isClient = p.type === 'client' || (roles.includes('client') && !roles.includes('candidate'));
        found[s] = { id: p.id, type: isClient ? 'client' : 'candidate', full_name: p.full_name || '' };
      }
    }
    if (Object.keys(found).length > 0) setCrmMatches((prev) => ({ ...prev, ...found }));
  }, []);

  const crmMatchFor = useCallback(
    (a: Applicant): CrmMatch | null => {
      const s = slugOf(a.linkedin_url);
      return s ? (crmMatches[s] ?? null) : null;
    },
    [crmMatches],
  );

  // Add a LinkedIn person to the CRM as a CLIENT (the candidate path is the
  // existing "Save" → save-to-pipeline). Reuses /api/add-person, which routes
  // the role + classifies email/photo/headline server-side.
  const handleSaveClient = useCallback(async (a: Applicant) => {
    setSavingClientId(a.id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { toast.error('Not authenticated'); return; }
      const resp = await fetch('/api/add-person', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'contact',
          data: {
            first_name: a.first_name,
            last_name: a.last_name,
            title: a.current_title || a.headline || '',
            company: a.current_company || '',
            location: a.location || '',
            linkedin_url: a.linkedin_url || '',
            headline: a.headline || '',
            photo: a.profile_picture_url || '',
          },
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `Add failed (${resp.status})`);
      toast.success(data?.merged ? 'Added client role to existing person' : 'Added as client');
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      refreshCrmMatches([a]);
    } catch (err: any) {
      toast.error(err.message || 'Failed to add client');
    } finally {
      setSavingClientId(null);
    }
  }, [queryClient, refreshCrmMatches]);

  // ---- Load pipeline (curated candidates) ----
  const fetchPipeline = useCallback(async () => {
    if (!id || !accountId) {
      setPipelineLoading(false);
      if (!accountId) toast.error('Missing account_id in URL — open this project from the Source list.');
      return;
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { setPipelineLoading(false); return; }

    setPipelineLoading(true);
    try {
      const data = await callSourceApi({
        action: 'list_pipeline',
        account_id: accountId,
        job_id: id,
      }, session);
      setProjectData(data.project || null);
      setDebug(data.debug || null);
      const items = data.items || [];
      const norm = (Array.isArray(items) ? items : []).map(normalizeApplicant);
      setPipelineCandidates(norm);
      refreshCrmMatches(norm);
    } catch (err: any) {
      console.error('Failed to load pipeline', err);
      toast.error(err.message || 'Failed to load pipeline');
    } finally {
      setPipelineLoading(false);
    }
  }, [id, accountId, refreshCrmMatches]);

  // ---- Load job applicants (lazy on tab activation) ----
  const fetchJobApplicants = useCallback(async () => {
    if (!id || !accountId) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    setApplicantsLoading(true);
    try {
      const data = await callSourceApi({
        action: 'list_job_applicants',
        account_id: accountId,
        job_id: id,
      }, session);
      if (!projectData && data.project) setProjectData(data.project);
      const items = data.items || [];
      const norm = (Array.isArray(items) ? items : []).map(normalizeApplicant);
      setJobApplicants(norm);
      setApplicantsLoaded(true);
      refreshCrmMatches(norm);
    } catch (err: any) {
      console.error('Failed to load applicants', err);
      toast.error(err.message || 'Failed to load applicants');
    } finally {
      setApplicantsLoading(false);
    }
  }, [id, accountId, projectData, refreshCrmMatches]);

  // Pipeline tab now renders the internal `sourcing` funnel (see effects
  // below), not the LinkedIn talent-pool. fetchPipeline is retained for
  // reference/diagnostics but no longer auto-runs.

  // ---- Save-to-Pipeline orchestration ----
  // The project may already be linked to an internal job (via
  // jobs.linkedin_project_id). When linked, Save is one click. When not,
  // the first Save opens a job picker that persists the link for future
  // applicants on this project.
  const [linkedJobId, setLinkedJobId] = useState<string | null>(null);
  const [linkedJobChecked, setLinkedJobChecked] = useState(false);
  const [savingApplicantId, setSavingApplicantId] = useState<string | null>(null);
  const [linkDialogApplicant, setLinkDialogApplicant] = useState<Applicant | null>(null);
  const [linkDialogJobId, setLinkDialogJobId] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!id || !accountId) return;
      const { data } = await supabase
        .from('jobs')
        .select('id')
        .eq('linkedin_project_id', id)
        .eq('linkedin_project_account_id', accountId)
        .maybeSingle();
      if (cancelled) return;
      setLinkedJobId(data?.id || null);
      setLinkedJobChecked(true);
    })();
    return () => { cancelled = true; };
  }, [id, accountId]);

  // ── Internal sourcing pipeline ─────────────────────────────────────
  // The Pipeline tab renders our `sourcing` funnel for the linked job
  // (LinkedIn's own pipeline is read-only via the API). DB triggers auto-bump
  // stages from message/call/meeting activity; here we add manual moves,
  // one-click withdraw, and a best-effort LinkedIn stage reference bar.
  const fetchSourcing = useCallback(async () => {
    if (!linkedJobId) { setSourcingRows([]); setSourcingLoading(false); return; }
    setSourcingLoading(true);
    try {
      const { data: srows, error } = await supabase
        .from('sourcing')
        .select('id, stage, candidate_id, updated_at, uncontacted_at, contacted_at, replied_at, back_of_resume_at')
        .eq('job_id', linkedJobId)
        .is('withdrawn_at', null)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      const rows = (srows ?? []) as any[];
      const ids = [...new Set(rows.map((r) => r.candidate_id).filter(Boolean))] as string[];
      const peopleById: Record<string, SourcingPerson> = {};
      if (ids.length > 0) {
        const { data: ppl } = await supabase
          .from('people')
          .select('id, full_name, first_name, last_name, current_title, current_company, linkedin_current_title, linkedin_current_company, location_text, avatar_url, linkedin_url, type')
          .in('id', ids);
        for (const p of (ppl ?? []) as any[]) peopleById[p.id] = p;
      }
      setSourcingRows(rows.map((r) => ({ ...r, person: peopleById[r.candidate_id] ?? null })));
    } catch (e: any) {
      console.error('Failed to load sourcing pipeline', e);
      toast.error(e.message || 'Failed to load pipeline');
    } finally {
      setSourcingLoading(false);
    }
  }, [linkedJobId]);

  const fetchProjectStages = useCallback(async () => {
    if (!id || !accountId) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    try {
      const data = await callSourceApi({ action: 'get_project', account_id: accountId, job_id: id }, session);
      if (Array.isArray(data?.stages)) setLiStages(data.stages.filter((s: any) => s?.name));
      if (data?.project) setProjectData((prev: any) => prev || data.project);
    } catch { /* best-effort reference bar — never block the pipeline */ }
  }, [id, accountId]);

  const moveSourcing = useCallback(async (row: SourcingRow, toStage: SourcingStage) => {
    if (row.stage === toStage) return;
    setMovingId(row.id);
    const nowIso = new Date().toISOString();
    const order: SourcingStage[] = ['uncontacted', 'contacted', 'replied', 'back_of_resume'];
    const stampCol: Record<SourcingStage, string> = {
      uncontacted: 'uncontacted_at', contacted: 'contacted_at', replied: 'replied_at', back_of_resume: 'back_of_resume_at',
    };
    const toIdx = order.indexOf(toStage);
    const patch: any = { stage: toStage };
    // Stamp the target + backfill missing earlier stamps so funnel times stay
    // monotonic (mirrors the server-side backfill logic).
    order.forEach((st, i) => {
      if (i <= toIdx) {
        const col = stampCol[st];
        if (!(row as any)[col]) patch[col] = nowIso;
      }
    });
    try {
      const { error } = await supabase.from('sourcing').update(patch).eq('id', row.id);
      if (error) throw error;
      setSourcingRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...patch } : r)));
      toast.success(`Moved to ${SOURCING_STAGES.find((s) => s.key === toStage)?.label}`);
    } catch (e: any) {
      toast.error(e.message || 'Move failed');
    } finally {
      setMovingId(null);
    }
  }, []);

  const withdrawSourcing = useCallback(async (row: SourcingRow) => {
    setMovingId(row.id);
    try {
      const { error } = await supabase
        .from('sourcing')
        .update({ withdrawn_at: new Date().toISOString() })
        .eq('id', row.id);
      if (error) throw error;
      setSourcingRows((prev) => prev.filter((r) => r.id !== row.id));
      toast.success('Removed from pipeline');
    } catch (e: any) {
      toast.error(e.message || 'Remove failed');
    } finally {
      setMovingId(null);
    }
  }, []);

  const handleLinkProject = useCallback(async () => {
    if (!linkSelectJobId) return;
    setLinkingProject(true);
    try {
      const { error } = await supabase
        .from('jobs')
        .update({ linkedin_project_id: id, linkedin_project_account_id: accountId })
        .eq('id', linkSelectJobId);
      if (error) throw error;
      setLinkedJobId(linkSelectJobId);
      toast.success('Project linked — pipeline ready');
    } catch (e: any) {
      toast.error(e.message || 'Link failed');
    } finally {
      setLinkingProject(false);
    }
  }, [linkSelectJobId, id, accountId]);

  const callSaveToPipeline = useCallback(async (a: Applicant, jobIdOverride?: string) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { toast.error('Not authenticated'); return null; }
    const resp = await fetch('/api/save-to-pipeline', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        account_id: accountId,
        project_id: id,
        applicant_id: a.id,
        applicant: a,
        has_resume: !!a.has_resume,
        ...(jobIdOverride ? { job_id: jobIdOverride } : {}),
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      if (data?.code === 'PROJECT_NOT_LINKED') return { needsLink: true };
      throw new Error(data?.error || `Save failed (${resp.status})`);
    }
    return data;
  }, [id, accountId]);

  const handleSaveApplicant = useCallback(async (a: Applicant) => {
    setSavingApplicantId(a.id);
    try {
      const result = await callSaveToPipeline(a);
      if (result && (result as any).needsLink) {
        setLinkDialogApplicant(a);
        return;
      }
      toast.success((result as any)?.merged ? 'Added to pipeline (existing candidate)' : 'Added to pipeline · Uncontacted');
      queryClient.invalidateQueries({ queryKey: ['candidates'] });
      refreshCrmMatches([a]);
      fetchSourcing();
    } catch (err: any) {
      toast.error(err.message || 'Save failed');
    } finally {
      setSavingApplicantId(null);
    }
  }, [callSaveToPipeline, queryClient, refreshCrmMatches, fetchSourcing]);

  const confirmLinkJob = useCallback(async () => {
    if (!linkDialogApplicant || !linkDialogJobId) return;
    setSavingApplicantId(linkDialogApplicant.id);
    try {
      const result = await callSaveToPipeline(linkDialogApplicant, linkDialogJobId);
      if (result && !(result as any).needsLink) {
        setLinkedJobId(linkDialogJobId);
        toast.success((result as any)?.merged ? 'Added to pipeline (existing candidate)' : 'Added to pipeline · Uncontacted');
        queryClient.invalidateQueries({ queryKey: ['candidates'] });
        refreshCrmMatches([linkDialogApplicant]);
        fetchSourcing();
        setLinkDialogApplicant(null);
        setLinkDialogJobId('');
      }
    } catch (err: any) {
      toast.error(err.message || 'Save failed');
    } finally {
      setSavingApplicantId(null);
    }
  }, [linkDialogApplicant, linkDialogJobId, callSaveToPipeline, queryClient, refreshCrmMatches, fetchSourcing]);

  // Lazy-load applicants the first time the user opens that tab.
  useEffect(() => {
    if (tab === 'applicants' && !applicantsLoaded && !applicantsLoading) {
      fetchJobApplicants();
    }
  }, [tab, applicantsLoaded, applicantsLoading, fetchJobApplicants]);

  // Load our pipeline once the linked-job lookup resolves; pull LinkedIn's
  // stage reference bar in parallel (best-effort).
  useEffect(() => { if (linkedJobChecked) fetchSourcing(); }, [linkedJobChecked, fetchSourcing]);
  useEffect(() => { fetchProjectStages(); }, [fetchProjectStages]);

  // ---- Search (lazy, on submit only) ----
  const runSearch = async () => {
    if (!accountId) { toast.error('Missing account_id'); return; }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const body: Record<string, any> = {};
    if (searchKeywords.trim()) body.keywords = searchKeywords.trim();
    if (searchTitle.trim()) body.job_title = [{ name: searchTitle.trim() }];
    if (searchCompany.trim()) {
      body.company = searchCompany
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
        .map((name) => ({ name }));
    }

    // Location was already resolved to an ID via the combobox.
    if (searchLocation?.id) {
      body.location = [{ id: searchLocation.id }];
    }

    setSearching(true);
    setSearchResults([]);
    setSearchTotal(null);
    try {
      const data = await callSourceApi({
        action: 'search_people',
        account_id: accountId,
        search: body,
        limit: 25,
      }, session);
      const items = data.items || [];
      const norm = (Array.isArray(items) ? items : []).map(normalizeApplicant);
      setSearchResults(norm);
      setSearchTotal(typeof data.total_count === 'number' ? data.total_count : null);
      refreshCrmMatches(norm);
    } catch (err: any) {
      console.error('Search failed', err);
      toast.error(err.message || 'Search failed');
    } finally {
      setSearching(false);
    }
  };

  // Alias so the existing pipeline view code below keeps working unchanged.
  const applicants = pipelineCandidates;
  const loading = pipelineLoading;

  // ---- Import LinkedIn applicants into the shared `applicants` table ----
  // Keeps the live list on screen; this just persists them (deduped by
  // provider id / linkedin_url) so they also surface in People → Applicants.
  // Resume isn't copied — provider_id is stored for on-demand fetch.
  const [importingApplicants, setImportingApplicants] = useState(false);
  const handleImportApplicants = async () => {
    if (jobApplicants.length === 0) { toast.info('No applicants to import'); return; }
    setImportingApplicants(true);
    try {
      const { data: existing } = await supabase
        .from('applicants' as any)
        .select('provider_id, linkedin_url')
        .eq('source', 'linkedin');
      const existProv = new Set((existing ?? []).map((e: any) => e.provider_id).filter(Boolean));
      const existLi = new Set((existing ?? []).map((e: any) => e.linkedin_url).filter(Boolean));

      const rows = jobApplicants
        .filter((a) => {
          const pid = a.provider_id || a.id;
          if (pid && existProv.has(pid)) return false;
          if (a.linkedin_url && existLi.has(a.linkedin_url)) return false;
          return true;
        })
        .map((a) => {
          const appliedRaw = a.applied_at || (a as any).appliedAt || (a as any).application_date;
          const appliedAt = appliedRaw && !Number.isNaN(new Date(appliedRaw).getTime())
            ? new Date(appliedRaw).toISOString() : null;
          return {
            source: 'linkedin',
            provider_id: a.provider_id || a.id || null,
            job_id: linkedJobId,
            marketing_title_snapshot: projectData?.name ?? null,
            first_name: a.first_name ?? null,
            last_name: a.last_name ?? null,
            linkedin_url: a.linkedin_url ?? null,
            headline: a.headline ?? null,
            current_title: a.current_title ?? null,
            current_company: a.current_company ?? null,
            location: a.location ?? null,
            profile_picture_url: a.profile_picture_url ?? null,
            applied_at: appliedAt,
            status: 'new',
          };
        });

      if (rows.length === 0) { toast.info('All applicants already imported'); return; }
      const { error } = await supabase.from('applicants' as any).insert(rows);
      if (error) throw new Error(error.message);
      toast.success(`Imported ${rows.length} applicant${rows.length === 1 ? '' : 's'} to Applicants`);
      queryClient.invalidateQueries({ queryKey: ['applicants'] });
      queryClient.invalidateQueries({ queryKey: ['applicants_count'] });
    } catch (e: any) {
      toast.error(e.message || 'Import failed');
    } finally {
      setImportingApplicants(false);
    }
  };

  // ---- Resume viewer ----
  const handleDownloadResume = async (applicant: Applicant) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    // Revoke any previous blob URL before fetching a new one to avoid leaks.
    setResumeView((prev) => {
      if (prev.blobUrl) URL.revokeObjectURL(prev.blobUrl);
      return {
        open: true,
        blobUrl: null,
        contentType: '',
        applicantName: applicant.name || 'Applicant',
        loading: true,
      };
    });
    try {
      const data = await callSourceApi({
        action: 'download_resume',
        account_id: accountId,
        job_id: id,
        // v2 resume keys off the profile URN, not candidate_id / applicant id.
        applicant_id: applicant.provider_id || applicant.id,
      }, session);
      if (!data.data_base64) {
        setResumeView((prev) => ({ ...prev, loading: false }));
        toast.error('No resume data returned');
        return;
      }
      const contentType = data.content_type || 'application/pdf';
      const bytes = Uint8Array.from(atob(data.data_base64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: contentType });
      const url = URL.createObjectURL(blob);
      setResumeView({
        open: true,
        blobUrl: url,
        contentType,
        applicantName: applicant.name || 'Applicant',
        loading: false,
      });
    } catch (err: any) {
      setResumeView((prev) => ({ ...prev, loading: false }));
      toast.error(err.message || 'Failed to download resume');
    }
  };

  const closeResumeView = () => {
    setResumeView((prev) => {
      if (prev.blobUrl) URL.revokeObjectURL(prev.blobUrl);
      return { open: false, blobUrl: null, contentType: '', applicantName: '', loading: false };
    });
  };

  // Free the blob URL on unmount so it doesn't leak.
  useEffect(() => {
    return () => {
      if (resumeView.blobUrl) URL.revokeObjectURL(resumeView.blobUrl);
    };
    // Only on unmount — guarded by ref otherwise we'd revoke too eagerly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Group our sourcing rows by stage for the Pipeline tab.
  const bySourcingStage = sourcingRows.reduce<Record<string, SourcingRow[]>>((acc, r) => {
    (acc[r.stage] ||= []).push(r);
    return acc;
  }, {});

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
            {recruiterName}
            {sourcingRows.length > 0 && ` · ${sourcingRows.length} in pipeline`}
            {jobApplicants.length > 0 && ` · ${jobApplicants.length} applicant${jobApplicants.length === 1 ? '' : 's'}`}
          </p>
        </div>
        {linkedJobChecked && (
          linkedJobId
            ? (() => {
                const linked = openJobs.find((j: any) => j.id === linkedJobId);
                return (
                  <Badge
                    variant="outline"
                    className="text-[10px] border-emerald-500/30 text-emerald-500 shrink-0"
                    title={linked?.title ? `Linked to ${linked.title}` : 'Linked to internal job'}
                  >
                    <Briefcase className="h-3 w-3 mr-1" />
                    Linked
                  </Badge>
                );
              })()
            : (
              <Badge
                variant="outline"
                className="text-[10px] text-muted-foreground shrink-0"
                title="First Save will prompt you to pick a job"
              >
                Unlinked
              </Badge>
            )
        )}
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as ProjectTab)} className="mb-4">
        <TabsList>
          <TabsTrigger value="pipeline">
            Pipeline{sourcingRows.length > 0 && <span className="ml-1.5 text-xs text-muted-foreground">({sourcingRows.length})</span>}
          </TabsTrigger>
          <TabsTrigger value="applicants">
            Applicants{applicantsLoaded && jobApplicants.length > 0 && <span className="ml-1.5 text-xs text-muted-foreground">({jobApplicants.length})</span>}
          </TabsTrigger>
          <TabsTrigger value="search">Search</TabsTrigger>
        </TabsList>

        {/* ─── Pipeline tab ───────────────────────────────────────── */}
        <TabsContent value="pipeline" className="mt-4 space-y-4">

      {/* LinkedIn Recruiter's own pipeline — read-only reference. Our funnel
          below mirrors LinkedIn activity inbound; LinkedIn's API doesn't let us
          write a stage back, so this bar is for reference only. */}
      {liStages.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Linkedin className="h-3.5 w-3.5 text-[#0a66c2]" /> LinkedIn Recruiter:
          </span>
          {liStages.map((s, i) => (
            <span key={s.id || `${s.name}-${i}`} className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-card">
              {s.name}
              <span className="font-semibold tabular-nums">{s.candidates_count}</span>
            </span>
          ))}
          <span className="text-muted-foreground/70">· read-only</span>
        </div>
      )}

      {/* Pipeline body — our internal sourcing funnel for the linked job. */}
      {(!linkedJobChecked || sourcingLoading) ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin mr-2" />
          Loading pipeline…
        </div>
      ) : !linkedJobId ? (
        <div className="max-w-md mx-auto text-center py-16 space-y-4">
          <Briefcase className="h-8 w-8 mx-auto text-muted-foreground/60" />
          <div>
            <p className="font-medium">Link this project to a job</p>
            <p className="text-sm text-muted-foreground mt-1">
              Tie this LinkedIn project to a Sully Recruit job to start tracking a stage-by-stage pipeline.
            </p>
          </div>
          <div className="flex items-center gap-2 justify-center">
            <Select value={linkSelectJobId} onValueChange={setLinkSelectJobId}>
              <SelectTrigger className="w-64">
                <div className="flex items-center gap-1.5 truncate">
                  <Briefcase className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <SelectValue placeholder="Choose a job…" />
                </div>
              </SelectTrigger>
              <SelectContent>
                {openJobs.length === 0 && (
                  <div className="px-3 py-2 text-sm text-muted-foreground">No open jobs</div>
                )}
                {openJobs.map((job: any) => (
                  <SelectItem key={job.id} value={job.id}>
                    <span className="truncate">{job.title} — {job.company_name || job.company}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="gold" disabled={!linkSelectJobId || linkingProject} onClick={handleLinkProject}>
              {linkingProject ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Briefcase className="h-3.5 w-3.5 mr-1" />}
              Link
            </Button>
          </div>
        </div>
      ) : sourcingRows.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">No one in this pipeline yet</p>
          <p className="text-sm">
            Add people from the{' '}
            <button className="underline hover:text-foreground" onClick={() => setTab('applicants')}>Applicants</button> or{' '}
            <button className="underline hover:text-foreground" onClick={() => setTab('search')}>Search</button> tab — they enter at Uncontacted.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Stage summary cards */}
          <div className="flex gap-3 flex-wrap">
            {SOURCING_STAGES.map((s) => (
              <div
                key={s.key}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border ${SOURCING_STAGE_COLORS[s.key]}`}
              >
                <span className="font-medium text-sm">{s.label}</span>
                <span className="text-lg font-bold">{(bySourcingStage[s.key] || []).length}</span>
              </div>
            ))}
          </div>

          {/* Per-stage tables */}
          {SOURCING_STAGES.filter((s) => (bySourcingStage[s.key] || []).length > 0).map((s) => {
            const rows = bySourcingStage[s.key] || [];
            return (
              <div key={s.key} className="border border-border rounded-lg overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 bg-card border-b border-border">
                  <Badge className={SOURCING_STAGE_COLORS[s.key]}>{s.label}</Badge>
                  <span className="text-sm text-muted-foreground">
                    {rows.length} {rows.length !== 1 ? 'people' : 'person'}
                  </span>
                </div>
                <HorizontalTableScroll minWidth={1000}>
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-border text-xs text-muted-foreground">
                        <th className="px-4 py-2 text-left">Name</th>
                        <th className="px-2 py-2 text-left">Title</th>
                        <th className="px-2 py-2 text-left">Company</th>
                        <th className="px-2 py-2 text-left">Location</th>
                        <th className="px-2 py-2 text-left w-40">Stage</th>
                        <th className="w-10 px-2 py-2 text-center"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => {
                        const p = row.person;
                        const name = p?.full_name || [p?.first_name, p?.last_name].filter(Boolean).join(' ') || 'Unknown';
                        const title = p?.current_title || p?.linkedin_current_title || '';
                        const company = p?.current_company || p?.linkedin_current_company || '';
                        return (
                          <tr key={row.id} className="border-b border-border/50 hover:bg-accent/5 text-sm">
                            <td className="px-4 py-2">
                              <div className="flex items-center gap-2">
                                {p?.avatar_url ? (
                                  <img src={p.avatar_url} alt="" className="h-7 w-7 rounded-full object-cover shrink-0" />
                                ) : (
                                  <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center text-[10px] font-medium shrink-0">
                                    {(p?.first_name?.[0] || '') + (p?.last_name?.[0] || '')}
                                  </div>
                                )}
                                <Link to={`/candidates/${row.candidate_id}`} className="font-medium truncate hover:underline">
                                  {name}
                                </Link>
                              </div>
                            </td>
                            <td className="px-2 py-2 text-muted-foreground truncate max-w-[200px]">{title}</td>
                            <td className="px-2 py-2 text-muted-foreground truncate max-w-[160px]">{company}</td>
                            <td className="px-2 py-2 text-muted-foreground truncate max-w-[140px]">{p?.location_text}</td>
                            <td className="px-2 py-2">
                              <Select value={row.stage} onValueChange={(v) => moveSourcing(row, v as SourcingStage)} disabled={movingId === row.id}>
                                <SelectTrigger className="h-8 w-36">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {SOURCING_STAGES.map((opt) => (
                                    <SelectItem key={opt.key} value={opt.key}>{opt.label}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </td>
                            <td className="px-2 py-2 text-center">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <button
                                    className="text-muted-foreground hover:text-foreground transition-colors p-1"
                                    title="Actions"
                                  >
                                    <MoreHorizontal className="h-4 w-4 inline" />
                                  </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-48">
                                  <DropdownMenuItem onClick={() => setEnrollState({ ids: [row.candidate_id], names: [name] })}>
                                    <ListPlus className="h-3.5 w-3.5 mr-2" /> Enroll in sequence
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => navigate(`/candidates/${row.candidate_id}/sendout`)}>
                                    <Briefcase className="h-3.5 w-3.5 mr-2" /> Create send-out
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => navigate(`/candidates/${row.candidate_id}`)}>
                                    <Send className="h-3.5 w-3.5 mr-2" /> Open &amp; message
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    onClick={() => withdrawSourcing(row)}
                                    disabled={movingId === row.id}
                                    className="text-red-500 focus:text-red-500"
                                  >
                                    <Trash2 className="h-3.5 w-3.5 mr-2" /> Remove from pipeline
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </HorizontalTableScroll>
              </div>
            );
          })}
        </div>
      )}
        </TabsContent>

        {/* ─── Applicants tab ────────────────────────────────────── */}
        <TabsContent value="applicants" className="mt-4">
          <ApplicantsTab
            loading={applicantsLoading}
            applicants={jobApplicants}
            onDownloadResume={handleDownloadResume}
            onSave={handleSaveApplicant}
            savingId={savingApplicantId}
            getCrmMatch={crmMatchFor}
            onSaveClient={handleSaveClient}
            savingClientId={savingClientId}
            onImport={handleImportApplicants}
            importing={importingApplicants}
          />
        </TabsContent>

        {/* ─── Search tab ────────────────────────────────────────── */}
        <TabsContent value="search" className="mt-4">
          <SearchTab
            keywords={searchKeywords}
            title={searchTitle}
            company={searchCompany}
            location={searchLocation}
            onKeywordsChange={setSearchKeywords}
            onTitleChange={setSearchTitle}
            onCompanyChange={setSearchCompany}
            onLocationChange={setSearchLocation}
            onLocationSearch={async (query) => {
              if (!accountId) return [];
              const { data: { session } } = await supabase.auth.getSession();
              if (!session) return [];
              try {
                const resp = await callSourceApi({
                  action: 'search_parameters',
                  account_id: accountId,
                  search: { type: 'LOCATION', keywords: query },
                  limit: 8,
                }, session);
                const items: any[] = Array.isArray(resp.items) ? resp.items : [];
                return items
                  .map((it) => ({
                    id: it.id,
                    name: it.title || it.name || it.label || '',
                  }))
                  .filter((it) => it.id && it.name);
              } catch {
                return [];
              }
            }}
            onSubmit={runSearch}
            searching={searching}
            results={searchResults}
            total={searchTotal}
            onSave={handleSaveApplicant}
            savingId={savingApplicantId}
            getCrmMatch={crmMatchFor}
            onSaveClient={handleSaveClient}
            savingClientId={savingClientId}
          />
        </TabsContent>
      </Tabs>

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

      {/* Enroll a pipeline person into a Sully sequence (in-Sully action on the
          otherwise read-only LinkedIn pipeline). */}
      <EnrollInSequenceDialog
        open={!!enrollState}
        onOpenChange={(o) => { if (!o) setEnrollState(null); }}
        candidateIds={enrollState?.ids ?? []}
        candidateNames={enrollState?.names ?? []}
      />

      {/* Link-job dialog — shown the first time you Save on a project that
          isn't yet linked to an internal job. Persists the linkedin_project_id
          on the chosen job so future Saves are one-click. */}
      <LinkJobDialog
        open={!!linkDialogApplicant}
        applicantName={linkDialogApplicant ? `${linkDialogApplicant.first_name} ${linkDialogApplicant.last_name}`.trim() : ''}
        projectTitle={projectTitle}
        openJobs={openJobs}
        selectedJobId={linkDialogJobId}
        onSelectJob={setLinkDialogJobId}
        onCancel={() => { setLinkDialogApplicant(null); setLinkDialogJobId(''); }}
        onConfirm={confirmLinkJob}
        saving={savingApplicantId === linkDialogApplicant?.id}
      />

      {/* Resume viewer — renders the fetched blob in an iframe so users
          don't have to round-trip through a new tab. Falls back to a
          download link for non-PDF/non-image content types that browsers
          won't render inline. */}
      <Dialog open={resumeView.open} onOpenChange={(o) => { if (!o) closeResumeView(); }}>
        <DialogContent className="max-w-5xl w-[90vw] h-[90vh] flex flex-col p-0">
          <DialogHeader className="px-6 py-3 border-b border-border">
            <DialogTitle className="text-base flex items-center gap-2">
              <FileText className="h-4 w-4" />
              {resumeView.applicantName} — Resume
              {resumeView.blobUrl && (
                <a
                  href={resumeView.blobUrl}
                  download={`${resumeView.applicantName.replace(/\s+/g, '_')}_resume${resumeView.contentType.includes('pdf') ? '.pdf' : ''}`}
                  className="ml-auto text-xs text-emerald hover:underline inline-flex items-center gap-1"
                >
                  <Download className="h-3 w-3" />
                  Download
                </a>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 bg-muted/30 overflow-hidden">
            {resumeView.loading && (
              <div className="h-full flex items-center justify-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
                Loading resume…
              </div>
            )}
            {!resumeView.loading && resumeView.blobUrl && (
              resumeView.contentType.startsWith('image/') ? (
                <div className="h-full overflow-auto flex items-start justify-center bg-white">
                  <img src={resumeView.blobUrl} alt="Resume" className="max-w-full" />
                </div>
              ) : (
                <iframe
                  src={resumeView.blobUrl}
                  title="Resume"
                  className="w-full h-full bg-white"
                />
              )
            )}
          </div>
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
}

/* ------------------------------------------------------------------ */
/*  ApplicantsTab — flat newest-first profile-card list                */
/* ------------------------------------------------------------------ */

interface ApplicantsTabProps {
  loading: boolean;
  applicants: Applicant[];
  onDownloadResume: (a: Applicant) => void;
  onSave: (a: Applicant) => void;
  savingId: string | null;
  getCrmMatch: (a: Applicant) => CrmMatch | null;
  onSaveClient: (a: Applicant) => void;
  savingClientId: string | null;
  onImport: () => void;
  importing: boolean;
}

const APPLICANTS_PER_PAGE = 50;

function ApplicantsTab({ loading, applicants, onDownloadResume, onSave, savingId, getCrmMatch, onSaveClient, savingClientId, onImport, importing }: ApplicantsTabProps) {
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(applicants.length / APPLICANTS_PER_PAGE));
  const current = Math.min(page, totalPages - 1);
  const start = current * APPLICANTS_PER_PAGE;
  const visible = applicants.slice(start, start + APPLICANTS_PER_PAGE);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin mr-2" />
        Loading applicants…
      </div>
    );
  }
  if (applicants.length === 0) {
    return (
      <div className="text-center py-20 text-muted-foreground">
        No job posting applicants on this project yet.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {applicants.length} applicant{applicants.length === 1 ? '' : 's'}
          {totalPages > 1 && <> · showing {start + 1}–{Math.min(start + APPLICANTS_PER_PAGE, applicants.length)}</>}
        </span>
        <Button size="sm" variant="outline" onClick={onImport} disabled={importing} title="Save these applicants into the Applicants table (People → Applicants)">
          {importing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Import className="h-3.5 w-3.5 mr-1" />}
          Import to Applicants
        </Button>
      </div>

      {visible.map((a) => (
        <ApplicantCard
          key={a.id}
          applicant={a}
          onDownloadResume={onDownloadResume}
          onSave={onSave}
          saving={savingId === a.id}
          crmMatch={getCrmMatch(a)}
          onSaveClient={onSaveClient}
          savingClient={savingClientId === a.id}
        />
      ))}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-3">
          <Button size="sm" variant="ghost" className="h-8 px-2" disabled={current === 0} onClick={() => setPage(current - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground px-2">Page {current + 1} of {totalPages}</span>
          <Button size="sm" variant="ghost" className="h-8 px-2" disabled={current >= totalPages - 1} onClick={() => setPage(current + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

interface ApplicantCardProps {
  applicant: Applicant;
  onDownloadResume: (a: Applicant) => void;
  onSave?: (a: Applicant) => void;
  saving?: boolean;
  crmMatch?: CrmMatch | null;
  onSaveClient?: (a: Applicant) => void;
  savingClient?: boolean;
}

function ApplicantCard({ applicant: a, onDownloadResume, onSave, saving, crmMatch, onSaveClient, savingClient }: ApplicantCardProps) {
  const appliedRaw = a.applied_at || a.appliedAt || a.application_date;
  const appliedAt = appliedRaw ? new Date(appliedRaw) : null;
  const appliedStr = appliedAt && !Number.isNaN(appliedAt.getTime())
    ? appliedAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : null;
  const networkDist: string | undefined = a.network_distance;
  const networkLabel = networkDist === 'SECOND_DEGREE' ? '2nd'
    : networkDist === 'THIRD_DEGREE' ? '3rd+'
    : networkDist === 'FIRST_DEGREE' ? '1st'
    : undefined;

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-start gap-3">
        {a.profile_picture_url ? (
          <img
            src={a.profile_picture_url}
            alt=""
            className="h-12 w-12 rounded-full object-cover shrink-0"
          />
        ) : (
          <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center text-sm font-medium shrink-0">
            {(a.first_name?.[0] || '') + (a.last_name?.[0] || '')}
          </div>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <a
              href={a.linkedin_url || undefined}
              target={a.linkedin_url ? '_blank' : undefined}
              rel="noreferrer"
              className="font-semibold text-base hover:underline"
            >
              {a.first_name} {a.last_name}
            </a>
            {networkLabel && (
              <span className="text-xs text-muted-foreground">· {networkLabel}</span>
            )}
            {a.has_resume && (
              <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-500">
                Resume
              </Badge>
            )}
          </div>
          {a.headline && (
            <div className="text-sm text-muted-foreground mt-0.5">{a.headline}</div>
          )}
          {(a.current_company || a.location) && (
            <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
              {a.current_company && (
                <span className="inline-flex items-center gap-1">
                  <Briefcase className="h-3 w-3" />
                  {a.current_company}
                </span>
              )}
              {a.location && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  {a.location}
                </span>
              )}
            </div>
          )}
          {appliedStr && (
            <div className="text-xs text-muted-foreground mt-1">Applied {appliedStr}</div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {a.has_resume && (
            <Button size="sm" variant="outline" onClick={() => onDownloadResume(a)}>
              <FileText className="h-3.5 w-3.5 mr-1" />
              Resume
            </Button>
          )}
          {crmMatch && <CrmBadge match={crmMatch} />}
          {/* Add to pipeline is available whether or not they're already in the
              CRM — being in the CRM ≠ being in THIS job's pipeline. Enters at
              Uncontacted (save-to-pipeline upserts the sourcing row). */}
          {onSave && (
            <Button
              size="sm"
              variant="gold"
              disabled={saving}
              onClick={() => onSave(a)}
              title="Add to this project's pipeline (Uncontacted)"
            >
              {saving
                ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                : <Plus className="h-3.5 w-3.5 mr-1" />}
              Add to pipeline
            </Button>
          )}
          {!crmMatch && onSaveClient && (
            <Button
              size="sm"
              variant="outline"
              disabled={savingClient}
              onClick={() => onSaveClient(a)}
              title="Add as client"
            >
              {savingClient
                ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                : <Contact className="h-3.5 w-3.5 mr-1" />}
              Client
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  SearchTab — inline Unipile recruiter people search                 */
/* ------------------------------------------------------------------ */

interface SearchTabProps {
  keywords: string;
  title: string;
  company: string;
  location: LocationOption | null;
  onKeywordsChange: (v: string) => void;
  onTitleChange: (v: string) => void;
  onCompanyChange: (v: string) => void;
  onLocationChange: (v: LocationOption | null) => void;
  onLocationSearch: (query: string) => Promise<LocationOption[]>;
  onSubmit: () => void;
  searching: boolean;
  results: Applicant[];
  total: number | null;
  onSave: (a: Applicant) => void;
  savingId: string | null;
  getCrmMatch: (a: Applicant) => CrmMatch | null;
  onSaveClient: (a: Applicant) => void;
  savingClientId: string | null;
}

function SearchTab({
  keywords, title, company, location,
  onKeywordsChange, onTitleChange, onCompanyChange, onLocationChange,
  onLocationSearch,
  onSubmit, searching, results, total,
  onSave, savingId, getCrmMatch, onSaveClient, savingClientId,
}: SearchTabProps) {
  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-lg p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input
            placeholder="Keywords (e.g. 'machine learning')"
            value={keywords}
            onChange={(e) => onKeywordsChange(e.target.value)}
          />
          <Input
            placeholder="Job title (e.g. 'Software Engineer')"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
          />
          <Input
            placeholder="Companies (comma-separated)"
            value={company}
            onChange={(e) => onCompanyChange(e.target.value)}
          />
          <LocationCombobox
            value={location}
            onChange={onLocationChange}
            onSearch={onLocationSearch}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={onSubmit} disabled={searching}>
            {searching
              ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              : <SearchIcon className="h-3.5 w-3.5 mr-1" />}
            Search LinkedIn
          </Button>
          {total != null && (
            <span className="text-xs text-muted-foreground">
              {total.toLocaleString()} result{total === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>

      {results.length === 0 && !searching ? (
        <div className="text-center py-10 text-muted-foreground text-sm">
          Enter keywords/title/company and run a search.
        </div>
      ) : (
        <div className="space-y-2">
          {results.map((a) => (
            <ApplicantCard
              key={a.id}
              applicant={a}
              onDownloadResume={() => { /* search results have no resume */ }}
              onSave={onSave}
              saving={savingId === a.id}
              crmMatch={getCrmMatch(a)}
              onSaveClient={onSaveClient}
              savingClient={savingClientId === a.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  LinkJobDialog — one-time project ↔ job mapping prompt              */
/* ------------------------------------------------------------------ */

interface LinkJobDialogProps {
  open: boolean;
  applicantName: string;
  projectTitle: string;
  openJobs: any[];
  selectedJobId: string;
  onSelectJob: (id: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  saving: boolean;
}

function LinkJobDialog({
  open, applicantName, projectTitle, openJobs,
  selectedJobId, onSelectJob, onCancel, onConfirm, saving,
}: LinkJobDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Link project to a job</DialogTitle>
          <DialogDescription>
            This LinkedIn project (<span className="font-medium">{projectTitle}</span>) isn't linked
            to a job in Sully Recruit yet. Pick one — future Saves on this project will tag candidates
            automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <Select value={selectedJobId} onValueChange={onSelectJob}>
            <SelectTrigger>
              <div className="flex items-center gap-1.5 truncate">
                <Briefcase className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <SelectValue placeholder="Choose a job…" />
              </div>
            </SelectTrigger>
            <SelectContent>
              {openJobs.length === 0 && (
                <div className="px-3 py-2 text-sm text-muted-foreground">No open jobs</div>
              )}
              {openJobs.map((job: any) => (
                <SelectItem key={job.id} value={job.id}>
                  <span className="truncate">{job.title} — {job.company_name || job.company}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button
            variant="gold"
            onClick={onConfirm}
            disabled={!selectedJobId || saving}
          >
            {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Link &amp; save {applicantName ? `(${applicantName})` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/*  CrmBadge — "already in Sully Recruit" pill linking to the record   */
/* ------------------------------------------------------------------ */

function CrmBadge({ match }: { match: CrmMatch }) {
  const to = match.type === 'client' ? `/contacts/${match.id}` : `/candidates/${match.id}`;
  return (
    <Link
      to={to}
      title={match.full_name ? `In Sully Recruit: ${match.full_name}` : 'Already in Sully Recruit'}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-500 hover:bg-emerald-500/20 transition-colors whitespace-nowrap"
    >
      <CheckCircle2 className="h-3 w-3 shrink-0" />
      In CRM · {match.type === 'client' ? 'Client' : 'Candidate'}
      <ExternalLink className="h-3 w-3 shrink-0 opacity-70" />
    </Link>
  );
}
