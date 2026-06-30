import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { DollarSign, Plus, Loader2, TrendingUp, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface CompValues {
  current_base_comp?: number | null;
  current_bonus_comp?: number | null;
  current_total_comp?: number | null;
  target_base_comp?: number | null;
  target_bonus_comp?: number | null;
  target_total_comp?: number | null;
}

interface Snapshot extends CompValues {
  id: string;
  recorded_at: string;
  note: string | null;
}

const fmtMoney = (n: number | null | undefined) =>
  n != null && !Number.isNaN(Number(n)) ? `$${Math.round(Number(n) / 1000)}K` : '—';

const FIELDS: { key: keyof CompValues; label: string; group: 'current' | 'target' }[] = [
  { key: 'current_base_comp', label: 'Base', group: 'current' },
  { key: 'current_bonus_comp', label: 'Bonus', group: 'current' },
  { key: 'current_total_comp', label: 'Total', group: 'current' },
  { key: 'target_base_comp', label: 'Base', group: 'target' },
  { key: 'target_bonus_comp', label: 'Bonus', group: 'target' },
  { key: 'target_total_comp', label: 'Total', group: 'target' },
];

/**
 * Compensation history — point-in-time snapshots of what a candidate currently
 * earns and what they're asking for. The live people.*_comp fields get
 * overwritten as things change; this tab keeps the trail of every number they
 * gave us and when.
 */
export function CompHistoryTab({
  personId,
  prefill,
  onProfileUpdated,
}: {
  personId: string;
  prefill?: CompValues;
  onProfileUpdated?: () => void;
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [alsoUpdateProfile, setAlsoUpdateProfile] = useState(true);
  const [form, setForm] = useState<CompValues & { note: string }>({ note: '' });

  const { data: snapshots = [], isLoading } = useQuery({
    queryKey: ['comp_history', personId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('compensation_history' as any)
        .select('id, recorded_at, current_base_comp, current_bonus_comp, current_total_comp, target_base_comp, target_bonus_comp, target_total_comp, note')
        .eq('person_id', personId)
        .order('recorded_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Snapshot[];
    },
    enabled: !!personId,
  });

  const openForm = () => {
    setForm({
      current_base_comp: prefill?.current_base_comp ?? null,
      current_bonus_comp: prefill?.current_bonus_comp ?? null,
      current_total_comp: prefill?.current_total_comp ?? null,
      target_base_comp: prefill?.target_base_comp ?? null,
      target_bonus_comp: prefill?.target_bonus_comp ?? null,
      target_total_comp: prefill?.target_total_comp ?? null,
      note: '',
    });
    setAdding(true);
  };

  const num = (v: number | null | undefined) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

  const save = async () => {
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const payload = {
        person_id: personId,
        current_base_comp: num(form.current_base_comp),
        current_bonus_comp: num(form.current_bonus_comp),
        current_total_comp: num(form.current_total_comp),
        target_base_comp: num(form.target_base_comp),
        target_bonus_comp: num(form.target_bonus_comp),
        target_total_comp: num(form.target_total_comp),
        note: form.note.trim() || null,
        created_by: user?.id ?? null,
      };
      const { error } = await supabase.from('compensation_history' as any).insert(payload as any);
      if (error) throw error;

      if (alsoUpdateProfile) {
        const { error: upErr } = await supabase
          .from('people')
          .update({
            current_base_comp: payload.current_base_comp,
            current_bonus_comp: payload.current_bonus_comp,
            current_total_comp: payload.current_total_comp,
            target_base_comp: payload.target_base_comp,
            target_bonus_comp: payload.target_bonus_comp,
            target_total_comp: payload.target_total_comp,
          } as any)
          .eq('id', personId);
        if (upErr) throw upErr;
        onProfileUpdated?.();
      }

      toast.success('Comp snapshot saved');
      queryClient.invalidateQueries({ queryKey: ['comp_history', personId] });
      setAdding(false);
    } catch (e: any) {
      toast.error(e?.message || 'Could not save snapshot');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          What this candidate earns + is asking for, captured over time.
        </p>
        {!adding && (
          <Button size="sm" variant="gold-outline" className="gap-1.5" onClick={openForm}>
            <Plus className="h-3.5 w-3.5" /> Add snapshot
          </Button>
        )}
      </div>

      {adding && (
        <div className="rounded-xl border border-card-border bg-card p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <CompGroup
              title="Current"
              fields={FIELDS.filter((f) => f.group === 'current')}
              form={form}
              onChange={(k, v) => setForm((f) => ({ ...f, [k]: v }))}
            />
            <CompGroup
              title="Expected / asking"
              fields={FIELDS.filter((f) => f.group === 'target')}
              form={form}
              onChange={(k, v) => setForm((f) => ({ ...f, [k]: v }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Note <span className="text-muted-foreground">(what they said)</span></Label>
            <Input
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              placeholder="e.g. Wants 300 base to move; current bonus paid in March"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <Checkbox checked={alsoUpdateProfile} onCheckedChange={(v) => setAlsoUpdateProfile(!!v)} />
            Also update the profile's current numbers to match
          </label>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
              Save snapshot
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={saving}>Cancel</Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : snapshots.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-card-border bg-card p-10 text-center">
          <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-gold/10 text-gold-deep">
            <DollarSign className="h-5 w-5" />
          </span>
          <p className="text-sm font-medium text-foreground">No comp snapshots yet</p>
          <p className="mt-1 text-xs text-muted-foreground">Add one whenever the candidate shares their numbers.</p>
        </div>
      ) : (
        <ol className="relative space-y-3 before:absolute before:left-[7px] before:top-1 before:bottom-1 before:w-px before:bg-border">
          {snapshots.map((s) => (
            <li key={s.id} className="relative pl-6">
              <span className="absolute left-0 top-1.5 h-3.5 w-3.5 rounded-full border-2 border-gold bg-card" />
              <div className="rounded-xl border border-card-border bg-card p-3.5">
                <div className="flex items-center gap-2 mb-2">
                  <Clock className="h-3 w-3 text-muted-foreground" />
                  <span className="text-xs font-semibold text-foreground tabular-nums">
                    {format(new Date(s.recorded_at), 'MMM d, yyyy')}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <CompReadGroup title="Current" base={s.current_base_comp} bonus={s.current_bonus_comp} total={s.current_total_comp} />
                  <CompReadGroup title="Expected" base={s.target_base_comp} bonus={s.target_bonus_comp} total={s.target_total_comp} accent />
                </div>
                {s.note && <p className="mt-2 text-xs text-muted-foreground border-t border-border/60 pt-2">{s.note}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function CompGroup({
  title,
  fields,
  form,
  onChange,
}: {
  title: string;
  fields: { key: keyof CompValues; label: string }[];
  form: CompValues;
  onChange: (key: keyof CompValues, value: number | null) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      {fields.map((f) => (
        <div key={f.key} className="flex items-center gap-2">
          <Label className="w-12 shrink-0 text-xs text-muted-foreground">{f.label}</Label>
          <Input
            type="number"
            inputMode="numeric"
            value={form[f.key] ?? ''}
            onChange={(e) => onChange(f.key, e.target.value === '' ? null : Number(e.target.value))}
            placeholder="$ (e.g. 250000)"
            className="h-8 text-sm"
          />
        </div>
      ))}
    </div>
  );
}

function CompReadGroup({
  title,
  base,
  bonus,
  total,
  accent,
}: {
  title: string;
  base: number | null | undefined;
  bonus: number | null | undefined;
  total: number | null | undefined;
  accent?: boolean;
}) {
  return (
    <div>
      <p className={cn('text-[10px] font-semibold uppercase tracking-wide mb-1 flex items-center gap-1', accent ? 'text-gold-deep' : 'text-muted-foreground')}>
        {accent && <TrendingUp className="h-2.5 w-2.5" />}{title}
      </p>
      <dl className="space-y-0.5 text-xs">
        <Row label="Base" value={fmtMoney(base)} />
        <Row label="Bonus" value={fmtMoney(bonus)} />
        <Row label="Total" value={fmtMoney(total)} bold />
      </dl>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('tabular-nums', bold ? 'font-semibold text-foreground' : 'text-foreground')}>{value}</dd>
    </div>
  );
}
