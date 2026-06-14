import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useCustomFieldDefs, type CustomFieldDef } from '@/hooks/useData';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Loader2, Plus, Pencil, Trash2, X } from 'lucide-react';

const ENTITY_TYPES = [
  { value: 'candidate', label: 'Candidates' },
  { value: 'client', label: 'Clients' },
  { value: 'company', label: 'Companies' },
  { value: 'job', label: 'Jobs' },
];

const FIELD_TYPES = ['text', 'number', 'date', 'boolean', 'select', 'multiselect', 'url'];
const TYPES_WITH_OPTIONS = new Set(['select', 'multiselect']);

type DraftDef = {
  id?: string;
  entity_type: string;
  key: string;
  label: string;
  field_type: CustomFieldDef['field_type'];
  options: string; // comma-separated in the form
  section: string;
  display_order: number;
  required: boolean;
  is_active: boolean;
};

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

export function CustomFieldsManager() {
  const [entityType, setEntityType] = useState('candidate');
  const { data: defs = [], isLoading } = useCustomFieldDefs(entityType, true);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<DraftDef | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['custom_field_defs', entityType, true] });
    queryClient.invalidateQueries({ queryKey: ['custom_field_defs', entityType, false] });
  };

  const startAdd = () =>
    setEditing({
      entity_type: entityType,
      key: '',
      label: '',
      field_type: 'text',
      options: '',
      section: '',
      display_order: defs.length + 1,
      required: false,
      is_active: true,
    });

  const startEdit = (d: CustomFieldDef) =>
    setEditing({
      id: d.id,
      entity_type: d.entity_type,
      key: d.key,
      label: d.label,
      field_type: d.field_type,
      options: (d.options ?? []).join(', '),
      section: d.section ?? '',
      display_order: d.display_order,
      required: d.required,
      is_active: d.is_active,
    });

  const save = async () => {
    if (!editing) return;
    const key = editing.key.trim() || slugify(editing.label);
    if (!editing.label.trim() || !key) {
      toast.error('Label is required');
      return;
    }
    setSaving(true);
    try {
      const options = TYPES_WITH_OPTIONS.has(editing.field_type)
        ? editing.options.split(',').map((o) => o.trim()).filter(Boolean)
        : [];
      const payload = {
        entity_type: editing.entity_type,
        key,
        label: editing.label.trim(),
        field_type: editing.field_type,
        options,
        section: editing.section.trim() || null,
        display_order: editing.display_order,
        required: editing.required,
        is_active: editing.is_active,
        updated_at: new Date().toISOString(),
      };
      // custom_field_defs isn't in the generated Supabase types yet — cast.
      const tbl = supabase.from('custom_field_defs' as any) as any;
      if (editing.id) {
        const { error } = await tbl.update(payload).eq('id', editing.id);
        if (error) throw error;
        toast.success('Field updated');
      } else {
        const { error } = await tbl.insert(payload);
        if (error) throw error;
        toast.success('Field created');
      }
      invalidate();
      setEditing(null);
    } catch (err: any) {
      toast.error(err.message?.includes('duplicate') ? 'A field with that key already exists' : err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setDeletingId(id);
    try {
      const { error } = await (supabase.from('custom_field_defs' as any) as any).delete().eq('id', id);
      if (error) throw error;
      invalidate();
      toast.success('Field deleted');
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground mb-1">Custom Fields</h2>
          <p className="text-sm text-muted-foreground">
            Add your own fields to records without a code change. They appear on the record's detail page.
          </p>
        </div>
        <Button variant="gold" size="sm" onClick={startAdd}>
          <Plus className="h-4 w-4 mr-1" /> Add Field
        </Button>
      </div>

      <div className="mb-5 w-56">
        <Label className="text-xs">Applies to</Label>
        <Select value={entityType} onValueChange={(v) => { setEntityType(v); setEditing(null); }}>
          <SelectTrigger className="mt-1.5 h-9 text-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ENTITY_TYPES.map((e) => <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>)}
          </SelectContent>
        </Select>
        {entityType !== 'candidate' && (
          <p className="text-[11px] text-amber-600 mt-1.5">
            Definitions save, but the editor on the record page is live for Candidates only so far.
          </p>
        )}
      </div>

      {editing && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 p-5 mb-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">{editing.id ? 'Edit Field' : 'New Field'}</h3>
            <button onClick={() => setEditing(null)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Label *</Label>
              <Input value={editing.label} onChange={(e) => setEditing((p) => p && { ...p, label: e.target.value })} placeholder="e.g. Visa Expiry" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Key</Label>
              <Input
                value={editing.key}
                onChange={(e) => setEditing((p) => p && { ...p, key: slugify(e.target.value) })}
                placeholder={editing.label ? slugify(editing.label) : 'auto from label'}
                disabled={!!editing.id}
              />
              <p className="text-[10px] text-muted-foreground">{editing.id ? 'Key is locked after creation.' : 'Stable id — auto-filled from the label if left blank.'}</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Type</Label>
              <Select value={editing.field_type} onValueChange={(v) => setEditing((p) => p && { ...p, field_type: v as CustomFieldDef['field_type'] })}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FIELD_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Section</Label>
              <Input value={editing.section} onChange={(e) => setEditing((p) => p && { ...p, section: e.target.value })} placeholder="e.g. Compliance" />
            </div>
            {TYPES_WITH_OPTIONS.has(editing.field_type) && (
              <div className="space-y-1.5 col-span-2">
                <Label className="text-xs">Options (comma-separated)</Label>
                <Input value={editing.options} onChange={(e) => setEditing((p) => p && { ...p, options: e.target.value })} placeholder="e.g. Macro, Rates, Credit" />
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">Sort Order</Label>
              <Input type="number" className="w-24" value={editing.display_order} onChange={(e) => setEditing((p) => p && { ...p, display_order: parseInt(e.target.value) || 0 })} />
            </div>
            <div className="flex items-end gap-6">
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={editing.required} onCheckedChange={(c) => setEditing((p) => p && { ...p, required: c })} /> Required
              </label>
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={editing.is_active} onCheckedChange={(c) => setEditing((p) => p && { ...p, is_active: c })} /> Active
              </label>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="gold" size="sm" onClick={save} disabled={saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
              {editing.id ? 'Save Changes' : 'Create Field'}
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-8"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : defs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">No custom fields yet for this entity. Add one above.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {defs.map((d) => (
            <div key={d.id} className="rounded-lg border border-border bg-card p-4 flex items-start justify-between group">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-sm font-medium text-foreground">{d.label}</h3>
                  <span className="font-mono text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{d.key}</span>
                  <span className="text-[10px] text-accent bg-accent/10 px-1.5 py-0.5 rounded">{d.field_type}</span>
                  {d.section && <span className="text-[10px] text-muted-foreground">· {d.section}</span>}
                  {d.required && <span className="text-[10px] text-destructive">· required</span>}
                  {!d.is_active && <span className="text-[10px] text-muted-foreground">· inactive</span>}
                </div>
                {d.options.length > 0 && <p className="text-xs text-muted-foreground mt-1">{d.options.join(', ')}</p>}
              </div>
              <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => startEdit(d)}><Pencil className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive hover:text-destructive" onClick={() => remove(d.id)} disabled={deletingId === d.id}>
                  {deletingId === d.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
