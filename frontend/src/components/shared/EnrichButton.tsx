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
  work_email: 'Apollo → FullEnrich → BetterContact (~$0.05–0.15)',
  personal_email: 'FullEnrich → PDL (~$0.05–0.10, PDL gated by ZeroBounce)',
  mobile: 'BetterContact → PDL (~$0.10–0.20 when found)',
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

  const formatSummary = (
    changed: number, ok: number, failed: number,
    credits: any, linkedin: any,
  ) => {
    const apiBits: string[] = [];
    if (credits?.apollo_calls) apiBits.push(`Apollo ${credits.apollo_calls}`);
    if (credits?.fullenrich_calls) apiBits.push(`FullEnrich ${credits.fullenrich_calls}`);
    if (credits?.bettercontact_calls) apiBits.push(`BetterContact ${credits.bettercontact_calls}`);
    if (credits?.pdl_calls) apiBits.push(`PDL ${credits.pdl_calls}`);
    if (credits?.zerobounce_checks) apiBits.push(`ZB ${credits.zerobounce_checks}`);
    const liBits: string[] = [];
    if (linkedin?.urls_found) liBits.push(`${linkedin.urls_found} URL${linkedin.urls_found === 1 ? '' : 's'} found`);
    if (linkedin?.profiles_synced) liBits.push(`${linkedin.profiles_synced} profile${linkedin.profiles_synced === 1 ? '' : 's'} synced`);
    if (linkedin?.work_history_rows) liBits.push(`${linkedin.work_history_rows} work-history row${linkedin.work_history_rows === 1 ? '' : 's'}`);
    return (
      `Enriched: ${changed} updated, ${ok - changed} unchanged, ${failed} failed` +
      (apiBits.length > 0 ? ` — ${apiBits.join(', ')}` : '') +
      (liBits.length > 0 ? ` • ${liBits.join(', ')}` : '')
    );
  };

  const pollJob = async (jobId: string, total: number) => {
    // Show a sticky loading toast that updates as the job advances.
    // Replaced with success/error toast at terminal state.
    const toastId = toast.loading(`Queued ${total} people — starting…`);
    let backoff = 2000;
    let lastProcessed = -1;
    // Cap at 30 minutes total (900 polls × 2s) — far beyond any realistic batch.
    for (let i = 0; i < 900; i++) {
      await new Promise((r) => setTimeout(r, backoff));
      try {
        const res = await fetch(`/api/enrichment-jobs/${jobId}`, {
          headers: await authHeaders(),
        });
        if (!res.ok) continue;
        const job = await res.json();
        if (job.processed !== lastProcessed) {
          lastProcessed = job.processed;
          backoff = 2000;            // reset backoff on real progress
          toast.loading(`${job.processed}/${job.total} processed — ${job.changed} updated, ${job.failed} failed`, { id: toastId });
        } else {
          backoff = Math.min(backoff * 1.25, 6000);
        }
        if (job.status === 'completed') {
          toast.success(
            formatSummary(job.changed, job.processed, job.failed, job.credits, job.linkedin_summary),
            { id: toastId },
          );
          for (const key of invalidateKeys) qc.invalidateQueries({ queryKey: key });
          return;
        }
        if (job.status === 'failed') {
          toast.error(`Enrich job failed: ${job.error || 'unknown'}`, { id: toastId });
          return;
        }
      } catch {
        // network blip — keep polling
      }
    }
    toast.error('Enrich job is taking unusually long — check the enrichment_jobs table.', { id: toastId });
  };

  const run = async () => {
    if (!canRun) return;
    setRunning(true);
    try {
      const res = await fetch('/api/people/enrich', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ peopleIds, fields: selected }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Enrich failed');

      // ── ASYNC PATH ─────────────────────────────────────────────
      // Backend returned 202 + jobId because batch > SYNC_THRESHOLD.
      // Close the popover so the user can keep working; poll in
      // background with a sticky toast.
      if (data.queued && data.jobId) {
        setOpen(false);
        toast.info(`Queued ${data.total} people — running in background`);
        pollJob(data.jobId, data.total);
        return;
      }

      // ── SYNC PATH ──────────────────────────────────────────────
      const linkedin = {
        urls_found: (data.results ?? []).filter((r: any) => r.linkedin?.found_url).length,
        profiles_synced: (data.results ?? []).filter((r: any) => r.linkedin?.profile_fetched).length,
        work_history_rows: (data.results ?? []).reduce((s: number, r: any) => s + (r.linkedin?.work_history_rows ?? 0), 0),
      };
      toast.success(
        formatSummary(
          data.counts?.changed ?? 0,
          data.counts?.ok ?? 0,
          data.counts?.failed ?? 0,
          data.credits,
          linkedin,
        ),
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
            Cascades fall through per field — Apollo / FullEnrich /
            BetterContact / PDL. PDL emails go through ZeroBounce.
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
