import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ExternalLink, GitMerge, UserPlus, SkipForward, ArrowRight } from 'lucide-react';

/** Subset of the server-side ScoredMatch we render. */
export interface PersonMatch {
  id: string;
  type: 'candidate' | 'client' | 'contact';
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  title: string | null;
  company: string | null;
  confidence: 'high' | 'medium' | 'low';
  matched_on: string[];
  score: number;
}

/** The incoming (LinkedIn) side of a comparison. */
export interface IncomingPerson {
  key: string;
  name: string;
  title: string | null;
  company: string | null;
  location: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
}

export interface ReviewItem {
  row: IncomingPerson;
  matches: PersonMatch[];
}

export type DecisionAction = 'merge' | 'new' | 'skip';
export interface Decision {
  action: DecisionAction;
  mergeTargetId?: string;
  mergeTargetType?: 'candidate' | 'client';
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ReviewItem[];
  /** Confirm with one decision per item, keyed by row.key. */
  onConfirm: (decisions: Record<string, Decision>) => void;
  confirming?: boolean;
}

const CONF_STYLE: Record<string, string> = {
  high: 'bg-destructive/10 text-destructive border-destructive/30',
  medium: 'bg-amber-100 text-amber-700 border-amber-300',
  low: 'bg-muted text-muted-foreground border-border',
};

function defaultDecision(item: ReviewItem): Decision {
  const best = item.matches[0];
  if (best && best.confidence === 'high') {
    return { action: 'merge', mergeTargetId: best.id, mergeTargetType: best.type === 'candidate' ? 'candidate' : 'client' };
  }
  // Medium/low: don't auto-merge — default to keeping both so we never silently
  // collapse two different people. The user opts in to a merge.
  return { action: 'new' };
}

function Field({ label, value, strong }: { label: string; value: string | null; strong?: boolean }) {
  return (
    <div className="flex gap-1.5 text-xs">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <span className={`min-w-0 break-words ${value ? (strong ? 'font-medium text-foreground' : 'text-foreground') : 'text-muted-foreground'}`}>
        {value || '—'}
      </span>
    </div>
  );
}

export function ImportMatchReviewDialog({ open, onOpenChange, items, onConfirm, confirming }: Props) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>(() => {
    const d: Record<string, Decision> = {};
    for (const it of items) d[it.row.key] = defaultDecision(it);
    return d;
  });

  // Re-seed defaults whenever a fresh batch is opened.
  const itemsKey = items.map((i) => i.row.key).join('|');
  useEffect(() => {
    const d: Record<string, Decision> = {};
    for (const it of items) d[it.row.key] = defaultDecision(it);
    setDecisions(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey]);

  const setAction = (key: string, action: DecisionAction, item: ReviewItem) => {
    setDecisions((prev) => {
      const best = item.matches[0];
      const next: Decision = { action };
      if (action === 'merge') {
        const target = prev[key]?.mergeTargetId
          ? item.matches.find((m) => m.id === prev[key].mergeTargetId) || best
          : best;
        next.mergeTargetId = target?.id;
        next.mergeTargetType = target?.type === 'candidate' ? 'candidate' : 'client';
      }
      return { ...prev, [key]: next };
    });
  };

  const setTarget = (key: string, item: ReviewItem, targetId: string) => {
    const target = item.matches.find((m) => m.id === targetId);
    setDecisions((prev) => ({
      ...prev,
      [key]: { action: 'merge', mergeTargetId: targetId, mergeTargetType: target?.type === 'candidate' ? 'candidate' : 'client' },
    }));
  };

  const counts = useMemo(() => {
    let merge = 0, neu = 0, skip = 0;
    for (const it of items) {
      const a = decisions[it.row.key]?.action ?? 'new';
      if (a === 'merge') merge++; else if (a === 'skip') skip++; else neu++;
    }
    return { merge, neu, skip };
  }, [decisions, items]);

  const matchSummary = (m: PersonMatch) => {
    const detail = m.title && m.company ? `${m.title} · ${m.company}` : (m.title || m.company || '');
    return `${m.full_name || `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim() || 'Unnamed'}${detail ? ` — ${detail}` : ''}`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Review {items.length} possible duplicate{items.length === 1 ? '' : 's'}</DialogTitle>
          <DialogDescription>
            These imports look like people you already have. Merge to update the existing record
            from LinkedIn (keeps their email &amp; phone; refreshes title, company, LinkedIn URL &amp;
            experience), keep both as separate people, or skip.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 -mx-2 px-2">
          <div className="space-y-3 py-1">
            {items.map((item) => {
              const d = decisions[item.row.key] ?? { action: 'new' as DecisionAction };
              const best = item.matches[0];
              const target = item.matches.find((m) => m.id === d.mergeTargetId) || best;
              return (
                <div key={item.row.key} className="rounded-lg border border-card-border bg-white p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-sm font-semibold">{item.row.name}</span>
                    {best && (
                      <Badge variant="outline" className={`text-[10px] ${CONF_STYLE[best.confidence]}`}>
                        {best.confidence} match
                      </Badge>
                    )}
                    {best?.matched_on?.length ? (
                      <span className="text-[10px] text-muted-foreground">on {best.matched_on.join(', ')}</span>
                    ) : null}
                  </div>

                  <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
                    {/* Incoming (LinkedIn) */}
                    <div className="rounded-md border border-border/60 bg-muted/30 p-2.5 space-y-1">
                      <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        From LinkedIn
                        {item.row.linkedin_url && (
                          <a href={item.row.linkedin_url} target="_blank" rel="noreferrer" className="hover:text-foreground" title="Open LinkedIn">
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                      <Field label="Title" value={item.row.title} strong />
                      <Field label="Company" value={item.row.company} />
                      <Field label="Location" value={item.row.location} />
                      <Field label="Email" value={item.row.email} />
                      <Field label="Phone" value={item.row.phone} />
                    </div>

                    <ArrowRight className="mx-auto hidden h-4 w-4 text-muted-foreground sm:block" />

                    {/* Existing (Sully Recruit) */}
                    <div className="rounded-md border border-border/60 bg-emerald-light/10 p-2.5 space-y-1">
                      <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        In Sully Recruit
                        {target?.linkedin_url && (
                          <a href={target.linkedin_url} target="_blank" rel="noreferrer" className="hover:text-foreground" title="Open LinkedIn">
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                      <Field label="Title" value={target?.title ?? null} />
                      <Field label="Company" value={target?.company ?? null} />
                      <Field label="Email" value={target?.email ?? null} strong />
                      <Field label="Phone" value={target?.phone ?? null} strong />
                    </div>
                  </div>

                  {/* Pick which existing person to merge into, when there are several. */}
                  {d.action === 'merge' && item.matches.length > 1 && (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-[11px] text-muted-foreground">Merge into</span>
                      <Select value={d.mergeTargetId} onValueChange={(v) => setTarget(item.row.key, item, v)}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {item.matches.map((m) => (
                            <SelectItem key={m.id} value={m.id} className="text-xs">{matchSummary(m)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* Action toggle */}
                  <div className="mt-2.5 flex items-center gap-1.5">
                    <Button
                      size="xs"
                      variant={d.action === 'merge' ? 'gold' : 'outline'}
                      className="gap-1"
                      onClick={() => setAction(item.row.key, 'merge', item)}
                    >
                      <GitMerge className="h-3.5 w-3.5" /> Merge &amp; update
                    </Button>
                    <Button
                      size="xs"
                      variant={d.action === 'new' ? 'gold' : 'outline'}
                      className="gap-1"
                      onClick={() => setAction(item.row.key, 'new', item)}
                    >
                      <UserPlus className="h-3.5 w-3.5" /> Keep both
                    </Button>
                    <Button
                      size="xs"
                      variant={d.action === 'skip' ? 'gold' : 'outline'}
                      className="gap-1"
                      onClick={() => setAction(item.row.key, 'skip', item)}
                    >
                      <SkipForward className="h-3.5 w-3.5" /> Skip
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {counts.merge} merge · {counts.neu} keep both · {counts.skip} skip
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={confirming}>
              Cancel
            </Button>
            <Button variant="gold" size="sm" onClick={() => onConfirm(decisions)} disabled={confirming}>
              {confirming ? 'Importing…' : 'Confirm import'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
