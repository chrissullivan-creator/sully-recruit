import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { PicklistMultiSelect } from '@/components/shared/PicklistMultiSelect';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { Loader2, Tags } from 'lucide-react';

interface PicklistField {
  /** Column on the row this section saves to, e.g. 'departments'. */
  column: string;
  /** picklist_options category that drives the options. */
  category: string;
  /** Field label. */
  label: string;
}

interface PicklistEditSectionProps {
  /** Base table the array columns live on (e.g. 'people' | 'jobs' | 'companies'). */
  table: string;
  /** Row id being edited. */
  recordId: string;
  /** Current row (read the column values off it). */
  record: Record<string, any> | null | undefined;
  /** Which array columns to edit. */
  fields: PicklistField[];
  /** Optional section heading (defaults to "Classification"). */
  title?: string;
  /** Query keys to invalidate after a save. */
  invalidateKeys?: unknown[][];
  /** Hide the editor (e.g. no edit permission). */
  disabled?: boolean;
}

/**
 * Self-contained editor for picklist-backed array columns (Department /
 * Products / Industry / Strategy). Owns its own draft state + Save button,
 * mirroring CustomFieldsSection so host pages just drop it in. A field can be
 * conditionally hidden by the parent via `fields` (e.g. only include Strategy
 * when Industry contains "Hedge Fund").
 */
export function PicklistEditSection({
  table,
  recordId,
  record,
  fields,
  title = 'Classification',
  invalidateKeys,
  disabled,
}: PicklistEditSectionProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string[]> | null>(null);
  const [saving, setSaving] = useState(false);

  const valueOf = (column: string): string[] => {
    if (draft && column in draft) return draft[column];
    const v = (record as any)?.[column];
    return Array.isArray(v) ? v : [];
  };

  const setValue = (column: string, v: string[]) =>
    setDraft((prev) => ({ ...(prev ?? {}), [column]: v }));

  const dirty = draft !== null;

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const patch: Record<string, any> = {};
      for (const f of fields) {
        if (f.column in draft) patch[f.column] = draft[f.column].length ? draft[f.column] : null;
      }
      const { error } = await supabase
        .from(table as any)
        .update(patch as any)
        .eq('id', recordId);
      if (error) throw error;
      for (const key of invalidateKeys ?? []) queryClient.invalidateQueries({ queryKey: key });
      setDraft(null);
      toast.success('Saved');
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <Tags className="h-3.5 w-3.5 text-accent" /> {title}
        </h3>
        {dirty && !disabled && (
          <Button variant="gold" size="sm" className="h-7 text-xs" onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-3 w-3 animate-spin mr-1" />} Save
          </Button>
        )}
      </div>
      <div className="space-y-4">
        {fields.map((f) => (
          <div key={f.column} className="space-y-1.5">
            <Label className="text-xs">{f.label}</Label>
            <PicklistMultiSelect
              category={f.category}
              value={valueOf(f.column)}
              onChange={(v) => setValue(f.column, v)}
              disabled={disabled}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
