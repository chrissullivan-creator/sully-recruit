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
  Loader2, ChevronRight, Users,
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

  // ---- Load accounts on mount ----
  useEffect(() => {
    if (!user) return;
    (async () => {
      setAccountsLoading(true);
      try {
        const [{ data: ashley }, { data: nancy }, { data: chris }] = await Promise.all([
          supabase.from('integration_accounts').select('unipile_account_id, owner_user_id')
            .ilike('account_label', '%Ashley%').eq('is_active', true)
            .not('unipile_account_id', 'is', null).maybeSingle(),
          supabase.from('integration_accounts').select('unipile_account_id, owner_user_id')
            .ilike('account_label', '%Nancy%').eq('is_active', true)
            .not('unipile_account_id', 'is', null).maybeSingle(),
          supabase.from('integration_accounts').select('unipile_account_id, owner_user_id')
            .ilike('account_label', '%Chris Sullivan%').eq('is_active', true)
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
