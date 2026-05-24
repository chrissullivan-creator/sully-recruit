import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { authHeaders } from '@/lib/api-auth';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  RefreshCw, Plus, X, Trash2, ExternalLink, Briefcase, Loader2, Sparkles,
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';

/**
 * Companies → "Job postings" tab. Owns three concerns:
 *   1. Career-URL management (a company can have N pages — RBC parent
 *      vs. RBC Capital Markets vs. RBC Wealth Management).
 *   2. Posting list + bulk actions (delete / convert to lead).
 *   3. Detail sheet for a single posting (full description + per-row
 *      actions duplicated from the list).
 *
 * Fetching is incremental — the API uses each career_url's
 * last_fetched_at as a `since` filter on PDL job/search, so only new
 * postings come back. Re-pressing the button mid-day pulls a delta;
 * pressing it after no changes pulls nothing.
 *
 * "Delete" is a soft delete (sets dismissed_at). The fetcher's dedup
 * on (company_id, external_id) means a dismissed posting won't get
 * resurrected on the next refresh.
 */

interface JobPostingsTabProps {
  companyId: string;
  companyName: string;
}

type Posting = {
  id: string;
  company_id: string;
  external_id: string;
  title: string | null;
  location: string | null;
  employment_type: string | null;
  seniority: string | null;
  description: string | null;
  posted_at: string | null;
  source_url: string | null;
  dismissed_at: string | null;
  lead_id: string | null;
  fetched_at: string;
  converted_to_lead_at: string | null;
};

type CareerUrl = {
  id: string;
  company_id: string;
  label: string | null;
  url: string;
  last_fetched_at: string | null;
  last_fetched_status: string | null;
  last_fetched_error: string | null;
};

export function JobPostingsTab({ companyId, companyName }: JobPostingsTabProps) {
  const qc = useQueryClient();
  const [showDismissed, setShowDismissed] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activePosting, setActivePosting] = useState<Posting | null>(null);
  const [fetching, setFetching] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  // ── data ──────────────────────────────────────────────────────
  const { data: postings = [], isLoading } = useQuery({
    queryKey: ['company_job_postings', companyId, showDismissed],
    queryFn: async () => {
      const query = supabase
        .from('company_job_postings')
        .select('*')
        .eq('company_id', companyId)
        .order('posted_at', { ascending: false, nullsFirst: false });
      const { data, error } = showDismissed
        ? await query.not('dismissed_at', 'is', null)
        : await query.is('dismissed_at', null);
      if (error) throw error;
      return data as Posting[];
    },
  });

  const { data: careerUrls = [] } = useQuery({
    queryKey: ['company_career_urls', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('company_career_urls')
        .select('*')
        .eq('company_id', companyId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data as CareerUrl[];
    },
  });

  const newestLastFetch = useMemo(() => {
    const stamps = (careerUrls ?? [])
      .map((u) => u.last_fetched_at)
      .filter((x): x is string => !!x)
      .sort((a, b) => b.localeCompare(a));
    return stamps[0] ?? null;
  }, [careerUrls]);

  const allSelected = postings.length > 0 && selectedIds.length === postings.length;
  const someSelected = selectedIds.length > 0 && selectedIds.length < postings.length;

  // ── actions ───────────────────────────────────────────────────
  const fetchPostings = async () => {
    setFetching(true);
    try {
      const res = await fetch('/api/companies/fetch-job-postings', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ companyIds: [companyId] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Fetch failed');
      const result = data.results?.[0];
      if (!result?.ok) {
        toast.error(result?.error || 'No career URLs and no domain on this company');
        return;
      }
      toast.success(
        `${result.new_postings} new posting${result.new_postings === 1 ? '' : 's'}` +
        ` — ${result.total_active} active total`,
      );
      qc.invalidateQueries({ queryKey: ['company_job_postings', companyId] });
      qc.invalidateQueries({ queryKey: ['company_career_urls', companyId] });
    } catch (err: any) {
      toast.error(err.message || 'Fetch failed');
    } finally {
      setFetching(false);
    }
  };

  const dismissPostings = async (ids: string[]) => {
    setBulkBusy(true);
    try {
      const res = await fetch('/api/job-postings/dismiss', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ postingIds: ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Dismiss failed');
      toast.success(`Dismissed ${data.dismissed} posting${data.dismissed === 1 ? '' : 's'}`);
      setSelectedIds([]);
      setActivePosting(null);
      qc.invalidateQueries({ queryKey: ['company_job_postings', companyId] });
    } catch (err: any) {
      toast.error(err.message || 'Dismiss failed');
    } finally {
      setBulkBusy(false);
    }
  };

  const convertToLeads = async (ids: string[]) => {
    setBulkBusy(true);
    try {
      const res = await fetch('/api/job-postings/convert-to-lead', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ postingIds: ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Convert failed');
      toast.success(
        `Created ${data.counts.created} lead${data.counts.created === 1 ? '' : 's'}` +
        (data.counts.already_converted > 0 ? ` (${data.counts.already_converted} already converted)` : '') +
        (data.counts.failed > 0 ? ` — ${data.counts.failed} failed` : ''),
      );
      setSelectedIds([]);
      setActivePosting(null);
      qc.invalidateQueries({ queryKey: ['company_job_postings', companyId] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
    } catch (err: any) {
      toast.error(err.message || 'Convert failed');
    } finally {
      setBulkBusy(false);
    }
  };

  const toggleAll = () => {
    setSelectedIds(allSelected ? [] : postings.map((p) => p.id));
  };
  const toggleOne = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  return (
    <div className="space-y-5">
      {/* ── Header: fetch button + last-sync stamp ─────────────── */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Briefcase className="h-5 w-5 text-accent" />
          <h2 className="text-base font-semibold">Job postings</h2>
          <span className="text-xs text-muted-foreground">({postings.length})</span>
        </div>
        <div className="flex items-center gap-2">
          {newestLastFetch && (
            <span className="text-[11px] text-muted-foreground">
              Last sync {formatDistanceToNow(new Date(newestLastFetch), { addSuffix: true })}
            </span>
          )}
          <Button size="sm" variant="gold" onClick={fetchPostings} disabled={fetching}>
            {fetching
              ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
            Fetch postings
          </Button>
        </div>
      </div>

      {/* ── Career URLs management ─────────────────────────────── */}
      <CareerUrlsSection companyId={companyId} careerUrls={careerUrls} />

      {/* ── Filter + bulk action bar ───────────────────────────── */}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
        <div className="flex items-center gap-3">
          <button
            className={`text-xs ${!showDismissed ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
            onClick={() => { setShowDismissed(false); setSelectedIds([]); }}
          >
            Active
          </button>
          <span className="text-muted-foreground/50">•</span>
          <button
            className={`text-xs ${showDismissed ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
            onClick={() => { setShowDismissed(true); setSelectedIds([]); }}
          >
            Dismissed
          </button>
        </div>
        {selectedIds.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{selectedIds.length} selected</span>
            {!showDismissed && (
              <>
                <Button size="sm" variant="outline" disabled={bulkBusy}
                  onClick={() => convertToLeads(selectedIds)}>
                  <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                  Add to leads
                </Button>
                <Button size="sm" variant="outline" disabled={bulkBusy}
                  onClick={() => dismissPostings(selectedIds)}>
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                  Delete
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Posting list ───────────────────────────────────────── */}
      {isLoading ? (
        <div className="text-sm text-muted-foreground italic">Loading…</div>
      ) : postings.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <Briefcase className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium mb-1">
            {showDismissed ? 'No dismissed postings' : 'No active postings'}
          </p>
          <p className="text-xs text-muted-foreground">
            {showDismissed
              ? 'Dismissed postings show up here.'
              : `Press "Fetch postings" to pull current openings at ${companyName}.`}
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {/* select-all row */}
          <div className="flex items-center gap-3 px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            <Checkbox
              checked={allSelected ? true : someSelected ? 'indeterminate' : false}
              onCheckedChange={toggleAll}
              className="h-3.5 w-3.5"
            />
            <span className="flex-1">Title</span>
            <span className="w-32 hidden sm:block">Location</span>
            <span className="w-24 hidden md:block">Seniority</span>
            <span className="w-24">Posted</span>
          </div>
          {postings.map((p) => (
            <PostingRow
              key={p.id}
              posting={p}
              selected={selectedIds.includes(p.id)}
              onToggle={() => toggleOne(p.id)}
              onOpen={() => setActivePosting(p)}
            />
          ))}
        </div>
      )}

      {/* ── Detail sheet ───────────────────────────────────────── */}
      <PostingDetailSheet
        posting={activePosting}
        onClose={() => setActivePosting(null)}
        onDismiss={(id) => dismissPostings([id])}
        onConvert={(id) => convertToLeads([id])}
        busy={bulkBusy}
      />
    </div>
  );
}

/* ─────────────────────────── sub-components ────────────────────── */

function PostingRow({ posting, selected, onToggle, onOpen }: {
  posting: Posting;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 px-3 py-2 rounded-md border border-card-border bg-card hover:bg-accent/5 cursor-pointer transition-colors ${selected ? 'ring-1 ring-accent/30' : ''}`}
      onClick={onOpen}
    >
      <div onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={selected} onCheckedChange={onToggle} className="h-3.5 w-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{posting.title || 'Untitled'}</span>
          {posting.lead_id && <Badge variant="outline" className="text-[10px]">Lead created</Badge>}
        </div>
        {posting.employment_type && (
          <span className="text-[11px] text-muted-foreground">{posting.employment_type}</span>
        )}
      </div>
      <span className="w-32 text-xs text-muted-foreground hidden sm:block truncate">
        {posting.location || '—'}
      </span>
      <span className="w-24 text-xs text-muted-foreground hidden md:block truncate">
        {posting.seniority || '—'}
      </span>
      <span className="w-24 text-xs text-muted-foreground">
        {posting.posted_at ? formatDistanceToNow(new Date(posting.posted_at), { addSuffix: true }) : '—'}
      </span>
    </div>
  );
}

function PostingDetailSheet({ posting, onClose, onDismiss, onConvert, busy }: {
  posting: Posting | null;
  onClose: () => void;
  onDismiss: (id: string) => void;
  onConvert: (id: string) => void;
  busy: boolean;
}) {
  return (
    <Sheet open={!!posting} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-hidden flex flex-col">
        {posting && (
          <>
            <SheetHeader>
              <SheetTitle className="text-base">{posting.title || 'Untitled posting'}</SheetTitle>
              <SheetDescription className="text-xs">
                {posting.location && <span>{posting.location} • </span>}
                {posting.employment_type && <span>{posting.employment_type} • </span>}
                Posted {posting.posted_at ? format(new Date(posting.posted_at), 'MMM d, yyyy') : 'unknown'}
              </SheetDescription>
            </SheetHeader>

            <div className="flex items-center gap-2 pt-3 pb-2 border-b border-border">
              {posting.lead_id ? (
                <Badge variant="outline" className="text-xs">Already a lead</Badge>
              ) : posting.dismissed_at ? (
                <Badge variant="outline" className="text-xs">Dismissed</Badge>
              ) : (
                <>
                  <Button size="sm" variant="gold" disabled={busy}
                    onClick={() => onConvert(posting.id)}>
                    <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                    Add to leads
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy}
                    onClick={() => onDismiss(posting.id)}>
                    <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                    Delete
                  </Button>
                </>
              )}
              {posting.source_url && (
                <Button size="sm" variant="ghost" asChild>
                  <a href={posting.source_url} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                    Open posting
                  </a>
                </Button>
              )}
            </div>

            <ScrollArea className="flex-1 mt-3">
              <div className="text-sm whitespace-pre-wrap text-foreground/90">
                {posting.description || (
                  <span className="text-muted-foreground italic">
                    No description on this posting.
                  </span>
                )}
              </div>
            </ScrollArea>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function CareerUrlsSection({ companyId, careerUrls }: {
  companyId: string;
  careerUrls: CareerUrl[];
}) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [saving, setSaving] = useState(false);

  const addUrl = async () => {
    if (!newUrl.trim()) return;
    setSaving(true);
    try {
      const { error } = await supabase.from('company_career_urls').insert({
        company_id: companyId,
        url: newUrl.trim(),
        label: newLabel.trim() || null,
      });
      if (error) throw error;
      setNewUrl(''); setNewLabel(''); setAdding(false);
      qc.invalidateQueries({ queryKey: ['company_career_urls', companyId] });
      toast.success('Career URL added');
    } catch (err: any) {
      toast.error(err.message || 'Failed to add URL');
    } finally {
      setSaving(false);
    }
  };

  const removeUrl = async (id: string) => {
    try {
      const { error } = await supabase.from('company_career_urls').delete().eq('id', id);
      if (error) throw error;
      qc.invalidateQueries({ queryKey: ['company_career_urls', companyId] });
      toast.success('Career URL removed');
    } catch (err: any) {
      toast.error(err.message || 'Failed to remove URL');
    }
  };

  return (
    <div className="rounded-md border border-card-border bg-secondary/30 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium">Career URLs</p>
          <p className="text-[10px] text-muted-foreground">
            Add separate pages for subsidiaries (e.g. RBC Capital Markets, RBC Wealth).
          </p>
        </div>
        {!adding && (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add URL
          </Button>
        )}
      </div>

      {careerUrls.length === 0 && !adding && (
        <p className="text-xs text-muted-foreground italic">
          None yet — fetcher will fall back to the company domain.
        </p>
      )}

      {careerUrls.map((cu) => (
        <div key={cu.id} className="flex items-center gap-2 text-xs">
          <span className="font-medium truncate w-28 shrink-0">{cu.label || '—'}</span>
          <a href={cu.url} target="_blank" rel="noreferrer"
            className="text-accent hover:underline truncate flex-1 min-w-0">
            {cu.url}
          </a>
          {cu.last_fetched_at && (
            <span className="text-[10px] text-muted-foreground shrink-0">
              {formatDistanceToNow(new Date(cu.last_fetched_at), { addSuffix: true })}
            </span>
          )}
          <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0"
            onClick={() => removeUrl(cu.id)}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}

      {adding && (
        <div className="flex items-end gap-2 pt-1">
          <div className="space-y-1 w-32 shrink-0">
            <Label className="text-[10px]">Label</Label>
            <Input value={newLabel} onChange={(e) => setNewLabel(e.target.value)}
              className="h-7 text-xs" placeholder="e.g. RBC Cap Mkts" />
          </div>
          <div className="space-y-1 flex-1">
            <Label className="text-[10px]">URL</Label>
            <Input value={newUrl} onChange={(e) => setNewUrl(e.target.value)}
              className="h-7 text-xs" placeholder="https://..."
              onKeyDown={(e) => { if (e.key === 'Enter') addUrl(); }} />
          </div>
          <Button size="sm" onClick={addUrl} disabled={saving || !newUrl.trim()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Add'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => {
            setAdding(false); setNewUrl(''); setNewLabel('');
          }}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
