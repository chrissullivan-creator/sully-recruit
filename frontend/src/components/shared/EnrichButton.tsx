import { useState } from 'react';
import { Wand2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover';
import { toast } from 'sonner';
import { authHeaders } from '@/lib/api-auth';
import { useQueryClient } from '@tanstack/react-query';

export type EnrichField = 'work_email' | 'personal_email' | 'mobile' | 'linkedin_profile';

const FIELD_LABEL: Record<EnrichField, string> = {
  work_email: 'Work email',
  personal_email: 'Personal email',
  mobile: 'Mobile phone',
  linkedin_profile: 'LinkedIn profile & work history',
};

const FIELD_COST_HINT: Record<EnrichField, string> = {
  work_email: '~5 cr (LeadMagic) + 0.25 verify',
  personal_email: '~2 cr (LeadMagic)',
  mobile: '~5 cr (LeadMagic)',
  linkedin_profile: 'Free — Apollo + Unipile (also finds URL if missing)',
};

/**
 * Enrich button with a per-field multi-select. Shared by the candidate
 * detail page (single id) and the bulk actions dialog (many ids).
 *
 * Backend cascades LeadMagic → Bytemine per selected field, so the
 * recruiter only spends credits on slots they care about.
 */
export function EnrichButton({
  peopleIds,
  disabled,
  size = 'sm',
  variant = 'outline',
  invalidateKeys = [['candidates']],
  label = 'Enrich',
  align = 'end',
}: {
  peopleIds: string[];
  disabled?: boolean;
  size?: 'sm' | 'default' | 'icon';
  variant?: 'outline' | 'ghost' | 'gold' | 'default';
  /** Query keys to invalidate on success — defaults to the candidates list. */
  invalidateKeys?: any[][];
  label?: string;
  align?: 'start' | 'end' | 'center';
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [fields, setFields] = useState<Record<EnrichField, boolean>>({
    work_email: true,
    personal_email: false,
    mobile: false,
    linkedin_profile: false,
  });

  const selected: EnrichField[] = (Object.keys(fields) as EnrichField[]).filter((k) => fields[k]);
  const canRun = peopleIds.length > 0 && selected.length > 0 && !disabled;

  const run = async () => {
    if (!canRun) return;
    setRunning(true);
    try {
      // Backend caps at 100 per call — chunk to handle bulk selects.
      const chunks: string[][] = [];
      for (let i = 0; i < peopleIds.length; i += 100) {
        chunks.push(peopleIds.slice(i, i + 100));
      }
      let okTotal = 0, changedTotal = 0, failedTotal = 0, noLink = 0;
      let leadmagicCredits = 0, bytemineCalls = 0;
      let urlsFound = 0, profilesSynced = 0, workHistoryRows = 0;
      for (const chunk of chunks) {
        const res = await fetch('/api/people/enrich', {
          method: 'POST',
          headers: await authHeaders(),
          body: JSON.stringify({ peopleIds: chunk, fields: selected }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Enrich failed');
        okTotal += data.counts?.ok ?? 0;
        changedTotal += data.counts?.changed ?? 0;
        failedTotal += data.counts?.failed ?? 0;
        noLink += data.counts?.no_linkedin ?? 0;
        leadmagicCredits += data.credits?.leadmagic ?? 0;
        bytemineCalls += data.credits?.bytemine_calls ?? 0;
        for (const r of (data.results ?? []) as Array<{ linkedin?: { found_url?: string; profile_fetched?: boolean; work_history_rows?: number } }>) {
          if (r.linkedin?.found_url) urlsFound += 1;
          if (r.linkedin?.profile_fetched) profilesSynced += 1;
          workHistoryRows += r.linkedin?.work_history_rows ?? 0;
        }
      }
      const linkedinBits: string[] = [];
      if (urlsFound > 0) linkedinBits.push(`${urlsFound} URL${urlsFound === 1 ? '' : 's'} found`);
      if (profilesSynced > 0) linkedinBits.push(`${profilesSynced} profile${profilesSynced === 1 ? '' : 's'} synced`);
      if (workHistoryRows > 0) linkedinBits.push(`${workHistoryRows} work-history row${workHistoryRows === 1 ? '' : 's'}`);
      toast.success(
        `Enriched: ${changedTotal} updated, ${okTotal - changedTotal} unchanged, ${failedTotal} failed` +
        (noLink > 0 ? ` (${noLink} no LinkedIn)` : '') +
        ` — LM ${leadmagicCredits.toFixed(2)} cr, BM ${bytemineCalls} calls` +
        (linkedinBits.length > 0 ? ` • ${linkedinBits.join(', ')}` : ''),
      );
      for (const key of invalidateKeys) qc.invalidateQueries({ queryKey: key });
      setOpen(false);
    } catch (e: any) {
      toast.error(e.message || 'Enrich failed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size={size as any} variant={variant as any} disabled={disabled || peopleIds.length === 0}>
          {running
            ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            : <Wand2 className="h-3.5 w-3.5 mr-1" />}
          {label}{peopleIds.length > 1 ? ` (${peopleIds.length})` : ''}
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-72 space-y-3">
        <div>
          <p className="text-sm font-medium">What to enrich?</p>
          <p className="text-[11px] text-muted-foreground">
            Contact info: LeadMagic → Bytemine fallback.
            LinkedIn: Apollo → Unipile search (finds URL if missing).
          </p>
        </div>
        <div className="space-y-2">
          {(Object.keys(fields) as EnrichField[]).map((k) => (
            <label key={k} className="flex items-start gap-2 cursor-pointer">
              <Checkbox
                checked={fields[k]}
                onCheckedChange={(v) => setFields((f) => ({ ...f, [k]: !!v }))}
                className="mt-0.5"
              />
              <div className="leading-tight">
                <Label className="text-sm cursor-pointer">{FIELD_LABEL[k]}</Label>
                <p className="text-[10px] text-muted-foreground">{FIELD_COST_HINT[k]}</p>
              </div>
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={running}>
            Cancel
          </Button>
          <Button size="sm" variant="gold" onClick={run} disabled={!canRun || running}>
            {running && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Run on {peopleIds.length}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
