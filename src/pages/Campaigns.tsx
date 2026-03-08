import { useState, useMemo } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { useSequences } from '@/hooks/useSupabaseData';
import { CampaignBuilder } from '@/components/campaigns/CampaignBuilder';
import { Plus, Search, Play, Pause, Mail, MessageSquare, Phone, Linkedin, Users, BarChart3 } from 'lucide-react';
import { cn } from '@/lib/utils';

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
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<string>('all');
  const [builderOpen, setBuilderOpen] = useState(false);
  const { data: sequences = [], isLoading } = useSequences();

  const filteredSequences = useMemo(() => sequences.filter((seq) => {
    const matchesSearch = seq.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = filter === 'all' || seq.status === filter;
    return matchesSearch && matchesFilter;
  }), [sequences, searchQuery, filter]);

  return (
    <MainLayout>
      <PageHeader 
        title="Campaigns" 
        description="Multi-channel outreach sequences for candidates and business development."
        actions={
          <Button variant="gold" onClick={() => setBuilderOpen(true)}>
            <Plus className="h-4 w-4" />
            New Campaign
          </Button>
        }
      />
      <CampaignBuilder open={builderOpen} onOpenChange={setBuilderOpen} />
      
      <div className="p-8">
        <div className="flex flex-wrap items-center gap-4 mb-6">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search campaigns..."
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
          <p className="text-muted-foreground text-sm">Loading campaigns...</p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {filteredSequences.map((seq) => {
              const steps = (seq.sequence_steps as any[]) ?? [];
              const enrollments = (seq.sequence_enrollments as any[]) ?? [];
              return (
                <div
                  key={seq.id}
                  className="rounded-lg border border-border bg-card p-5 hover:border-accent/50 transition-all duration-150 cursor-pointer hover-lift"
                >
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <h3 className="text-base font-semibold text-foreground">{seq.name}</h3>
                      <span className="text-xs text-muted-foreground">{seq.channel} • {seq.description ?? ''}</span>
                    </div>
                    <span className={cn('stage-badge border', statusColors[seq.status] ?? '')}>
                      {seq.status}
                    </span>
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
                      <Button variant="ghost" size="sm">
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
