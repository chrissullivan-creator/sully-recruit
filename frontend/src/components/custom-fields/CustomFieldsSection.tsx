import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useCustomFieldDefs, type CustomFieldDef } from '@/hooks/useData';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Loader2, Sparkles } from 'lucide-react';

type CustomFieldValues = Record<string, unknown>;

interface CustomFieldsSectionProps {
  /** Definition scope, e.g. 'candidate' | 'client' | 'company' | 'job'. */
  entityType: string;
  /** Row id of the record being edited. */
  recordId: string;
  /** Base table the custom_fields column lives on. */
  table?: string;
  /** Current custom_fields value off the record. */
  value: CustomFieldValues | null | undefined;
  /** Query keys to invalidate after a successful save. */
  invalidateKeys?: unknown[][];
}

/**
 * Renders the admin-defined custom fields for a record and saves them back to
 * the record's `custom_fields` JSONB column. Self-contained: owns its own draft
 * state + Save button so host pages don't have to thread it through their form.
 * Renders nothing when no active fields are defined for the entity type.
 */
export function CustomFieldsSection({
  entityType,
  recordId,
  table = 'people',
  value,
  invalidateKeys,
}: CustomFieldsSectionProps) {
  const { data: defs = [], isLoading } = useCustomFieldDefs(entityType);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<CustomFieldValues | null>(null);
  const [saving, setSaving] = useState(false);

  // The working copy: local edits if started, else the persisted value.
  const current = draft ?? (value ?? {});
  const dirty = draft !== null;

  const sections = useMemo(() => groupBySection(defs), [defs]);

  if (isLoading || defs.length === 0) return null;

  const setField = (key: string, v: unknown) =>
    setDraft((prev) => ({ ...(prev ?? value ?? {}), [key]: v }));

  const save = async () => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from(table as any)
        .update({ custom_fields: current } as any)
        .eq('id', recordId);
      if (error) throw error;
      for (const key of invalidateKeys ?? []) queryClient.invalidateQueries({ queryKey: key });
      setDraft(null);
      toast.success('Custom fields saved');
    } catch (err: any) {
      toast.error(err.message || 'Failed to save custom fields');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-accent" /> Custom Fields
        </h3>
        {dirty && (
          <Button variant="gold" size="sm" className="h-7 text-xs" onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-3 w-3 animate-spin mr-1" />} Save
          </Button>
        )}
      </div>

      {sections.map(({ section, fields }) => (
        <div key={section ?? '__none'} className="space-y-3">
          {section && (
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{section}</p>
          )}
          <div className="grid grid-cols-2 gap-4">
            {fields.map((def) => (
              <FieldInput
                key={def.id}
                def={def}
                value={(current as any)[def.key]}
                onChange={(v) => setField(def.key, v)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function groupBySection(defs: CustomFieldDef[]): { section: string | null; fields: CustomFieldDef[] }[] {
  const order: (string | null)[] = [];
  const map = new Map<string | null, CustomFieldDef[]>();
  for (const d of defs) {
    const s = d.section || null;
    if (!map.has(s)) { map.set(s, []); order.push(s); }
    map.get(s)!.push(d);
  }
  return order.map((section) => ({ section, fields: map.get(section)! }));
}

function FieldInput({
  def,
  value,
  onChange,
}: {
  def: CustomFieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = (
    <Label className="text-xs">
      {def.label}
      {def.required && <span className="text-destructive ml-0.5">*</span>}
    </Label>
  );

  switch (def.field_type) {
    case 'boolean':
      return (
        <div className="flex items-center justify-between gap-2 col-span-2">
          {label}
          <Switch checked={!!value} onCheckedChange={(c) => onChange(c)} />
        </div>
      );
    case 'select':
      return (
        <div className="space-y-1.5">
          {label}
          <Select value={(value as string) ?? ''} onValueChange={(v) => onChange(v)}>
            <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select…" /></SelectTrigger>
            <SelectContent>
              {def.options.map((opt) => (
                <SelectItem key={opt} value={opt}>{opt}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      );
    case 'multiselect': {
      const selected: string[] = Array.isArray(value) ? (value as string[]) : [];
      const toggle = (opt: string) =>
        onChange(selected.includes(opt) ? selected.filter((o) => o !== opt) : [...selected, opt]);
      return (
        <div className="space-y-1.5 col-span-2">
          {label}
          <div className="flex flex-wrap gap-1.5">
            {def.options.map((opt) => (
              <button type="button" key={opt} onClick={() => toggle(opt)}>
                <Badge variant={selected.includes(opt) ? 'default' : 'outline'} className="cursor-pointer">
                  {opt}
                </Badge>
              </button>
            ))}
          </div>
        </div>
      );
    }
    case 'date':
      return (
        <div className="space-y-1.5">
          {label}
          <Input type="date" className="h-8 text-sm" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
    case 'number':
      return (
        <div className="space-y-1.5">
          {label}
          <Input
            type="number"
            className="h-8 text-sm"
            value={value === null || value === undefined ? '' : String(value)}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          />
        </div>
      );
    case 'url':
      return (
        <div className="space-y-1.5">
          {label}
          <Input type="url" className="h-8 text-sm" placeholder="https://…" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
    default:
      return (
        <div className="space-y-1.5">
          {label}
          <Input className="h-8 text-sm" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
  }
}
