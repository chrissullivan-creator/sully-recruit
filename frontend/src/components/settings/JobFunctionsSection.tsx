import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Briefcase, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useJobFunctions } from '@/hooks/useData';

export function JobFunctionsSection() {
  const queryClient = useQueryClient();
  const { data: jobFunctions = [], isLoading: jobFunctionsLoading } = useJobFunctions();
  const [editingFn, setEditingFn] = useState<{ id?: string; name: string; code: string; examples: string; sort_order: number } | null>(null);
  const [savingFn, setSavingFn] = useState(false);
  const [deletingFnId, setDeletingFnId] = useState<string | null>(null);

  const startAddFunction = () => {
    setEditingFn({ name: '', code: '', examples: '', sort_order: jobFunctions.length + 1 });
  };

  const startEditFunction = (fn: any) => {
    setEditingFn({
      id: fn.id,
      name: fn.name,
      code: fn.code,
      examples: (fn.examples ?? []).join(', '),
      sort_order: fn.sort_order ?? 0,
    });
  };

  const saveFunction = async () => {
    if (!editingFn) return;
    if (!editingFn.name.trim() || !editingFn.code.trim()) {
      toast.error('Name and code are required');
      return;
    }
    setSavingFn(true);
    try {
      const examplesArr = editingFn.examples
        .split(',')
        .map(e => e.trim())
        .filter(Boolean);
      const payload = {
        name: editingFn.name.trim(),
        code: editingFn.code.trim().toUpperCase(),
        examples: examplesArr,
        sort_order: editingFn.sort_order,
      };

      if (editingFn.id) {
        const { error } = await supabase.from('job_functions').update(payload).eq('id', editingFn.id);
        if (error) throw error;
        toast.success('Function updated');
      } else {
        const { error } = await supabase.from('job_functions').insert(payload);
        if (error) throw error;
        toast.success('Function created');
      }
      queryClient.invalidateQueries({ queryKey: ['job_functions'] });
      setEditingFn(null);
    } catch (err: any) {
      toast.error(err.message || 'Failed to save function');
    } finally {
      setSavingFn(false);
    }
  };

  const deleteFunction = async (fnId: string) => {
    setDeletingFnId(fnId);
    try {
      const { error } = await supabase.from('job_functions').delete().eq('id', fnId);
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['job_functions'] });
      toast.success('Function deleted');
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete function');
    } finally {
      setDeletingFnId(null);
    }
  };

  return (
                  <div>
                    <div className="mb-6 flex items-center justify-between">
                      <div>
                        <h2 className="text-lg font-semibold text-foreground mb-1">Job Functions</h2>
                        <p className="text-sm text-muted-foreground">
                          Manage job function categories used for generating Job Codes (e.g. TD-001, TECH-002).
                        </p>
                      </div>
                      <Button variant="gold" size="sm" onClick={startAddFunction}>
                        <Plus className="h-4 w-4 mr-1" /> Add Function
                      </Button>
                    </div>

                    {/* Edit / Add form */}
                    {editingFn && (
                      <div className="rounded-lg border border-accent/30 bg-accent/5 p-5 mb-6 space-y-4">
                        <div className="flex items-center justify-between">
                          <h3 className="text-sm font-semibold text-foreground">
                            {editingFn.id ? 'Edit Function' : 'New Function'}
                          </h3>
                          <button onClick={() => setEditingFn(null)} className="text-muted-foreground hover:text-foreground">
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-1.5">
                            <Label className="text-xs">Name *</Label>
                            <Input
                              value={editingFn.name}
                              onChange={e => setEditingFn(prev => prev ? { ...prev, name: e.target.value } : prev)}
                              placeholder="e.g. Trading Desk"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs">Code *</Label>
                            <Input
                              value={editingFn.code}
                              onChange={e => setEditingFn(prev => prev ? { ...prev, code: e.target.value.toUpperCase() } : prev)}
                              placeholder="e.g. TD"
                              maxLength={10}
                            />
                            <p className="text-[10px] text-muted-foreground">Short code used in Job ID (e.g. TD-001)</p>
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Examples (comma-separated)</Label>
                          <Input
                            value={editingFn.examples}
                            onChange={e => setEditingFn(prev => prev ? { ...prev, examples: e.target.value } : prev)}
                            placeholder="e.g. Portfolio Managers, Quantitative Researchers, Data Scientists"
                          />
                          <p className="text-[10px] text-muted-foreground">Example roles shown in dropdowns to help users pick the right function</p>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Sort Order</Label>
                          <Input
                            type="number"
                            value={editingFn.sort_order}
                            onChange={e => setEditingFn(prev => prev ? { ...prev, sort_order: parseInt(e.target.value) || 0 } : prev)}
                            className="w-24"
                          />
                        </div>
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="sm" onClick={() => setEditingFn(null)}>Cancel</Button>
                          <Button variant="gold" size="sm" onClick={saveFunction} disabled={savingFn}>
                            {savingFn && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
                            {editingFn.id ? 'Save Changes' : 'Create Function'}
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* Functions list */}
                    {jobFunctionsLoading ? (
                      <div className="flex items-center gap-2 text-muted-foreground py-8">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading functions...
                      </div>
                    ) : jobFunctions.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-border p-8 text-center">
                        <Briefcase className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                        <p className="text-sm text-muted-foreground">No functions yet. Add one to start generating job codes.</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {jobFunctions.map((fn: any) => (
                          <div key={fn.id} className="rounded-lg border border-border bg-card p-4 flex items-start justify-between group">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-xs font-semibold text-accent bg-accent/10 px-1.5 py-0.5 rounded">{fn.code}</span>
                                <h3 className="text-sm font-medium text-foreground">{fn.name}</h3>
                              </div>
                              {fn.examples?.length > 0 && (
                                <p className="text-xs text-muted-foreground mt-1">{fn.examples.join(', ')}</p>
                              )}
                            </div>
                            <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => startEditFunction(fn)}>
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                                onClick={() => deleteFunction(fn.id)}
                                disabled={deletingFnId === fn.id}
                              >
                                {deletingFnId === fn.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
  );
}
