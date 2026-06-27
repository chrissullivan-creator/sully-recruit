import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2, ListPlus } from 'lucide-react';

const CATEGORIES = [
  { value: 'department', label: 'Department' },
  { value: 'products', label: 'Products' },
  { value: 'industry', label: 'Industry / Firm Type' },
  { value: 'strategy', label: 'Strategy' },
];

type Option = { id: string; category: string; value: string; sort_order: number; is_active: boolean };

/**
 * Admin editor for the shared picklist_options lists. Lets an admin pick a
 * category and add / delete the option values that power the
 * PicklistMultiSelect fields across the app. picklist_options isn't in the
 * generated Supabase types yet — cast to any.
 */
export function OptionListsSection() {
  const [category, setCategory] = useState('department');
  const queryClient = useQueryClient();
  const [newValue, setNewValue] = useState('');
  const [adding, setAdding] = useState(false);
  const [bulkValue, setBulkValue] = useState('');
  const [bulkAdding, setBulkAdding] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data: options = [], isLoading } = useQuery({
    queryKey: ['picklist_options_admin', category],
    queryFn: async () => {
      const { data, error } = await (supabase.from('picklist_options' as any) as any)
        .select('id, category, value, sort_order, is_active')
        .eq('category', category)
        .order('sort_order', { ascending: true });
      if (error) throw error;
      return (data ?? []) as Option[];
    },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['picklist_options_admin', category] });
    // Refresh the live usePicklist consumers across the app.
    queryClient.invalidateQueries({ queryKey: ['picklist_options'] });
  };

  const addValue = async () => {
    const value = newValue.trim();
    if (!value) { toast.error('Enter a value'); return; }
    if (options.some((o) => o.value.toLowerCase() === value.toLowerCase())) {
      toast.error('That value already exists');
      return;
    }
    setAdding(true);
    try {
      const nextOrder = options.reduce((max, o) => Math.max(max, o.sort_order ?? 0), 0) + 1;
      const { error } = await (supabase.from('picklist_options' as any) as any).insert({
        category,
        value,
        sort_order: nextOrder,
        is_active: true,
      });
      if (error) throw error;
      invalidate();
      setNewValue('');
      toast.success('Value added');
    } catch (err: any) {
      toast.error(err.message || 'Failed to add value');
    } finally {
      setAdding(false);
    }
  };

  const addBulk = async () => {
    // Accept newline- or comma-separated values pasted in bulk.
    const raw = bulkValue
      .split(/[\n,]/)
      .map((v) => v.trim())
      .filter(Boolean);
    if (raw.length === 0) { toast.error('Paste one or more values'); return; }

    const existingLower = new Set(options.map((o) => o.value.toLowerCase()));
    const seen = new Set<string>();
    const toInsert: string[] = [];
    let dupes = 0;
    for (const v of raw) {
      const key = v.toLowerCase();
      if (existingLower.has(key) || seen.has(key)) { dupes++; continue; }
      seen.add(key);
      toInsert.push(v);
    }
    if (toInsert.length === 0) { toast.error('All values already exist'); return; }

    setBulkAdding(true);
    try {
      let nextOrder = options.reduce((max, o) => Math.max(max, o.sort_order ?? 0), 0) + 1;
      const payload = toInsert.map((value) => ({
        category,
        value,
        sort_order: nextOrder++,
        is_active: true,
      }));
      const { error } = await (supabase.from('picklist_options' as any) as any).insert(payload);
      if (error) throw error;
      invalidate();
      setBulkValue('');
      toast.success(`Added ${toInsert.length}${dupes ? ` · ${dupes} skipped (already existed)` : ''}`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to add values');
    } finally {
      setBulkAdding(false);
    }
  };

  const removeValue = async (id: string) => {
    setDeletingId(id);
    try {
      const { error } = await (supabase.from('picklist_options' as any) as any).delete().eq('id', id);
      if (error) throw error;
      invalidate();
      toast.success('Value deleted');
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-foreground mb-1">Option Lists</h2>
        <p className="text-sm text-muted-foreground">
          Manage the shared dropdown options used across people, jobs, and companies.
        </p>
      </div>

      <div className="mb-5 w-56">
        <Label className="text-xs">Category</Label>
        <Select value={category} onValueChange={(v) => { setCategory(v); setNewValue(''); setBulkValue(''); }}>
          <SelectTrigger className="mt-1.5 h-9 text-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            {CATEGORIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="mb-5 flex items-end gap-2 max-w-md">
        <div className="flex-1 space-y-1.5">
          <Label className="text-xs">Add value</Label>
          <Input
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addValue(); } }}
            placeholder="e.g. Macro"
          />
        </div>
        <Button variant="gold" size="sm" onClick={addValue} disabled={adding || !newValue.trim()}>
          {adding ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
          Add
        </Button>
      </div>

      <div className="mb-6 max-w-md space-y-1.5">
        <Label className="text-xs">Bulk add</Label>
        <Textarea
          value={bulkValue}
          onChange={(e) => setBulkValue(e.target.value)}
          placeholder={'Paste many at once — one per line or comma-separated.\ne.g.\nHedge Fund\nInvestment Bank\nAsset Management'}
          rows={4}
          className="text-sm"
        />
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">Duplicates are skipped automatically.</span>
          <Button variant="outline" size="sm" onClick={addBulk} disabled={bulkAdding || !bulkValue.trim()}>
            {bulkAdding ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <ListPlus className="h-4 w-4 mr-1" />}
            Add all
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-8"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : options.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">No options yet for this category. Add one above.</p>
        </div>
      ) : (
        <div className="space-y-2 max-w-md">
          {options.map((o) => (
            <div key={o.id} className="rounded-lg border border-border bg-card p-3 flex items-center justify-between group">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-medium text-foreground truncate">{o.value}</span>
                {!o.is_active && <span className="text-[10px] text-muted-foreground">· inactive</span>}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-destructive hover:text-destructive shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => removeValue(o.id)}
                disabled={deletingId === o.id}
              >
                {deletingId === o.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
