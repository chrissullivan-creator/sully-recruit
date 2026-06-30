import { useState, useEffect, useCallback } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateCommsScope } from '@/lib/invalidate';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Loader2, CheckSquare, Square, Target, UserCheck, Users, UserPlus, Link2 } from 'lucide-react';

interface Proposal {
  conversation_id: string;
  channel: string;
  sender_name: string | null;
  sender_address: string | null;
  best: {
    id: string;
    type: 'candidate' | 'contact';
    name: string;
    title?: string | null;
    company?: string | null;
    confidence: 'high' | 'medium' | 'low';
    matched_on?: string[];
  } | null;
}

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const isLinkedin = (s: string) => /linkedin\.com\/in\//i.test(s);

/**
 * Bulk add for unknown InMail senders. Scans unlinked InMail (recruiter)
 * conversations, fuzzy-matches each sender to the CRM, and in one pass:
 *   • high/medium confidence match → links the thread to that person
 *   • no match → creates a brand-new person (candidate or client) + links
 * Matched links reuse /api/inbox/reconcile-unknown; creates reuse /api/add-person
 * (which dedupes, links the conversation, and caches the provider id).
 */
export function BulkInMailAddDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanned, setScanned] = useState(0);
  const [createType, setCreateType] = useState<'candidate' | 'client'>('candidate');

  const token = async () => (await supabase.auth.getSession()).data.session?.access_token || '';

  const scan = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/inbox/reconcile-unknown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ mode: 'scan', channel: 'linkedin_recruiter', include_unmatched: true, limit: 100 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const props: Proposal[] = data.proposals ?? [];
      setProposals(props);
      setScanned(data.scanned ?? props.length);
      // Pre-check everything actionable — match-or-create in one sweep.
      setSelected(new Set(props.map((p) => p.conversation_id)));
    } catch (err) {
      toast.error('Scan failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setProposals([]);
      setSelected(new Set());
      scan();
    }
  }, [open, scan]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const matched = proposals.filter((p) => p.best);
  const unmatched = proposals.filter((p) => !p.best && p.sender_name);
  const linkCount = matched.filter((p) => selected.has(p.conversation_id)).length;
  const createCount = unmatched.filter((p) => selected.has(p.conversation_id)).length;

  const apply = async () => {
    if (linkCount + createCount === 0) {
      toast.info('Nothing selected');
      return;
    }
    setApplying(true);
    let linked = 0;
    let created = 0;
    const errors: string[] = [];
    try {
      // 1) Link the confident matches in one reconcile call.
      const linkActions = matched
        .filter((p) => selected.has(p.conversation_id))
        .map((p) => ({ conversation_id: p.conversation_id, person_id: p.best!.id, type: p.best!.type }));
      if (linkActions.length) {
        const res = await fetch('/api/inbox/reconcile-unknown', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
          body: JSON.stringify({ mode: 'apply', actions: linkActions }),
        });
        if (!res.ok) throw new Error(`Link HTTP ${res.status}`);
        const data = await res.json();
        linked = data.linked ?? 0;
        if (Array.isArray(data.errors)) errors.push(...data.errors);
      }

      // 2) Create the no-match senders (+ link their thread) via add-person.
      const toCreate = unmatched.filter((p) => selected.has(p.conversation_id));
      const authHeader = `Bearer ${await token()}`;
      const results = await Promise.all(
        toCreate.map(async (p) => {
          const name = (p.sender_name ?? '').trim();
          const parts = name.split(/\s+/).filter(Boolean);
          const addr = (p.sender_address ?? '').trim();
          const data: Record<string, any> = {
            first_name: parts[0] ?? name,
            last_name: parts.length > 1 ? parts.slice(1).join(' ') : '',
          };
          if (isEmail(addr)) data.email = addr;
          if (isLinkedin(addr)) data.linkedin_url = addr;
          try {
            const res = await fetch('/api/add-person', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: authHeader },
              body: JSON.stringify({
                type: createType,
                data,
                conversation_id: p.conversation_id,
                // InMail sender_address is a LinkedIn provider id, not an email.
                provider_id: addr && !isEmail(addr) ? addr : undefined,
              }),
            });
            if (!res.ok) { errors.push(`${name}: HTTP ${res.status}`); return false; }
            return true;
          } catch (e: any) {
            errors.push(`${name}: ${e?.message || 'failed'}`);
            return false;
          }
        }),
      );
      created = results.filter(Boolean).length;

      const bits: string[] = [];
      if (linked) bits.push(`linked ${linked}`);
      if (created) bits.push(`created ${created}`);
      toast.success(bits.length ? `Done — ${bits.join(', ')}.` : 'Nothing to apply.');
      if (errors.length) toast.error(`${errors.length} failed`);
      invalidateCommsScope(queryClient);
      onOpenChange(false);
    } catch (err) {
      toast.error('Apply failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setApplying(false);
    }
  };

  const Row = ({ p }: { p: Proposal }) => {
    const checked = selected.has(p.conversation_id);
    const b = p.best;
    const confClass = b
      ? b.confidence === 'high'
        ? 'bg-success/15 text-success border-success/30'
        : 'bg-warning/15 text-warning border-warning/30'
      : '';
    return (
      <button
        onClick={() => toggle(p.conversation_id)}
        className={cn(
          'w-full flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
          checked ? 'border-accent/40 bg-accent/5' : 'border-border hover:bg-muted/40',
        )}
      >
        {checked ? (
          <CheckSquare className="h-4 w-4 text-accent shrink-0" />
        ) : (
          <Square className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-sm">
            <span className="font-medium text-foreground truncate">{p.sender_name || 'Unknown sender'}</span>
            <span className="text-muted-foreground">→</span>
            {b ? (
              <>
                {b.type === 'candidate' ? (
                  <UserCheck className="h-3.5 w-3.5 text-success shrink-0" />
                ) : (
                  <Users className="h-3.5 w-3.5 text-info shrink-0" />
                )}
                <span className="font-medium text-foreground truncate">{b.name}</span>
                <Badge variant="outline" className={cn('text-[9px] uppercase shrink-0 capitalize', confClass)}>
                  {b.confidence}
                </Badge>
              </>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-accent">
                <UserPlus className="h-3.5 w-3.5" /> New {createType}
              </span>
            )}
          </div>
          {b && (b.title || b.company) && (
            <p className="text-xs text-muted-foreground truncate">{[b.title, b.company].filter(Boolean).join(' @ ')}</p>
          )}
        </div>
      </button>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Target className="h-5 w-5 text-accent" />
            Bulk add InMail senders
          </DialogTitle>
          <DialogDescription>
            We matched each unknown InMail sender to your CRM. High/medium matches link to the
            existing person; the rest are created new. Review and apply in one pass.
          </DialogDescription>
        </DialogHeader>

        {/* Create-as type for the no-match rows */}
        {!loading && unmatched.length > 0 && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Create new as:</span>
            <div className="inline-flex rounded-lg border border-card-border bg-card p-0.5">
              {(['candidate', 'client'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setCreateType(t)}
                  className={cn(
                    'rounded-md px-2.5 py-1 font-medium capitalize transition-colors',
                    createType === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
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
              <p className="text-sm text-muted-foreground">Scanning unlinked InMail conversations…</p>
            </div>
          ) : proposals.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              No unlinked InMail senders found{scanned ? ` across ${scanned} conversations` : ''}.
            </div>
          ) : (
            <div className="py-3 space-y-4">
              {matched.length > 0 && (
                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <Link2 className="h-3 w-3" /> Link to existing ({matched.length})
                  </p>
                  {matched.map((p) => <Row key={p.conversation_id} p={p} />)}
                </div>
              )}
              {unmatched.length > 0 && (
                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <UserPlus className="h-3 w-3" /> Create new ({unmatched.length})
                  </p>
                  {unmatched.map((p) => <Row key={p.conversation_id} p={p} />)}
                </div>
              )}
            </div>
          )}
        </ScrollArea>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={applying}>Cancel</Button>
          <Button
            variant="gold"
            onClick={apply}
            disabled={applying || loading || linkCount + createCount === 0}
            className="gap-1.5"
          >
            {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {linkCount + createCount > 0
              ? `Link ${linkCount} · Create ${createCount}`
              : 'Apply'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
