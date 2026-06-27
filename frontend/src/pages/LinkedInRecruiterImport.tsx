import { useEffect, useMemo, useRef, useState } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import {
  ImportMatchReviewDialog,
  type ReviewItem,
  type IncomingPerson,
  type PersonMatch,
  type Decision,
} from '@/components/import/ImportMatchReviewDialog';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useIntegrationAccounts } from '@/hooks/useData';
import { useAuth } from '@/contexts/AuthContext';
import { authHeaders } from '@/lib/api-auth';
import { downloadCsv } from '@/lib/csvExport';
import { toast } from 'sonner';
import { Linkedin, Search, Loader2, Download, UserPlus, ExternalLink, Check, X } from 'lucide-react';

type PersonType = 'candidate' | 'contact';

interface PreviewRow {
  _k: string;
  candidate_id: string | null;
  first_name: string;
  last_name: string;
  name: string;
  headline: string | null;
  current_title: string | null;
  current_company: string | null;
  location: string | null;
  linkedin_url: string | null;
  avatar_url: string | null;
  email: string | null;
  phone: string | null;
  stage: string;
  has_resume: boolean;
  importable: boolean;
  type: PersonType;
  selected: boolean;
  status?: 'importing' | 'imported' | 'merged' | 'skipped' | 'error';
  statusMsg?: string;
}

type ImportOutcome = 'imported' | 'merged' | 'skipped' | 'error';
interface Counts { imported: number; merged: number; skipped: number; failed: number; }

const STAGE_LABEL: Record<string, string> = {
  uncontacted: 'Uncontacted',
  contacted: 'Contacted',
  replied: 'Replied',
  back_of_resume: 'Back of resume',
};

// Resolve the v2 (acc_xxx) id we should call on behalf of, preferring the
// canonical column but falling back to metadata, then the v1 short id —
// resolveV2Ctx on the server accepts any of them.
function accountUnipileId(a: any): string | null {
  return a?.unipile_account_id_v2 || a?.metadata?.unipile_account_id_v2 || a?.unipile_account_id || null;
}

function accountLabel(a: any): string {
  const base = a?.account_label || a?.account_type || 'LinkedIn account';
  const type = a?.account_type && !String(base).toLowerCase().includes(String(a.account_type).toLowerCase())
    ? ` · ${a.account_type}`
    : '';
  return `${base}${type}`;
}

export default function LinkedInRecruiterImport() {
  const { user } = useAuth();
  const { data: accounts = [], isLoading: accountsLoading } = useIntegrationAccounts();

  const [accountId, setAccountId] = useState<string>('');
  const [url, setUrl] = useState('');
  const [defaultType, setDefaultType] = useState<PersonType>('candidate');
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [summary, setSummary] = useState<{ total: number; fetched: number; truncated: boolean } | null>(null);

  // Fuzzy-dedup review state.
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [confirming, setConfirming] = useState(false);
  const headersRef = useRef<Record<string, string>>({});
  const pendingCleanCounts = useRef<Counts>({ imported: 0, merged: 0, skipped: 0, failed: 0 });
  const importTargetCount = useRef(0);

  // LinkedIn seats that have a v2 (acc_xxx) id — the only ones we can call the
  // Recruiter search-from-URL endpoint on behalf of.
  const liAccounts = useMemo(
    () => (accounts as any[]).filter((a) => {
      const hay = [a.provider, a.account_type, a.account_label].filter(Boolean).join(' ').toLowerCase();
      return hay.includes('linkedin') && !!accountUnipileId(a);
    }),
    [accounts],
  );

  // Auto-select the current user's own LinkedIn seat once accounts load.
  useEffect(() => {
    if (accountId || liAccounts.length === 0) return;
    const mine = liAccounts.find((a) => a.owner_user_id === user?.id);
    const pick = mine || (liAccounts.length === 1 ? liAccounts[0] : null);
    const id = pick && accountUnipileId(pick);
    if (id) setAccountId(id);
  }, [liAccounts, user?.id, accountId]);

  const selectedAccount = liAccounts.find((a) => accountUnipileId(a) === accountId);

  const importableSelected = rows.filter((r) => r.selected && r.importable);
  const allImportableSelected = rows.length > 0
    && rows.every((r) => !r.importable || r.selected)
    && rows.some((r) => r.importable);

  const runSearch = async () => {
    if (loading) return;
    const u = url.trim();
    if (!accountId) { toast.error('Pick a LinkedIn account to search from'); return; }
    if (!u) { toast.error('Paste a LinkedIn Recruiter search URL'); return; }

    setLoading(true);
    setRows([]);
    setSummary(null);
    try {
      const resp = await fetch('/api/linkedin-recruiter-search', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ account_id: accountId, url: u }),
      });
      const json = await resp.json().catch(() => null);
      if (!resp.ok) throw new Error(json?.error || `Search failed (${resp.status})`);

      const people: any[] = Array.isArray(json?.people) ? json.people : [];
      const mapped: PreviewRow[] = people.map((p, i) => {
        const importable = !!(p.first_name && p.last_name);
        return {
          _k: `${i}`,
          candidate_id: p.candidate_id ?? null,
          first_name: p.first_name ?? '',
          last_name: p.last_name ?? '',
          name: p.name || [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || '—',
          headline: p.headline ?? null,
          current_title: p.current_title ?? null,
          current_company: p.current_company ?? null,
          location: p.location ?? null,
          linkedin_url: p.linkedin_url ?? null,
          avatar_url: p.avatar_url ?? null,
          email: p.email ?? null,
          phone: p.phone ?? null,
          stage: p.stage || 'uncontacted',
          has_resume: !!p.has_resume,
          importable,
          type: defaultType,
          selected: importable,
        };
      });
      setRows(mapped);
      setSummary({ total: Number(json?.total_count) || mapped.length, fetched: mapped.length, truncated: !!json?.truncated });
      if (mapped.length === 0) toast.info('No results for that URL — double-check it is a Recruiter search/pipeline URL.');
    } catch (e: any) {
      toast.error(e?.message || 'Recruiter search failed');
    } finally {
      setLoading(false);
    }
  };

  const patchRow = (k: string, patch: Partial<PreviewRow>) =>
    setRows((prev) => prev.map((r) => (r._k === k ? { ...r, ...patch } : r)));

  const toggleAll = (checked: boolean) =>
    setRows((prev) => prev.map((r) => (r.importable ? { ...r, selected: checked } : r)));

  const setSelectedType = (type: PersonType) =>
    setRows((prev) => prev.map((r) => (r.selected && r.importable ? { ...r, type } : r)));

  const toIncoming = (r: PreviewRow): IncomingPerson => ({
    key: r._k,
    name: r.name,
    title: r.current_title,
    company: r.current_company,
    location: r.location,
    email: r.email,
    phone: r.phone,
    linkedin_url: r.linkedin_url,
  });

  // POST a single person to add-person. `decision` carries the user's choice
  // from the review modal (merge into an existing person, keep both, or skip).
  const postPerson = async (row: PreviewRow, decision?: Decision): Promise<ImportOutcome> => {
    if (decision?.action === 'skip') {
      patchRow(row._k, { status: 'skipped', statusMsg: 'Skipped (duplicate)' });
      return 'skipped';
    }
    patchRow(row._k, { status: 'importing', statusMsg: undefined });
    // On a merge, stamp the role that matches the existing person so add-person
    // writes the right columns; otherwise use the row's chosen type.
    const isMerge = decision?.action === 'merge' && !!decision.mergeTargetId;
    const type = isMerge && decision?.mergeTargetType
      ? (decision.mergeTargetType === 'candidate' ? 'candidate' : 'contact')
      : row.type;
    try {
      const body: Record<string, any> = {
        type,
        provider_id: row.candidate_id || undefined,
        data: {
          first_name: row.first_name,
          last_name: row.last_name,
          title: row.current_title || undefined,
          company: row.current_company || undefined,
          location: row.location || undefined,
          linkedin_url: row.linkedin_url || undefined,
          email: row.email || undefined,
          phone: row.phone || undefined,
          headline: row.headline || undefined,
          photo: row.avatar_url || undefined,
          notes: `Imported from LinkedIn Recruiter${row.stage ? ` · stage: ${STAGE_LABEL[row.stage] || row.stage}` : ''}`,
        },
      };
      if (isMerge) body.merge_into = decision!.mergeTargetId;
      const resp = await fetch('/api/add-person', {
        method: 'POST',
        headers: headersRef.current,
        body: JSON.stringify(body),
      });
      const json = await resp.json().catch(() => null);
      if (!resp.ok) throw new Error(json?.error || `Failed (${resp.status})`);
      if (json?.enriched) { patchRow(row._k, { status: 'merged', statusMsg: 'Merged & updated from LinkedIn' }); return 'merged'; }
      if (json?.merged) { patchRow(row._k, { status: 'merged', statusMsg: 'Already existed — merged' }); return 'merged'; }
      patchRow(row._k, { status: 'imported', statusMsg: 'Imported' }); return 'imported';
    } catch (e: any) {
      patchRow(row._k, { status: 'error', statusMsg: e?.message || 'Failed' });
      return 'error';
    }
  };

  // Run a batch with bounded concurrency so we don't open hundreds of sockets.
  const runBatch = async (entries: { row: PreviewRow; decision?: Decision }[]): Promise<Counts> => {
    const counts: Counts = { imported: 0, merged: 0, skipped: 0, failed: 0 };
    let idx = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, entries.length) }, async () => {
        while (idx < entries.length) {
          const e = entries[idx++];
          const r = await postPerson(e.row, e.decision);
          if (r === 'imported') counts.imported++;
          else if (r === 'merged') counts.merged++;
          else if (r === 'skipped') counts.skipped++;
          else counts.failed++;
        }
      }),
    );
    return counts;
  };

  const toastCounts = (c: Counts) => {
    const parts: string[] = [];
    if (c.imported) parts.push(`${c.imported} imported`);
    if (c.merged) parts.push(`${c.merged} merged`);
    if (c.skipped) parts.push(`${c.skipped} skipped`);
    if (c.failed) parts.push(`${c.failed} failed`);
    toast.success(parts.join(' · ') || 'No changes');
  };

  const importSelected = async () => {
    if (importing) return;
    const targets = rows.filter((r) => r.selected && r.importable);
    if (targets.length === 0) { toast.error('Select at least one named person to import'); return; }

    setImporting(true);
    importTargetCount.current = targets.length;
    headersRef.current = await authHeaders();

    // ── Step 1: fuzzy-match against existing people so we don't create dupes ──
    let matchMap: Record<string, PersonMatch[]> = {};
    try {
      const resp = await fetch('/api/match-people', {
        method: 'POST',
        headers: headersRef.current,
        body: JSON.stringify({
          people: targets.map((r) => ({
            key: r._k,
            name: r.name,
            first_name: r.first_name,
            last_name: r.last_name,
            email: r.email,
            phone: r.phone,
            linkedin_url: r.linkedin_url,
            company: r.current_company,
            title: r.current_title,
            type: r.type === 'candidate' ? 'candidate' : 'client',
          })),
        }),
      });
      const json = await resp.json().catch(() => null);
      if (resp.ok && json?.matches) matchMap = json.matches;
    } catch {
      // Match service hiccup — fall back to a plain import (add-person still
      // does exact-key dedup server-side, so we never hard-dupe).
    }

    // ── Step 2: split into clean (no match → import now) and review (has a
    //    plausible existing person → ask the user) ──
    const clean: PreviewRow[] = [];
    const reviewable: ReviewItem[] = [];
    for (const r of targets) {
      const ms = matchMap[r._k] || [];
      if (ms.length) reviewable.push({ row: toIncoming(r), matches: ms });
      else clean.push(r);
    }

    const cleanCounts = clean.length
      ? await runBatch(clean.map((row) => ({ row })))
      : { imported: 0, merged: 0, skipped: 0, failed: 0 };

    // ── Step 3: review the matches, or finish ──
    if (reviewable.length) {
      pendingCleanCounts.current = cleanCounts;
      setReviewItems(reviewable);
      setReviewOpen(true);
      setImporting(false); // the modal drives the rest
    } else {
      setImporting(false);
      toastCounts(cleanCounts);
    }
  };

  const confirmReview = async (decisions: Record<string, Decision>) => {
    setConfirming(true);
    const byKey = new Map(rows.map((r) => [r._k, r]));
    const entries = reviewItems
      .map((it) => ({ row: byKey.get(it.row.key), decision: decisions[it.row.key] }))
      .filter((e): e is { row: PreviewRow; decision: Decision } => !!e.row);
    const reviewCounts = await runBatch(entries);
    const c = pendingCleanCounts.current;
    setConfirming(false);
    setReviewOpen(false);
    setReviewItems([]);
    toastCounts({
      imported: c.imported + reviewCounts.imported,
      merged: c.merged + reviewCounts.merged,
      skipped: c.skipped + reviewCounts.skipped,
      failed: c.failed + reviewCounts.failed,
    });
  };

  const csvHeaders = [
    'Name', 'First Name', 'Last Name', 'Headline', 'Title', 'Company',
    'Location', 'Email', 'Phone', 'LinkedIn URL', 'Stage', 'Has Resume', 'Candidate ID',
  ];
  const toCsvRow = (r: PreviewRow) => ({
    'Name': r.name,
    'First Name': r.first_name,
    'Last Name': r.last_name,
    'Headline': r.headline ?? '',
    'Title': r.current_title ?? '',
    'Company': r.current_company ?? '',
    'Location': r.location ?? '',
    'Email': r.email ?? '',
    'Phone': r.phone ?? '',
    'LinkedIn URL': r.linkedin_url ?? '',
    'Stage': STAGE_LABEL[r.stage] || r.stage,
    'Has Resume': r.has_resume ? 'Yes' : 'No',
    'Candidate ID': r.candidate_id ?? '',
  });
  const exportCsv = (onlySelected: boolean) => {
    const src = onlySelected ? rows.filter((r) => r.selected) : rows;
    if (src.length === 0) { toast.error('Nothing to export'); return; }
    downloadCsv(`linkedin-recruiter-${onlySelected ? 'selected' : 'all'}-${src.length}.csv`, csvHeaders, src.map(toCsvRow));
  };

  const statusBadge = (r: PreviewRow) => {
    if (r.status === 'importing') return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />;
    if (r.status === 'imported') return <span className="inline-flex items-center gap-1 text-xs text-emerald-600"><Check className="h-3 w-3" /> Imported</span>;
    if (r.status === 'merged') return <span className="inline-flex items-center gap-1 text-xs text-amber-600" title={r.statusMsg}><Check className="h-3 w-3" /> Merged</span>;
    if (r.status === 'skipped') return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={r.statusMsg}><X className="h-3 w-3" /> Skipped</span>;
    if (r.status === 'error') return <span className="inline-flex items-center gap-1 text-xs text-destructive" title={r.statusMsg}><X className="h-3 w-3" /> Failed</span>;
    return null;
  };

  return (
    <MainLayout>
      <PageHeader
        title="Import from LinkedIn Recruiter"
        description="Paste a LinkedIn Recruiter search or pipeline URL, pull the people, then download or import them as candidates or contacts."
      />

      <div className="bg-page-bg min-h-[calc(100vh-4rem)] px-4 sm:px-6 lg:px-8 py-6">
        <div className="max-w-6xl mx-auto space-y-5">
          {/* ── Search form ── */}
          <div className="rounded-xl border border-card-border bg-white p-5 space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Search on behalf of</label>
                <Select value={accountId} onValueChange={setAccountId}>
                  <SelectTrigger>
                    <SelectValue placeholder={accountsLoading ? 'Loading accounts…' : 'Choose a LinkedIn account…'} />
                  </SelectTrigger>
                  <SelectContent>
                    {liAccounts.map((a) => {
                      const id = accountUnipileId(a)!;
                      return (
                        <SelectItem key={a.id} value={id}>
                          <span className="flex items-center gap-2">
                            <Linkedin className="h-3.5 w-3.5" />
                            {accountLabel(a)}
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
                {!accountsLoading && liAccounts.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No LinkedIn seats with a v2 connection. Connect/reconnect a LinkedIn account in Settings → Integrations.
                  </p>
                )}
                {selectedAccount && (
                  <p className="text-[11px] text-muted-foreground">Pulling from <span className="font-medium">{accountLabel(selectedAccount)}</span></p>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Default import type</label>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={defaultType === 'candidate' ? 'gold' : 'outline'}
                    onClick={() => setDefaultType('candidate')}
                  >Candidates</Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={defaultType === 'contact' ? 'gold' : 'outline'}
                    onClick={() => setDefaultType('contact')}
                  >Contacts</Button>
                  <span className="text-[11px] text-muted-foreground">applied to new results; change per row below</span>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">LinkedIn Recruiter URL</label>
              <Textarea
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.linkedin.com/talent/search?..."
                rows={2}
                className="font-mono text-xs"
              />
            </div>

            <div className="flex items-center gap-3">
              <Button onClick={runSearch} disabled={loading || !accountId} variant="gold" className="gap-1.5">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                {loading ? 'Searching…' : 'Perform search'}
              </Button>
              {summary && (
                <span className="text-sm text-muted-foreground">
                  {summary.fetched} pulled{summary.total > summary.fetched ? ` of ${summary.total}` : ''}
                  {summary.truncated && ' · capped at 500'}
                </span>
              )}
            </div>
          </div>

          {/* ── Results ── */}
          {rows.length > 0 && (
            <div className="rounded-xl border border-card-border bg-white">
              <div className="flex flex-wrap items-center gap-2 border-b border-card-border p-3">
                <span className="text-sm font-medium">{importableSelected.length} selected</span>
                <span className="text-xs text-muted-foreground">· {rows.filter((r) => !r.importable).length} unnamed (CSV only)</span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">Set selected →</span>
                  <Button size="xs" variant="outline" onClick={() => setSelectedType('candidate')}>Candidate</Button>
                  <Button size="xs" variant="outline" onClick={() => setSelectedType('contact')}>Contact</Button>
                  <span className="mx-1 h-4 w-px bg-card-border" />
                  <Button size="xs" variant="outline" className="gap-1" onClick={() => exportCsv(false)}>
                    <Download className="h-3.5 w-3.5" /> CSV (all)
                  </Button>
                  <Button size="xs" variant="outline" className="gap-1" onClick={() => exportCsv(true)} disabled={rows.every((r) => !r.selected)}>
                    <Download className="h-3.5 w-3.5" /> CSV (selected)
                  </Button>
                  <Button size="xs" variant="gold" className="gap-1" onClick={importSelected} disabled={importing || importableSelected.length === 0}>
                    {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
                    Import {importableSelected.length || ''}
                  </Button>
                </div>
              </div>

              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox checked={allImportableSelected} onCheckedChange={(v) => toggleAll(!!v)} aria-label="Select all" />
                      </TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Title / Company</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Phone</TableHead>
                      <TableHead>Stage</TableHead>
                      <TableHead className="w-32">Import as</TableHead>
                      <TableHead className="w-24"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r._k} className={r.selected && r.importable ? 'bg-emerald-light/20' : undefined}>
                        <TableCell>
                          <Checkbox
                            checked={r.selected}
                            disabled={!r.importable}
                            onCheckedChange={(v) => patchRow(r._k, { selected: !!v })}
                            aria-label={`Select ${r.name}`}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-sm">{r.name}</span>
                            {r.linkedin_url && (
                              <a href={r.linkedin_url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground" title="Open LinkedIn">
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </div>
                          {!r.importable && <span className="text-[10px] text-amber-600">no name — CSV only</span>}
                          {r.headline && <div className="text-[11px] text-muted-foreground line-clamp-1 max-w-[260px]">{r.headline}</div>}
                        </TableCell>
                        <TableCell className="text-xs">
                          <div>{r.current_title || '—'}</div>
                          <div className="text-muted-foreground">{r.current_company || ''}</div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.location || '—'}</TableCell>
                        <TableCell className="text-xs">{r.email || <span className="text-muted-foreground">—</span>}</TableCell>
                        <TableCell className="text-xs">{r.phone || <span className="text-muted-foreground">—</span>}</TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="text-[10px] whitespace-nowrap">{STAGE_LABEL[r.stage] || r.stage}</Badge>
                        </TableCell>
                        <TableCell>
                          <Select value={r.type} onValueChange={(v) => patchRow(r._k, { type: v as PersonType })} disabled={!r.importable}>
                            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="candidate">Candidate</SelectItem>
                              <SelectItem value="contact">Contact</SelectItem>
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>{statusBadge(r)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>
      </div>

      <ImportMatchReviewDialog
        open={reviewOpen}
        onOpenChange={(o) => { if (!confirming) setReviewOpen(o); }}
        items={reviewItems}
        onConfirm={confirmReview}
        confirming={confirming}
      />
    </MainLayout>
  );
}
