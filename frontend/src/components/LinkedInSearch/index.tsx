import { useState, useEffect } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useSequences } from '@/hooks/useData';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { invalidatePersonScope } from '@/lib/invalidate';
import {
  Search, Linkedin, Loader2, UserPlus, Contact, Play,
  Link as LinkIcon, MapPin, Building, Briefcase,
} from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type ApiMode = 'recruiter_ashley' | 'recruiter_nancy' | 'recruiter_chris';

interface AccountOption {
  label: string;
  mode: ApiMode;
  accountId: string | null;
  ownerUserId: string | null;
}

interface SearchResult {
  id: string;
  first_name: string;
  last_name: string;
  headline?: string;
  current_title?: string;
  current_company?: string;
  location?: string;
  linkedin_url?: string;
  profile_picture_url?: string;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function LinkedInSearch() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: sequences = [] } = useSequences();
  const activeSequences = sequences.filter((s: any) => s.status === 'active');

  // ---- Account switching state ----
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedMode, setSelectedMode] = useState<ApiMode>('recruiter_ashley');
  const [accountsLoading, setAccountsLoading] = useState(true);

  // ---- Search form state ----
  const [tab, setTab] = useState<'form' | 'url'>('form');
  const [keywords, setKeywords] = useState('');
  const [title, setTitle] = useState('');
  const [companies, setCompanies] = useState('');
  const [locations, setLocations] = useState('');
  const [pastedUrl, setPastedUrl] = useState('');

  // ---- Results & actions ----
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});

  // ---- Sequence enrollment dialog ----
  const [enrollDialog, setEnrollDialog] = useState<{ open: boolean; result: SearchResult | null }>({
    open: false,
    result: null,
  });
  const [enrollSeqId, setEnrollSeqId] = useState('');
  const [enrolling, setEnrolling] = useState(false);

  // ---- Load Unipile config & account IDs on mount ----
  useEffect(() => {
    if (!user) return;
    (async () => {
      setAccountsLoading(true);
      try {
        // Load all 3 LinkedIn Recruiter accounts
        const { data: ashleyRow } = await supabase
          .from('integration_accounts')
          .select('unipile_account_id, owner_user_id')
          .ilike('account_label', '%Ashley%')
          .eq('is_active', true)
          .maybeSingle();

        const { data: nancyRow } = await supabase
          .from('integration_accounts')
          .select('unipile_account_id, owner_user_id')
          .ilike('account_label', '%Nancy%')
          .eq('is_active', true)
          .maybeSingle();

        const { data: chrisRow } = await supabase
          .from('integration_accounts')
          .select('unipile_account_id, owner_user_id')
          .ilike('account_label', '%Chris Sullivan%')
          .eq('is_active', true)
          .maybeSingle();

        setAccounts([
          { label: 'Recruiter — Ashley', mode: 'recruiter_ashley', accountId: ashleyRow?.unipile_account_id ?? null, ownerUserId: ashleyRow?.owner_user_id ?? null },
          { label: 'Recruiter — Nancy', mode: 'recruiter_nancy', accountId: nancyRow?.unipile_account_id ?? null, ownerUserId: nancyRow?.owner_user_id ?? null },
          { label: 'Recruiter — Chris', mode: 'recruiter_chris', accountId: chrisRow?.unipile_account_id ?? null, ownerUserId: chrisRow?.owner_user_id ?? null },
        ]);
      } catch (err) {
        console.error('Failed to load LinkedIn accounts', err);
      } finally {
        setAccountsLoading(false);
      }
    })();
  }, [user]);

  // ---- Resolve the active account ----
  const activeAccount = accounts.find((a) => a.mode === selectedMode);

  // ---- Unipile base URL & API key (from user_integrations) ----
  const [unipileDsn, setUnipileDsn] = useState('');
  const [unipileKey, setUnipileKey] = useState('');

  useEffect(() => {
    if (!user) return;
    supabase
      .from('user_integrations')
      .select('config')
      .eq('user_id', user.id)
      .eq('integration_type', 'unipile')
      .maybeSingle()
      .then(({ data }) => {
        const cfg = data?.config as any;
        if (cfg?.base_url) setUnipileDsn(cfg.base_url.replace(/\/+$/, ''));
        if (cfg?.api_key) setUnipileKey(cfg.api_key);
      });
  }, [user]);

  /* ---------------------------------------------------------------- */
  /*  Search handler                                                   */
  /* ---------------------------------------------------------------- */
  const handleSearch = async () => {
    if (!activeAccount?.accountId) {
      toast.error('No Unipile account ID configured for this mode.');
      return;
    }
    if (!unipileDsn || !unipileKey) {
      toast.error('Unipile DSN or API key not configured. Check Settings → Unipile.');
      return;
    }

    setSearching(true);
    setResults([]);

    try {
      // Unipile v2 splits LinkedIn search by product. Recruiter search lives
      // at /api/v2/{account_id}/linkedin/recruiter/search; account_id is now
      // a path segment (no longer a query param). The `api` body field is
      // gone — the path encodes that.
      // Convert the configured DSN (which usually ends in /api/v1) to v2.
      const v2Dsn = unipileDsn.replace(/\/api\/v1$/, '/api/v2');
      const url = `${v2Dsn}/${encodeURIComponent(activeAccount.accountId)}/linkedin/recruiter/search`;

      let body: any;
      if (tab === 'url' && pastedUrl.trim()) {
        body = { url: pastedUrl.trim() };
      } else {
        body = {
          category: 'people',
          keywords: keywords || undefined,
          role: title ? [{ keywords: title }] : undefined,
          company: companies
            ? { include: companies.split(',').map((c) => c.trim()).filter(Boolean) }
            : undefined,
          location: locations
            ? locations.split(',').map((l) => l.trim()).filter(Boolean)
            : undefined,
        };
      }

      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': unipileKey,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Unipile returned ${resp.status}: ${errText}`);
      }

      const data = await resp.json();
      const items: SearchResult[] = (data.items ?? data.results ?? data ?? []).map((item: any, idx: number) => ({
        id: item.id ?? item.public_id ?? `result-${idx}`,
        first_name: item.first_name ?? item.firstName ?? '',
        last_name: item.last_name ?? item.lastName ?? '',
        headline: item.headline ?? '',
        current_title: item.title ?? item.current_title ?? item.headline ?? '',
        current_company: item.company ?? item.current_company ?? item.company_name ?? '',
        location: item.location ?? item.region ?? '',
        linkedin_url: item.linkedin_url ?? item.public_profile_url ?? item.url ?? '',
        profile_picture_url: item.profile_picture_url ?? item.picture_url ?? '',
      }));

      setResults(items);
      if (items.length === 0) toast.info('No results found.');
    } catch (err: any) {
      console.error('LinkedIn search failed', err);
      toast.error(err.message || 'Search failed');
    } finally {
      setSearching(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Add as Candidate                                                 */
  /* ---------------------------------------------------------------- */
  const addAsCandidate = async (r: SearchResult) => {
    setActionLoading((prev) => ({ ...prev, [`cand-${r.id}`]: true }));
    try {
      const ownerId = activeAccount?.ownerUserId || user?.id || null;
      const { error } = await supabase.from('people').insert({
        first_name: r.first_name,
        last_name: r.last_name,
        current_title: r.current_title || null,
        current_company: r.current_company || null,
        location: r.location || null,
        linkedin_url: r.linkedin_url || null,
        avatar_url: r.profile_picture_url || null,
        source: 'linkedin_search',
        status: 'new',
        owner_id: ownerId,
      } as any);
      if (error) throw error;
      invalidatePersonScope(queryClient);
      toast.success(`${r.first_name} ${r.last_name} added as candidate`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to add candidate');
    } finally {
      setActionLoading((prev) => ({ ...prev, [`cand-${r.id}`]: false }));
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Add as Contact                                                   */
  /* ---------------------------------------------------------------- */
  const addAsContact = async (r: SearchResult) => {
    setActionLoading((prev) => ({ ...prev, [`cont-${r.id}`]: true }));
    try {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const { error } = await supabase.from('contacts').insert({
        first_name: r.first_name,
        last_name: r.last_name,
        title: r.current_title || null,
        linkedin_url: r.linkedin_url || null,
        avatar_url: r.profile_picture_url || null,
        status: 'active',
        owner_id: userId,
      } as any);
      if (error) throw error;
      invalidatePersonScope(queryClient);
      toast.success(`${r.first_name} ${r.last_name} added as contact`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to add contact');
    } finally {
      setActionLoading((prev) => ({ ...prev, [`cont-${r.id}`]: false }));
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Add to Sequence                                                  */
  /* ---------------------------------------------------------------- */
  const openEnrollDialog = (r: SearchResult) => {
    setEnrollDialog({ open: true, result: r });
    setEnrollSeqId('');
  };

  const handleEnroll = async () => {
    const r = enrollDialog.result;
    if (!r || !enrollSeqId) return;
    setEnrolling(true);
    try {
      // First insert as candidate if not already
      const { data: existing } = await supabase
        .from('people')
        .select('id')
        .eq('linkedin_url', r.linkedin_url)
        .maybeSingle();

      let candidateId = existing?.id;
      if (!candidateId) {
        const ownerId = activeAccount?.ownerUserId || user?.id || null;
        const { data: inserted, error } = await supabase
          .from('people')
          .insert({
            first_name: r.first_name,
            last_name: r.last_name,
            current_title: r.current_title || null,
            current_company: r.current_company || null,
            location: r.location || null,
            linkedin_url: r.linkedin_url || null,
            avatar_url: r.profile_picture_url || null,
            source: 'linkedin_search',
            status: 'new',
            owner_id: ownerId,
          } as any)
          .select('id')
          .single();
        if (error) throw error;
        candidateId = inserted.id;
        invalidatePersonScope(queryClient);
      }

      const userId = (await supabase.auth.getUser()).data.user?.id;
      const { error: enrollErr } = await supabase.from('sequence_enrollments').insert({
        sequence_id: enrollSeqId,
        candidate_id: candidateId,
        status: 'active',
        current_step_order: 0,
        next_step_at: new Date().toISOString(),
        enrolled_by: userId,
      });
      if (enrollErr) throw enrollErr;

      queryClient.invalidateQueries({ queryKey: ['sequences'] });
      toast.success(`${r.first_name} ${r.last_name} enrolled in sequence`);
      setEnrollDialog({ open: false, result: null });
    } catch (err: any) {
      toast.error(err.message || 'Failed to enroll');
    } finally {
      setEnrolling(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */
  return (
    <MainLayout>
      <PageHeader
        title="LinkedIn Search"
        description="Search LinkedIn for candidates and contacts via Unipile."
      />

      <div className="p-8 space-y-6">
        {/* ---- Account switcher ---- */}
        <div className="flex items-center gap-4">
          <Label className="text-sm font-medium whitespace-nowrap">Account:</Label>
          {accountsLoading ? (
            <span className="text-sm text-muted-foreground">Loading accounts…</span>
          ) : (
            <div className="flex gap-2">
              {accounts.map((acct) => (
                <Button
                  key={acct.mode}
                  size="sm"
                  variant={selectedMode === acct.mode ? 'secondary' : 'ghost'}
                  onClick={() => setSelectedMode(acct.mode)}
                  disabled={!acct.accountId}
                  title={!acct.accountId ? 'Account not configured' : ''}
                >
                  <Linkedin className="h-3.5 w-3.5 mr-1" />
                  {acct.label}
                  {!acct.accountId && (
                    <Badge variant="outline" className="ml-1 text-[10px]">N/A</Badge>
                  )}
                </Button>
              ))}
            </div>
          )}
        </div>

        {/* ---- Search form ---- */}
        <div className="rounded-lg border border-border bg-card p-6 space-y-4">
          <Tabs value={tab} onValueChange={(v) => setTab(v as 'form' | 'url')}>
            <TabsList>
              <TabsTrigger value="form">
                <Search className="h-3.5 w-3.5 mr-1" />
                Search Fields
              </TabsTrigger>
              <TabsTrigger value="url">
                <LinkIcon className="h-3.5 w-3.5 mr-1" />
                Paste URL
              </TabsTrigger>
            </TabsList>

            <TabsContent value="form" className="space-y-4 pt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Keywords</Label>
                  <Input
                    placeholder="e.g. software engineer"
                    value={keywords}
                    onChange={(e) => setKeywords(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Title / Role</Label>
                  <Input
                    placeholder="e.g. VP of Engineering"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Companies (comma-separated)</Label>
                  <Input
                    placeholder="e.g. Google, Meta, Stripe"
                    value={companies}
                    onChange={(e) => setCompanies(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Locations (comma-separated)</Label>
                  <Input
                    placeholder="e.g. New York, San Francisco"
                    value={locations}
                    onChange={(e) => setLocations(e.target.value)}
                  />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="url" className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label>LinkedIn Search / Profile URL</Label>
                <Input
                  placeholder="Paste a LinkedIn search or profile URL…"
                  value={pastedUrl}
                  onChange={(e) => setPastedUrl(e.target.value)}
                />
              </div>
            </TabsContent>
          </Tabs>

          <Button variant="gold" onClick={handleSearch} disabled={searching}>
            {searching ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Search className="h-4 w-4 mr-1" />}
            {searching ? 'Searching…' : 'Search LinkedIn'}
          </Button>
        </div>

        {/* ---- Results ---- */}
        {results.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">{results.length} Results</h3>
            <div className="space-y-2">
              {results.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-4 rounded-lg border border-border bg-card p-4 hover:bg-muted/30 transition-colors"
                >
                  {/* Avatar */}
                  {r.profile_picture_url ? (
                    <img src={r.profile_picture_url} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" />
                  ) : (
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/10 text-sm font-medium text-accent">
                      {r.first_name?.[0] ?? ''}{r.last_name?.[0] ?? ''}
                    </div>
                  )}

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {r.first_name} {r.last_name}
                    </p>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      {r.current_title && (
                        <span className="flex items-center gap-1 truncate">
                          <Briefcase className="h-3 w-3" />
                          {r.current_title}
                        </span>
                      )}
                      {r.current_company && (
                        <span className="flex items-center gap-1 truncate">
                          <Building className="h-3 w-3" />
                          {r.current_company}
                        </span>
                      )}
                      {r.location && (
                        <span className="flex items-center gap-1 truncate">
                          <MapPin className="h-3 w-3" />
                          {r.location}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {r.linkedin_url && (
                      <a
                        href={r.linkedin_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <Linkedin className="h-4 w-4" />
                      </a>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => addAsCandidate(r)}
                      disabled={!!actionLoading[`cand-${r.id}`]}
                    >
                      {actionLoading[`cand-${r.id}`] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5 mr-1" />}
                      Candidate
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => addAsContact(r)}
                      disabled={!!actionLoading[`cont-${r.id}`]}
                    >
                      {actionLoading[`cont-${r.id}`] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Contact className="h-3.5 w-3.5 mr-1" />}
                      Contact
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openEnrollDialog(r)}
                    >
                      <Play className="h-3.5 w-3.5 mr-1" />
                      Sequence
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ---- Enroll in Sequence Dialog ---- */}
      <Dialog open={enrollDialog.open} onOpenChange={(open) => setEnrollDialog({ open, result: open ? enrollDialog.result : null })}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add to Sequence</DialogTitle>
            <DialogDescription>
              Enroll {enrollDialog.result?.first_name} {enrollDialog.result?.last_name} in an outreach sequence.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Select Sequence</Label>
              {activeSequences.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active sequences available.</p>
              ) : (
                <Select value={enrollSeqId} onValueChange={setEnrollSeqId}>
                  <SelectTrigger><SelectValue placeholder="Choose a sequence…" /></SelectTrigger>
                  <SelectContent>
                    {activeSequences.map((seq: any) => (
                      <SelectItem key={seq.id} value={seq.id}>{seq.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEnrollDialog({ open: false, result: null })}>Cancel</Button>
            <Button variant="gold" onClick={handleEnroll} disabled={!enrollSeqId || enrolling}>
              {enrolling && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Enroll
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
}
