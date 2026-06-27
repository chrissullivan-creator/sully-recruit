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
import { Loader2, CheckSquare, Square, Martini, UserCheck, Users } from 'lucide-react';

interface Proposal {
  conversation_id: string;
  channel: string;
  sender_name: string | null;
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

/**
 * Bulk "reconcile unknown senders" — scans unlinked conversations, fuzzy-matches
 * each sender to an existing CRM person, and lets the user link the confident
 * ones in one pass. Link-only (the per-thread Add flow handles enrich+overwrite
 * and creating brand-new people).
 */
export function ReconcileUnknownDialog({
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

  const token = async () => (await supabase.auth.getSession()).data.session?.access_token || '';

  const scan = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/inbox/reconcile-unknown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ mode: 'scan', limit: 100 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const props: Proposal[] = data.proposals ?? [];
      setProposals(props);
      setScanned(data.scanned ?? props.length);
      // Pre-check the high-confidence matches.
      setSelected(new Set(props.filter((p) => p.best?.confidence === 'high').map((p) => p.conversation_id)));
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

  const apply = async () => {
    const actions = proposals
      .filter((p) => p.best && selected.has(p.conversation_id))
      .map((p) => ({ conversation_id: p.conversation_id, person_id: p.best!.id, type: p.best!.type }));
    if (!actions.length) {
      toast.info('Nothing selected');
      return;
    }
    setApplying(true);
    try {
      const res = await fetch('/api/inbox/reconcile-unknown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ mode: 'apply', actions }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      toast.success(`Linked ${data.linked ?? 0} conversation${data.linked === 1 ? '' : 's'}`);
      invalidateCommsScope(queryClient);
      onOpenChange(false);
    } catch (err) {
      toast.error('Apply failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Martini className="h-5 w-5 text-accent" />
            Match unknown senders
          </DialogTitle>
          <DialogDescription>
            We fuzzy-matched unknown senders (name, firm &amp; title) to people already in your
            CRM. Review and link the right ones. Creating new people is done from each thread.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 -mx-6 px-6">
          {loading ? (
            <div className="flex flex-col items-center py-16 gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-accent" />
              <p className="text-sm text-muted-foreground">Scanning unlinked conversations…</p>
            </div>
          ) : proposals.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              No confident matches found{scanned ? ` across ${scanned} unlinked conversations` : ''}.
            </div>
          ) : (
            <div className="py-3 space-y-2">
              {proposals.map((p) => {
                const b = p.best!;
                const checked = selected.has(p.conversation_id);
                const confClass =
                  b.confidence === 'high'
                    ? 'bg-success/15 text-success border-success/30'
                    : b.confidence === 'medium'
                      ? 'bg-warning/15 text-warning border-warning/30'
                      : 'bg-muted text-muted-foreground border-border';
                return (
                  <button
                    key={p.conversation_id}
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
                        <span className="font-medium text-foreground truncate">
                          {p.sender_name || 'Unknown sender'}
                        </span>
                        <span className="text-muted-foreground">→</span>
                        {b.type === 'candidate' ? (
                          <UserCheck className="h-3.5 w-3.5 text-success shrink-0" />
                        ) : (
                          <Users className="h-3.5 w-3.5 text-info shrink-0" />
                        )}
                        <span className="font-medium text-foreground truncate">{b.name}</span>
                        <Badge variant="outline" className={cn('text-[9px] uppercase shrink-0 capitalize', confClass)}>
                          {b.confidence}
                        </Badge>
                      </div>
                      {(b.title || b.company) && (
                        <p className="text-xs text-muted-foreground truncate">
                          {[b.title, b.company].filter(Boolean).join(' @ ')}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </ScrollArea>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={applying}>
            Cancel
          </Button>
          <Button variant="gold" onClick={apply} disabled={applying || loading || selected.size === 0} className="gap-1.5">
            {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Link {selected.size > 0 ? selected.size : ''} selected
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
