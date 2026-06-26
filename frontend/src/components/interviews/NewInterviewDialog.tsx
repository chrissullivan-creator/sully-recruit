import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchableSelect } from '@/components/shared/SearchableSelect';
import { supabase } from '@/integrations/supabase/client';
import { useJobs } from '@/hooks/useData';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { createInterview } from '@/lib/createInterview';

/** Pick a candidate + job and spin up a new interview (round 1, or the next
 *  round if one already exists for that pair). */
export function NewInterviewDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated?: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const { data: jobs = [] } = useJobs();
  const [candidateId, setCandidateId] = useState('');
  const [candidateLabel, setCandidateLabel] = useState('');
  const [jobId, setJobId] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) { setCandidateId(''); setCandidateLabel(''); setJobId(''); setSearch(''); setResults([]); }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = search.trim();
    if (q.length < 2 || candidateId) { setResults([]); return; }
    const safe = q.replace(/[,%()*]/g, ' ');
    let active = true;
    setSearching(true);
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('people')
        .select('id, full_name, first_name, last_name, current_title, current_company')
        .or(`full_name.ilike.%${safe}%,first_name.ilike.%${safe}%,last_name.ilike.%${safe}%`)
        .eq('type', 'candidate')
        .is('deleted_at', null)
        .limit(8);
      if (active) { setResults(data ?? []); setSearching(false); }
    }, 250);
    return () => { active = false; clearTimeout(t); };
  }, [search, open, candidateId]);

  const create = async () => {
    if (!candidateId || !jobId) return;
    setSaving(true);
    try {
      const id = await createInterview({ candidateId, jobId });
      toast.success('Interview created');
      queryClient.invalidateQueries({ queryKey: ['interviews'] });
      onOpenChange(false);
      onCreated?.(id);
    } catch (e: any) {
      toast.error(e.message || 'Failed to create interview');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>New interview</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Candidate</Label>
            {candidateId ? (
              <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                <span className="truncate">{candidateLabel}</span>
                <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => { setCandidateId(''); setCandidateLabel(''); }}>Change</button>
              </div>
            ) : (
              <div className="relative">
                <Input className="h-9 text-sm" placeholder="Search candidates…" value={search} onChange={(e) => setSearch(e.target.value)} />
                {(results.length > 0 || searching) && search.trim().length >= 2 && (
                  <div className="absolute z-50 top-full left-0 right-0 mt-1 rounded-md border border-border bg-card shadow-md max-h-56 overflow-y-auto">
                    {searching && <div className="px-3 py-2 text-xs text-muted-foreground">Searching…</div>}
                    {results.map((p: any) => {
                      const nm = p.full_name || `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim();
                      const sub = [p.current_title, p.current_company].filter(Boolean).join(' · ');
                      return (
                        <button key={p.id} className="w-full text-left px-3 py-2 text-sm hover:bg-accent/10 flex flex-col" onClick={() => { setCandidateId(p.id); setCandidateLabel(nm); setResults([]); setSearch(''); }}>
                          <span className="font-medium text-foreground">{nm}</span>
                          {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Job</Label>
            <SearchableSelect
              options={(jobs as any[]).map((j: any) => ({ value: j.id, label: j.title, sublabel: j.company_name || j.companies?.name || undefined }))}
              value={jobId}
              onChange={setJobId}
              placeholder="Select a job…"
              searchPlaceholder="Search jobs…"
              emptyText="No jobs found."
              className="h-9 text-sm w-full"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button variant="gold" onClick={create} disabled={saving || !candidateId || !jobId}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
