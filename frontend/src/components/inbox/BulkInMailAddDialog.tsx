import { useState, useEffect, useCallback } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateCommsScope, invalidatePersonScope } from '@/lib/invalidate';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Loader2, CheckSquare, Square, Target, UserCheck, Users, UserPlus, Link2 } from 'lucide-react';

/** A selected inbox thread (the checked rows the user is bulk-adding). */
export interface BulkThread {
  id: string;
  sender_name?: string | null;
  candidate_id?: string | null;
  contact_id?: string | null;
  // Used to pull the sender's full LinkedIn profile when creating them new.
  external_conversation_id?: string | null;
  integration_account_id?: string | null;
}

interface Plan {
  thread_id: string;
  name: string;
  chat_id: string | null;
  integration_account_id: string | null;
  best: {
    id: string;
    type: 'candidate' | 'contact';
    name: string;
    title?: string | null;
    company?: string | null;
    confidence: 'high' | 'medium' | 'low';
  } | null;
}

/**
 * Bulk add the SELECTED InMail senders. For each checked thread we match the
 * sender (by name) against the CRM and, in one pass:
 *   • high/medium confidence → link the thread to that existing person
 *   • no confident match → create a new person (candidate or client) + link
 * Reuses /api/match-people, /api/update-person (link) and /api/add-person
 * (create + link), the same contracts the per-thread Add wizard uses.
 */
export function BulkInMailAddDialog({
  open,
  onOpenChange,
  threads,
  defaultType = 'candidate',
  onApplied,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  threads: BulkThread[];
  defaultType?: 'candidate' | 'client';
  onApplied?: () => void;
}) {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [createType, setCreateType] = useState<'candidate' | 'client'>(defaultType);

  const token = async () => (await supabase.auth.getSession()).data.session?.access_token || '';

  // Only act on threads that aren't already linked and have a usable name.
  const actionable = threads.filter(
    (t) => !t.candidate_id && !t.contact_id && (t.sender_name ?? '').trim(),
  );

  const match = useCallback(async () => {
    if (!actionable.length) { setPlans([]); return; }
    setLoading(true);
    try {
      const res = await fetch('/api/match-people', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({
          people: actionable.map((t) => ({ key: t.id, name: (t.sender_name ?? '').trim(), type: 'candidate' })),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const matchMap: Record<string, any[]> = data.matches ?? {};
      const next: Plan[] = actionable.map((t) => {
        const top = (matchMap[t.id] ?? [])[0];
        const strong = top && (top.confidence === 'high' || top.confidence === 'medium');
        return {
          thread_id: t.id,
          name: (t.sender_name ?? '').trim(),
          chat_id: t.external_conversation_id ?? null,
          integration_account_id: t.integration_account_id ?? null,
          best: strong
            ? {
                id: top.id,
                type: top.type,
                name: top.full_name || `${top.first_name ?? ''} ${top.last_name ?? ''}`.trim(),
                title: top.title,
                company: top.company,
                confidence: top.confidence,
              }
            : null,
        };
      });
      setPlans(next);
      setSelected(new Set(next.map((p) => p.thread_id)));
    } catch (err) {
      toast.error('Match failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads]);

  useEffect(() => {
    if (open) {
      setPlans([]);
      setSelected(new Set());
      setCreateType(defaultType);
      match();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const matched = plans.filter((p) => p.best);
  const unmatched = plans.filter((p) => !p.best);
  const linkCount = matched.filter((p) => selected.has(p.thread_id)).length;
  const createCount = unmatched.filter((p) => selected.has(p.thread_id)).length;

  const apply = async () => {
    if (linkCount + createCount === 0) { toast.info('Nothing selected'); return; }
    setApplying(true);
    let linked = 0, created = 0;
    const errors: string[] = [];
    try {
      const authHeader = `Bearer ${await token()}`;
      const results = await Promise.all(
        plans
          .filter((p) => selected.has(p.thread_id))
          .map(async (p) => {
            try {
              if (p.best) {
                // Link the thread to the matched person (no field overwrite).
                const res = await fetch('/api/update-person', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: authHeader },
                  body: JSON.stringify({
                    person_id: p.best.id,
                    type: p.best.type,
                    data: {},
                    conversation_id: p.thread_id,
                  }),
                });
                if (!res.ok) { errors.push(`${p.name}: link HTTP ${res.status}`); return null; }
                return 'linked';
              }
              // Pull as much of the sender's LinkedIn profile as Unipile can
              // resolve (chat sender object → direct profile, or a name search)
              // so the new person isn't just a bare name.
              const parts = p.name.split(/\s+/).filter(Boolean);
              const data: Record<string, any> = {
                first_name: parts[0] ?? p.name,
                last_name: parts.length > 1 ? parts.slice(1).join(' ') : '',
              };
              let providerId: string | undefined;
              try {
                const lr = await fetch('/api/lookup-linkedin', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: authHeader },
                  body: JSON.stringify({
                    name: p.name,
                    chat_id: p.chat_id || undefined,
                    integration_account_id: p.integration_account_id || undefined,
                  }),
                });
                if (lr.ok) {
                  const prof = await lr.json();
                  if (prof.first_name) data.first_name = prof.first_name;
                  if (prof.last_name) data.last_name = prof.last_name;
                  if (prof.title) data.title = prof.title;
                  if (prof.company_name) data.company = prof.company_name; // add-person reads data.company
                  if (prof.location) data.location = prof.location;
                  if (prof.photo) data.photo = prof.photo;
                  if (prof.linkedin_url) data.linkedin_url = prof.linkedin_url;
                  if (prof.email) data.email = prof.email;
                  if (prof.phone) data.phone = prof.phone;
                  if (prof.provider_id) providerId = prof.provider_id;
                }
              } catch { /* enrichment is best-effort — still create the person */ }

              const res = await fetch('/api/add-person', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: authHeader },
                body: JSON.stringify({ type: createType, data, conversation_id: p.thread_id, provider_id: providerId }),
              });
              if (!res.ok) { errors.push(`${p.name}: create HTTP ${res.status}`); return null; }
              return 'created';
            } catch (e: any) {
              errors.push(`${p.name}: ${e?.message || 'failed'}`);
              return null;
            }
          }),
      );
      linked = results.filter((r) => r === 'linked').length;
      created = results.filter((r) => r === 'created').length;

      const bits: string[] = [];
      if (linked) bits.push(`linked ${linked}`);
      if (created) bits.push(`created ${created}`);
      toast.success(bits.length ? `Done — ${bits.join(', ')}.` : 'Nothing applied.');
      if (errors.length) toast.error(`${errors.length} failed`);
      invalidatePersonScope(queryClient);
      invalidateCommsScope(queryClient);
      onApplied?.();
      onOpenChange(false);
    } catch (err) {
      toast.error('Apply failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setApplying(false);
    }
  };

  const Row = ({ p }: { p: Plan }) => {
    const checked = selected.has(p.thread_id);
    const b = p.best;
    const confClass = b
      ? b.confidence === 'high'
        ? 'bg-success/15 text-success border-success/30'
        : 'bg-warning/15 text-warning border-warning/30'
      : '';
    return (
      <button
        onClick={() => toggle(p.thread_id)}
        className={cn(
          'w-full flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
          checked ? 'border-accent/40 bg-accent/5' : 'border-border hover:bg-muted/40',
        )}
      >
        {checked ? <CheckSquare className="h-4 w-4 text-accent shrink-0" /> : <Square className="h-4 w-4 text-muted-foreground shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-sm">
            <span className="font-medium text-foreground truncate">{p.name || 'Unknown sender'}</span>
            <span className="text-muted-foreground">→</span>
            {b ? (
              <>
                {b.type === 'candidate' ? <UserCheck className="h-3.5 w-3.5 text-success shrink-0" /> : <Users className="h-3.5 w-3.5 text-info shrink-0" />}
                <span className="font-medium text-foreground truncate">{b.name}</span>
                <Badge variant="outline" className={cn('text-[9px] uppercase shrink-0 capitalize', confClass)}>{b.confidence}</Badge>
              </>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-accent"><UserPlus className="h-3.5 w-3.5" /> New {createType}</span>
            )}
          </div>
          {b && (b.title || b.company) && (
            <p className="text-xs text-muted-foreground truncate">{[b.title, b.company].filter(Boolean).join(' @ ')}</p>
          )}
        </div>
      </button>
    );
  };

  const alreadyLinked = threads.length - actionable.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Target className="h-5 w-5 text-accent" />
            Bulk add {actionable.length} selected sender{actionable.length === 1 ? '' : 's'}
          </DialogTitle>
          <DialogDescription>
            Each selected InMail sender is matched to your CRM by name. High/medium matches link
            to the existing person; the rest are created new.
            {alreadyLinked > 0 && ` (${alreadyLinked} already linked — skipped.)`}
          </DialogDescription>
        </DialogHeader>

        {!loading && unmatched.length > 0 && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Create new as:</span>
            <div className="inline-flex rounded-lg border border-card-border bg-card p-0.5">
              {(['candidate', 'client'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setCreateType(t)}
                  className={cn('rounded-md px-2.5 py-1 font-medium capitalize transition-colors', createType === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        <ScrollArea className="flex-1 min-h-0 -mx-6 px-6">
          {loading ? (
            <div className="flex flex-col items-center py-16 gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-accent" />
              <p className="text-sm text-muted-foreground">Matching selected senders…</p>
            </div>
          ) : plans.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              {threads.length === 0
                ? 'No threads selected. Tick the senders you want to add, then try again.'
                : 'The selected threads are already linked or have no sender name.'}
            </div>
          ) : (
            <div className="py-3 space-y-4">
              {matched.length > 0 && (
                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <Link2 className="h-3 w-3" /> Link to existing ({matched.length})
                  </p>
                  {matched.map((p) => <Row key={p.thread_id} p={p} />)}
                </div>
              )}
              {unmatched.length > 0 && (
                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <UserPlus className="h-3 w-3" /> Create new ({unmatched.length})
                  </p>
                  {unmatched.map((p) => <Row key={p.thread_id} p={p} />)}
                </div>
              )}
            </div>
          )}
        </ScrollArea>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={applying}>Cancel</Button>
          <Button variant="gold" onClick={apply} disabled={applying || loading || linkCount + createCount === 0} className="gap-1.5">
            {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {linkCount + createCount > 0 ? `Link ${linkCount} · Create ${createCount}` : 'Apply'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
