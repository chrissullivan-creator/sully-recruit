import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { useSequences } from '@/hooks/useData';
import { Plus, Search, Play, Pause, Mail, MessageSquare, Phone, Linkedin, Users, BarChart3, Loader2, Trash2, X, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';

const statusColors: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  active: 'bg-success/10 text-success border-success/20',
  paused: 'bg-warning/10 text-warning border-warning/20',
  completed: 'bg-info/10 text-info border-info/20',
};

const channelIcons: Record<string, React.ReactNode> = {
  linkedin: <Linkedin className="h-3.5 w-3.5" />,
  email: <Mail className="h-3.5 w-3.5" />,
  sms: <MessageSquare className="h-3.5 w-3.5" />,
  phone: <Phone className="h-3.5 w-3.5" />,
};

const Campaigns = () => {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<string>('all');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [templateSearch, setTemplateSearch] = useState('');
  const { data: sequences = [], isLoading } = useSequences();
  const { data: templates = [] } = useQuery({
    queryKey: ['sequence_templates'],
    queryFn: async () => {
      const { data, error } = await supabase.from('sequence_templates').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });
  const queryClient = useQueryClient();

  const filteredSequences = useMemo(() => sequences.filter((seq) => {
    const matchesSearch = seq.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = filter === 'all' || seq.status === filter;
    return matchesSearch && matchesFilter;
  }), [sequences, searchQuery, filter]);

  const allSelected = filteredSequences.length > 0 && filteredSequences.every(s => selected.has(s.id));

  const toggleSelect = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filteredSequences.map(s => s.id)));
    }
  };

  const clearSelection = () => setSelected(new Set());

  const handleCardClick = (seqId: string) => {
    if (selected.size > 0) {
      toggleSelect(seqId);
      return;
    }
    navigate(`/campaigns/${seqId}`);
  };

  const handleCreateNew = async () => {
    setCreating(true);
    try {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const { data: seq, error } = await supabase
        .from('sequences')
        .insert({ name: 'Untitled Sequence', channel: 'email', status: 'draft', stop_on_reply: true, created_by: userId } as any)
        .select('id')
        .single();
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['sequences'] });
      navigate(`/campaigns/${seq.id}`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create sequence');
    } finally {
      setCreating(false);
    }
  };

  const handleCreateFromTemplate = async (template: any) => {
    setCreating(true);
    setTemplateDialogOpen(false);
    try {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const { data: seq, error } = await supabase
        .from('sequences')
        .insert({
          name: `${template.name.replace(' Template', '')}`,
          description: template.description || null,
          channel: template.channel || 'email',
          status: 'draft',
          stop_on_reply: template.stop_on_reply ?? true,
          created_by: userId,
        } as any)
        .select('id')
        .single();
      if (error) throw error;

      // Insert steps from template
      const stepsJson = Array.isArray(template.steps_json) ? template.steps_json : [];
      if (stepsJson.length > 0) {
        const rows = stepsJson.map((step: any) => ({
          sequence_id: seq.id,
          step_order: step.order,
          step_type: step.channel || 'email',
          channel: step.channel || 'email',
          delay_days: step.delayDays || 0,
          delay_hours: step.delayHours || 0,
          send_window_start: step.sendWindowStart || 9,
          send_window_end: step.sendWindowEnd || 17,
          wait_for_connection: step.waitForConnection || false,
          min_hours_after_connection: step.minHoursAfterConnection || 4,
          subject: step.subject || null,
          body: step.content || null,
          is_reply: step.isReply || false,
          use_signature: step.useSignature || false,
        }));
        await supabase.from('sequence_steps').insert(rows as any);
      }

      queryClient.invalidateQueries({ queryKey: ['sequences'] });
      toast.success('Sequence created from template');
      navigate(`/campaigns/${seq.id}`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create from template');
    } finally {
      setCreating(false);
    }
  };

  const toggleStatus = async (e: React.MouseEvent, seqId: string, currentStatus: string) => {
    e.stopPropagation();
    const newStatus = currentStatus === 'active' ? 'paused' : 'active';
    try {
      const { error } = await supabase
        .from('sequences')
        .update({ status: newStatus } as any)
        .eq('id', seqId);
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['sequences'] });
      toast.success(`Sequence ${newStatus === 'active' ? 'activated' : 'paused'}`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to update status');
    }
  };

  const bulkAction = async (action: 'activate' | 'pause' | 'delete') => {
    if (selected.size === 0) return;
    setBulkLoading(true);
    const ids = Array.from(selected);
    try {
      if (action === 'delete') {
        // Delete steps first, then enrollments, then sequences
        await supabase.from('sequence_steps').delete().in('sequence_id', ids);
        await supabase.from('sequence_enrollments').delete().in('sequence_id', ids);
        const { error } = await supabase.from('sequences').delete().in('id', ids);
        if (error) throw error;
        toast.success(`Deleted ${ids.length} sequence${ids.length > 1 ? 's' : ''}`);
      } else {
        const newStatus = action === 'activate' ? 'active' : 'paused';
        const { error } = await supabase
          .from('sequences')
          .update({ status: newStatus } as any)
          .in('id', ids);
        if (error) throw error;
        toast.success(`${action === 'activate' ? 'Activated' : 'Paused'} ${ids.length} sequence${ids.length > 1 ? 's' : ''}`);
      }
      queryClient.invalidateQueries({ queryKey: ['sequences'] });
      setSelected(new Set());
    } catch (err: any) {
      toast.error(err.message || `Failed to ${action} sequences`);
    } finally {
      setBulkLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader 
        title="Sequences" 
        description="Multi-channel outreach sequences for candidates and business development."
        actions={
          <div className="flex items-center gap-2">
            {templates.length > 0 && (
              <Button variant="outline" onClick={() => setTemplateDialogOpen(true)} disabled={creating}>
                <FileText className="h-4 w-4 mr-1" /> From Template
              </Button>
            )}
            <Button variant="gold" onClick={handleCreateNew} disabled={creating}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              New Sequence
            </Button>
          </div>
        }
      />
      
      <div className="p-8">
        {/* Bulk action bar */}
        {selected.size > 0 && (
          <div className="flex items-center gap-3 mb-4 rounded-lg border border-accent/50 bg-accent/5 px-4 py-3 animate-in fade-in slide-in-from-top-2 duration-200">
            <Checkbox checked={allSelected} onCheckedChange={toggleSelectAll} />
            <span className="text-sm font-medium text-foreground">
              {selected.size} selected
            </span>
            <div className="h-4 w-px bg-border" />
            <Button variant="ghost" size="sm" onClick={() => bulkAction('activate')} disabled={bulkLoading}>
              <Play className="h-3.5 w-3.5 text-success mr-1" /> Activate
            </Button>
            <Button variant="ghost" size="sm" onClick={() => bulkAction('pause')} disabled={bulkLoading}>
              <Pause className="h-3.5 w-3.5 text-warning mr-1" /> Pause
            </Button>
            <Button variant="ghost" size="sm" onClick={() => bulkAction('delete')} disabled={bulkLoading} className="text-destructive hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
            </Button>
            {bulkLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            <Button variant="ghost" size="icon" className="ml-auto h-7 w-7" onClick={clearSelection}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-4 mb-6">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search sequences..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-10 pl-10 pr-4 rounded-lg border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          
          <div className="flex items-center gap-2">
            <Button variant={filter === 'all' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('all')}>All</Button>
            <Button variant={filter === 'active' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('active')}>Active</Button>
            <Button variant={filter === 'paused' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('paused')}>Paused</Button>
            <Button variant={filter === 'draft' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('draft')}>Drafts</Button>
          </div>
        </div>

        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading sequences...</p>
        ) : filteredSequences.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-muted-foreground mb-2">No sequences found</p>
            <p className="text-sm text-muted-foreground mb-4">Create your first outreach sequence to get started.</p>
            <Button variant="gold" onClick={handleCreateNew} disabled={creating}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
              New Sequence
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {filteredSequences.map((seq) => {
              const steps = (seq.sequence_steps as any[]) ?? [];
              const enrollments = (seq.sequence_enrollments as any[]) ?? [];
              const isSelected = selected.has(seq.id);
              return (
                <div
                  key={seq.id}
                  onClick={() => handleCardClick(seq.id)}
                  className={cn(
                    'rounded-lg border bg-card p-5 transition-all duration-150 cursor-pointer hover-lift group relative',
                    isSelected ? 'border-accent ring-1 ring-accent/50' : 'border-border hover:border-accent/50'
                  )}
                >
                  {/* Checkbox */}
                  <div
                    className={cn(
                      'absolute top-3 left-3 transition-opacity',
                      selected.size > 0 || isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    )}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleSelect(seq.id)}
                    />
                  </div>

                  <div className={cn('flex items-start justify-between mb-4', selected.size > 0 || isSelected ? 'pl-8' : 'group-hover:pl-8 transition-all')}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="text-base font-semibold text-foreground truncate">{seq.name}</h3>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {seq.channel} • {seq.description ?? ''}
                        {(seq as any).jobs && <> • <span className="text-gold font-medium">{(seq as any).jobs.title}</span></>}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-3">
                      {(seq.status === 'active' || seq.status === 'paused') && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={(e) => toggleStatus(e, seq.id, seq.status)}
                        >
                          {seq.status === 'active' ? (
                            <Pause className="h-3.5 w-3.5 text-warning" />
                          ) : (
                            <Play className="h-3.5 w-3.5 text-success" />
                          )}
                        </Button>
                      )}
                      <span className={cn('stage-badge border', statusColors[seq.status] ?? '')}>
                        {seq.status}
                      </span>
                    </div>
                  </div>

                  <div className={cn('flex items-center gap-1 mb-4', selected.size > 0 || isSelected ? 'pl-8' : 'group-hover:pl-8 transition-all')}>
                    {steps.sort((a: any, b: any) => a.step_order - b.step_order).map((step: any, index: number) => (
                      <div key={step.id} className="flex items-center">
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-muted-foreground">
                          {channelIcons[step.channel ?? seq.channel] ?? <Mail className="h-3.5 w-3.5" />}
                        </div>
                        {index < steps.length - 1 && <div className="h-px w-6 bg-border" />}
                      </div>
                    ))}
                    <span className="ml-2 text-xs text-muted-foreground">{steps.length} steps</span>
                  </div>

                  <div className="grid grid-cols-2 gap-4 pt-4 border-t border-border">
                    <div>
                      <p className="text-lg font-semibold text-foreground">{enrollments.length}</p>
                      <p className="text-xs text-muted-foreground">Enrolled</p>
                    </div>
                    <div className="flex items-center justify-end">
                      <Button variant="ghost" size="sm" onClick={(e) => e.stopPropagation()}>
                        <BarChart3 className="h-4 w-4 mr-1" />
                        Analytics
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Template Picker Dialog */}
      <Dialog open={templateDialogOpen} onOpenChange={setTemplateDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Start from Template</DialogTitle>
          </DialogHeader>
          <Input
            placeholder="Search templates..."
            value={templateSearch}
            onChange={(e) => setTemplateSearch(e.target.value)}
            className="mb-3"
          />
          <ScrollArea className="max-h-80">
            <div className="space-y-2">
              {templates
                .filter(t => !templateSearch || t.name.toLowerCase().includes(templateSearch.toLowerCase()))
                .map((template: any) => {
                  const stepsCount = Array.isArray(template.steps_json) ? template.steps_json.length : 0;
                  return (
                    <button
                      key={template.id}
                      onClick={() => handleCreateFromTemplate(template)}
                      className="w-full text-left rounded-lg border border-border p-3 hover:bg-accent/10 transition-colors"
                    >
                      <p className="text-sm font-medium text-foreground">{template.name}</p>
                      {template.description && <p className="text-xs text-muted-foreground mt-0.5">{template.description}</p>}
                      <p className="text-[10px] text-muted-foreground mt-1">
                        {template.channel} &middot; {stepsCount} step{stepsCount !== 1 ? 's' : ''} &middot; {template.stop_on_reply ? 'Stop on reply' : 'Continue on reply'}
                      </p>
                    </button>
                  );
                })}
              {templates.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">No templates saved yet. Save a sequence as a template first.</p>
              )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
};

export default Campaigns;
