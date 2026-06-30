import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

export interface EditField {
  key: string;
  label: string;
  type?: 'text' | 'textarea' | 'number' | 'email';
  placeholder?: string;
  /** Group header this field sits under. */
  section?: string;
  /** Span the full width of the 2-col grid. */
  full?: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  personId: string;
  /** Current person row — used to seed the form. */
  initial: Record<string, any>;
  fields: EditField[];
  title?: string;
  /** Called after a successful save so the page can refresh its data. */
  onSaved?: () => void;
}

/**
 * One modal that edits every editable field for a person (candidate or
 * client). Config-driven via `fields` so each detail page supplies its own
 * set; saves the whole form to the unified `people` table in a single write.
 */
export function EditPersonDialog({ open, onOpenChange, personId, initial, fields, title = 'Edit details', onSaved }: Props) {
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(Object.fromEntries(fields.map((f) => [f.key, initial?.[f.key] ?? ''])));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, personId]);

  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      const updates: Record<string, any> = {};
      for (const f of fields) {
        const raw = form[f.key];
        if (f.type === 'number') {
          const n = raw ? parseFloat(String(raw).replace(/[^0-9.]/g, '')) : null;
          updates[f.key] = n != null && !isNaN(n) ? n : null;
        } else {
          updates[f.key] = raw?.trim() ? raw.trim() : null;
        }
      }
      // Keep full_name in sync when the name parts are part of the form.
      if ('first_name' in updates || 'last_name' in updates) {
        const first = ('first_name' in updates ? updates.first_name : initial?.first_name) ?? '';
        const last = ('last_name' in updates ? updates.last_name : initial?.last_name) ?? '';
        updates.full_name = `${first} ${last}`.trim() || null;
      }
      const { error } = await supabase.from('people').update(updates).eq('id', personId);
      if (error) throw error;
      toast.success('Saved');
      onSaved?.();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // Group fields by section, preserving order.
  const sections: { name: string | undefined; items: EditField[] }[] = [];
  for (const f of fields) {
    const last = sections[sections.length - 1];
    if (last && last.name === f.section) last.items.push(f);
    else sections.push({ name: f.section, items: [f] });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="space-y-5">
          {sections.map((sec, si) => (
            <div key={si} className="space-y-3">
              {sec.name && (
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{sec.name}</p>
              )}
              <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                {sec.items.map((f) => (
                  <div key={f.key} className={f.type === 'textarea' || f.full ? 'sm:col-span-2 space-y-1.5' : 'space-y-1.5'}>
                    <Label className="text-xs text-muted-foreground">{f.label}</Label>
                    {f.type === 'textarea' ? (
                      <Textarea
                        value={form[f.key] ?? ''}
                        onChange={(e) => set(f.key, e.target.value)}
                        placeholder={f.placeholder}
                        rows={3}
                        className="text-sm"
                      />
                    ) : (
                      <Input
                        value={form[f.key] ?? ''}
                        onChange={(e) => set(f.key, e.target.value)}
                        placeholder={f.placeholder}
                        type={f.type === 'email' ? 'email' : 'text'}
                        className="h-9 text-sm"
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button variant="gold" onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
