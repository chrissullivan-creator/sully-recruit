import { useState, useEffect } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Loader2, Merge, AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invalidatePersonScope } from '@/lib/invalidate';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** ids of `people` rows to merge. Need at least 2. */
  personIds: string[];
}

interface Person {
  id: string;
  type: string | null;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  current_title: string | null;
  current_company: string | null;
  created_at: string | null;
}

/**
 * Merges N person rows into one survivor — calls the merge_duplicate_candidate
 * RPC repeatedly (it takes a single survivor + a single merged-in id at a
 * time). The first call moves the second row's data onto the survivor; the
 * second call moves the third's onto the same survivor; and so on. Cheap to
 * extend later if we want a true variadic RPC, but this gets the recruiter
 * out of the "click each one" hole today.
 */
export function BulkMergeDialog({ open, onOpenChange, personIds }: Props) {
  const queryClient = useQueryClient();
  const [survivorId, setSurvivorId] = useState<string>('');
  const [running, setRunning] = useState(false);

  // Fetch each row so the UI can show enough to choose meaningfully.
  const { data: people = [], isLoading } = useQuery<Person[]>({
    queryKey: ['bulk_merge_people', personIds],
    enabled: open && personIds.length >= 2,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('people')
        .select('id, type, full_name, first_name, last_name, email, current_title, current_company, created_at')
        .in('id', personIds);
      if (error) throw error;
      // Order by created_at desc so the newest is on top — usually the
      // freshest row has the most-recent comm history attached.
      return (data ?? []).sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
    },
  });

  // Default the survivor to the first row once data loads.
  useEffect(() => {
    if (!survivorId && people.length > 0) setSurvivorId(people[0].id);
  }, [people, survivorId]);

  const merged = people.filter((p) => p.id !== survivorId);

  const handleMerge = async () => {
    if (!survivorId || merged.length === 0) return;
    setRunning(true);
    let ok = 0;
    let failed = 0;
    try {
      for (const m of merged) {
        const { error } = await supabase.rpc('merge_duplicate_candidate', {
          p_survivor_id: survivorId,
          p_merged_id: m.id,
        } as any);
        if (error) {
          failed++;
          console.error('Merge failed', m.id, error);
        } else {
          ok++;
        }
      }
      if (ok > 0) {
        toast.success(`Merged ${ok} row${ok === 1 ? '' : 's'} into the survivor${failed > 0 ? ` (${failed} failed)` : ''}`);
      } else {
        toast.error(`All ${failed} merges failed`);
      }
      invalidatePersonScope(queryClient);
      if (failed === 0) onOpenChange(false);
    } finally {
      setRunning(false);
    }
  };

  const survivor = people.find((p) => p.id === survivorId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl bg-page-bg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display text-emerald-dark">
            <Merge className="h-4 w-4" /> Merge {personIds.length} duplicate{personIds.length === 1 ? '' : 's'}
          </DialogTitle>
          <DialogDescription>
            Pick the row to <span className="font-semibold">keep</span>. All messages, notes, jobs, send-outs,
            and tasks from the others get moved onto the survivor — nothing is lost.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <RadioGroup value={survivorId} onValueChange={setSurvivorId} className="space-y-2 max-h-[50vh] overflow-y-auto">
            {people.map((p) => {
              const name = p.full_name || `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || '—';
              const subtitle = [p.current_title, p.current_company, p.email].filter(Boolean).join(' · ');
              const isSurvivor = p.id === survivorId;
              return (
                <Label
                  key={p.id}
                  className={cn(
                    'flex items-start gap-3 p-3 rounded-lg border bg-white cursor-pointer transition-colors',
                    isSurvivor
                      ? 'border-emerald bg-emerald-light/30 ring-1 ring-emerald'
                      : 'border-card-border hover:border-emerald/40',
                  )}
                >
                  <RadioGroupItem value={p.id} className="mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-emerald-dark truncate">{name}</p>
                      {isSurvivor && (
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-dark bg-emerald-light px-1.5 py-0.5 rounded-full">
                          KEEP
                        </span>
                      )}
                      {p.type && (
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{p.type}</span>
                      )}
                    </div>
                    {subtitle && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{subtitle}</p>
                    )}
                    {p.created_at && (
                      <p className="text-[10px] text-muted-foreground/70 mt-0.5 tabular-nums">
                        Added {new Date(p.created_at).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                </Label>
              );
            })}
          </RadioGroup>
        )}

        {survivor && merged.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">This will permanently consolidate {merged.length} row{merged.length === 1 ? '' : 's'} into the survivor.</p>
              <p className="mt-0.5 text-amber-800/80">Soft-delete is not used here because merging implies the duplicates were never separate people in the first place.</p>
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
            Cancel
          </Button>
          <Button
            variant="gold"
            onClick={handleMerge}
            disabled={running || !survivorId || merged.length === 0}
            className="gap-1.5"
          >
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Merge className="h-3.5 w-3.5" />}
            Merge {merged.length} into 1
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
