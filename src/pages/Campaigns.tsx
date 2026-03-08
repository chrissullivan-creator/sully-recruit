import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { useSequences } from '@/hooks/useSupabaseData';
import { Plus, Search, Play, Pause, Mail, MessageSquare, Phone, Linkedin, Users, BarChart3, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
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
  const { data: sequences = [], isLoading } = useSequences();
  const queryClient = useQueryClient();

  const filteredSequences = useMemo(() => sequences.filter((seq) => {
    const matchesSearch = seq.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = filter === 'all' || seq.status === filter;
    return matchesSearch && matchesFilter;
  }), [sequences, searchQuery, filter]);

  const handleCardClick = (seqId: string) => {
    navigate(`/campaigns/${seqId}`);
  };

  const handleCreateNew = async () => {
    setCreating(true);
    try {
      const { data: seq, error } = await supabase
        .from('sequences')
        .insert({ name: 'Untitled Sequence', channel: 'email', status: 'draft', stop_on_reply: true } as any)
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

  return (
    <MainLayout>
      <PageHeader 
        title="Sequences" 
        description="Multi-channel outreach sequences for candidates and business development."
        actions={
          <Button variant="gold" onClick={() => { setEditingSequenceId(null); setBuilderOpen(true); }}>
            <Plus className="h-4 w-4" />
            New Sequence
          </Button>
        }
      />
      <CampaignBuilder
        open={builderOpen}
        onOpenChange={handleBuilderClose}
        editSequenceId={editingSequenceId}
      />
      
      <div className="p-8">
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
            <Button variant="gold" onClick={() => { setEditingSequenceId(null); setBuilderOpen(true); }}>
              <Plus className="h-4 w-4 mr-1" />
              New Sequence
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {filteredSequences.map((seq) => {
              const steps = (seq.sequence_steps as any[]) ?? [];
              const enrollments = (seq.sequence_enrollments as any[]) ?? [];
              return (
                <div
                  key={seq.id}
                  onClick={() => handleCardClick(seq.id)}
                  className="rounded-lg border border-border bg-card p-5 hover:border-accent/50 transition-all duration-150 cursor-pointer hover-lift group"
                >
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="text-base font-semibold text-foreground truncate">{seq.name}</h3>
                        <Pencil className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                      </div>
                      <span className="text-xs text-muted-foreground">{seq.channel} • {seq.description ?? ''}</span>
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

                  <div className="flex items-center gap-1 mb-4">
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
    </MainLayout>
  );
};

export default Campaigns;
