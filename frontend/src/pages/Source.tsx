import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import {
  Loader2, ChevronRight, Users, Search, ExternalLink,
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

interface HiringProject {
  id: string;
  title: string;
  created_at?: string;
  updated_at?: string;
  applicant_count?: number;
  status?: string;
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

  // ---- Recruiter Search state ----
  const [searchUrl, setSearchUrl] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchAccount, setSearchAccount] = useState<AccountOption | null>(null);

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

  // ---- Navigate to project detail ----
  const openProject = (project: HiringProject) => {
    const params = new URLSearchParams({
      account_id: project.account_id,
      title: project.title,
      recruiter: project.recruiter,
    });
    navigate(`/source/${encodeURIComponent(project.id)}?${params}`);
  };

  // ---- Run a LinkedIn Recruiter search-from-URL ----
  // Pastes a Recruiter saved-search URL and surfaces the matching
  // profiles. Runs against the currently filtered recruiter (or the
  // first available account when "all" is selected).
  const runRecruiterSearch = useCallback(async () => {
    const trimmed = searchUrl.trim();
    if (!trimmed) {
      toast.error('Paste a LinkedIn Recruiter search URL first');
      return;
    }
    const candidate = recruiterFilter === 'all'
      ? accounts.find(a => a.accountId)
      : accounts.find(a => a.mode === recruiterFilter && a.accountId);
    if (!candidate?.accountId) {
      toast.error('No LinkedIn Recruiter account connected for the selected filter');
      return;
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { toast.error('Not authenticated'); return; }

    setSearchLoading(true);
    setSearchAccount(candidate);
    try {
      const data = await callSourceApi({
        action: 'search_from_url',
        account_id: candidate.accountId,
        search_url: trimmed,
        limit: 25,
      }, session);
      const items = Array.isArray(data.items) ? data.items : [];
      setSearchResults(items);
      if (items.length === 0) {
        toast.info('Search returned no results');
      } else {
        toast.success(`Found ${items.length} profile${items.length === 1 ? '' : 's'}`);
      }
    } catch (err: any) {
      toast.error(err.message || 'Recruiter search failed');
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, [searchUrl, accounts, recruiterFilter]);

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

      {/* Recruiter Search-from-URL */}
      <div className="mb-6 rounded-lg border border-card-border bg-page-bg/40 p-4">
        <div className="flex items-center gap-2 mb-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground">
            LinkedIn Recruiter Search
          </span>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Paste a LinkedIn Recruiter saved-search URL to surface matching profiles on the selected recruiter's seat.
        </p>
        <div className="flex items-center gap-2">
          <Input
            value={searchUrl}
            onChange={(e) => setSearchUrl(e.target.value)}
            placeholder="https://www.linkedin.com/talent/search?..."
            className="h-9"
            onKeyDown={(e) => { if (e.key === 'Enter') runRecruiterSearch(); }}
          />
          <Button
            variant="gold"
            size="sm"
            onClick={runRecruiterSearch}
            disabled={searchLoading || !searchUrl.trim()}
            className="shrink-0"
          >
            {searchLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Search className="h-4 w-4 mr-1" />}
            Search
          </Button>
        </div>
        {searchResults.length > 0 && (
          <div className="mt-3 space-y-1.5 max-h-72 overflow-y-auto">
            {searchResults.map((p: any, i: number) => {
              const name = p.display_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Unknown';
              const headline = p.headline || '';
              const location = p.location || '';
              const exp = Array.isArray(p.work_experience) ? p.work_experience[0] : null;
              const titleCompany = exp
                ? [exp.job_title, exp.company?.name].filter(Boolean).join(' @ ')
                : '';
              const url = p.profile_url || (p.public_identifier ? `https://www.linkedin.com/in/${p.public_identifier}` : null);
              return (
                <div
                  key={p.id || i}
                  className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-xs"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-foreground truncate">{name}</div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {[titleCompany, headline, location].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  {url && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 shrink-0"
                    >
                      <ExternalLink className="h-3 w-3" /> View
                    </a>
                  )}
                </div>
              );
            })}
            {searchAccount && (
              <p className="text-[10px] text-muted-foreground/70 pt-1">
                Run on {searchAccount.label}'s LinkedIn Recruiter seat
              </p>
            )}
          </div>
        )}
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

      {/* Projects list */}
      <div className="space-y-2">
        {projects.map((project) => (
          <button
            key={project.id}
            onClick={() => openProject(project)}
            className="w-full flex items-center gap-3 px-4 py-3 bg-card border border-border rounded-lg hover:bg-accent/5 transition-colors text-left"
          >
            <Users className="h-5 w-5 text-muted-foreground shrink-0" />

            <div className="flex-1 min-w-0">
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
                {project.status && (
                  <Badge variant="outline" className="text-[10px]">{project.status}</Badge>
                )}
              </div>
            </div>

            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          </button>
        ))}
      </div>
    </MainLayout>
  );
}
