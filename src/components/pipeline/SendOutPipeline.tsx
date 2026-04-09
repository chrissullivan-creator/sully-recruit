import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SendOutRecord {
  id: string;
  job_id: string;
  candidate_id?: string;
  contact_id?: string;
  candidate_name?: string;
  contact_name?: string;
  company_name?: string;
  status: 'lead' | 'back_of_resume' | 'reached_out' | 'pitch' | 'sent' | 'interview' | 'offer' | 'placed' | 'rejected' | 'withdrawn';
}

interface SendOutPipelineProps {
  title: string;
  sendOuts: SendOutRecord[];
  isLoading?: boolean;
  onRemove?: (id: string) => void;
}

const pipelineStages = ['lead', 'back_of_resume', 'reached_out', 'pitch', 'sent', 'interview', 'offer', 'placed'] as const;
const exitLanes = ['rejected', 'withdrawn'] as const;

const statusColors: Record<string, string> = {
  lead: 'bg-slate-100 text-slate-700 border-slate-200',
  back_of_resume: 'bg-gray-100 text-gray-700 border-gray-200',
  reached_out: 'bg-blue-100 text-blue-700 border-blue-200',
  pitch: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  sent: 'bg-purple-100 text-purple-700 border-purple-200',
  interview: 'bg-amber-100 text-amber-700 border-amber-200',
  offer: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  placed: 'bg-green-600 text-white border-green-700',
  rejected: 'bg-destructive/10 text-destructive border-destructive/20',
  withdrawn: 'bg-muted text-muted-foreground border-border',
};

const statusLabels: Record<string, string> = {
  lead: 'Lead',
  back_of_resume: 'Back of Resume',
  reached_out: 'Reached Out',
  pitch: 'Pitch / Send Out',
  sent: 'Sent',
  interview: 'Interview',
  offer: 'Offer',
  placed: 'Placement',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export const SendOutPipeline = ({
  title,
  sendOuts = [],
  isLoading = false,
  onRemove,
}: SendOutPipelineProps) => {
  const queryClient = useQueryClient();
  const [updating, setUpdating] = useState<string | null>(null);

  const handleStatusChange = async (recordId: string, newStatus: string) => {
    if (updating === recordId) return;
    setUpdating(recordId);

    try {
      const { error } = await supabase
        .from('send_out_board')
        .update({ stage: newStatus })
        .eq('id', recordId);

      if (error) throw error;

      toast.success(`Status updated to ${statusLabels[newStatus]}`);
      queryClient.invalidateQueries({ queryKey: ['send_out_board'] });
      queryClient.invalidateQueries({ queryKey: ['send_outs_job'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to update status');
    } finally {
      setUpdating(recordId);
    }
  };

  const handleRemove = async (recordId: string) => {
    try {
      const { error } = await supabase
        .from('send_out_board')
        .delete()
        .eq('id', recordId);

      if (error) throw error;

      toast.success('Record removed');
      if (onRemove) onRemove(recordId);
      queryClient.invalidateQueries({ queryKey: ['send_out_board'] });
      queryClient.invalidateQueries({ queryKey: ['send_outs_job'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to remove record');
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
          Loading...
        </CardContent>
      </Card>
    );
  }

  const groupedBySendOuts = {
    lead: sendOuts.filter(s => s.status === 'lead'),
    back_of_resume: sendOuts.filter(s => s.status === 'back_of_resume'),
    reached_out: sendOuts.filter(s => s.status === 'reached_out'),
    pitch: sendOuts.filter(s => s.status === 'pitch'),
    sent: sendOuts.filter(s => s.status === 'sent'),
    interview: sendOuts.filter(s => s.status === 'interview'),
    offer: sendOuts.filter(s => s.status === 'offer'),
    placed: sendOuts.filter(s => s.status === 'placed'),
    rejected: sendOuts.filter(s => s.status === 'rejected'),
    withdrawn: sendOuts.filter(s => s.status === 'withdrawn'),
  };

  const totalCount = sendOuts.length;
  const successCount = (groupedBySendOuts.placed?.length ?? 0);
  const exitCount = (groupedBySendOuts.rejected?.length ?? 0) + (groupedBySendOuts.withdrawn?.length ?? 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-4 flex gap-6 text-sm">
          <div>
            <p className="text-muted-foreground">Total</p>
            <p className="text-lg font-semibold">{totalCount}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Placed</p>
            <p className="text-lg font-semibold text-green-600">{successCount}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Exited</p>
            <p className="text-lg font-semibold text-destructive">{exitCount}</p>
          </div>
        </div>

        {totalCount === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No send out records yet
          </p>
        ) : (
          <>
            {/* Pipeline View */}
            <div className="mb-6 space-y-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Active Pipeline
              </p>
              <div className="grid grid-cols-1 md:grid-cols-4 lg:grid-cols-8 gap-3">
                {pipelineStages.map((stage) => (
                  <div key={stage} className="space-y-2">
                    <div className="text-xs font-medium text-muted-foreground">
                      {statusLabels[stage]}
                      <span className="ml-1 text-foreground">({groupedBySendOuts[stage]?.length || 0})</span>
                    </div>
                    <div className="space-y-2">
                      {groupedBySendOuts[stage]?.map((record) => (
                        <div
                          key={record.id}
                          className={cn(
                            'p-2 rounded-md border text-xs cursor-move group hover:shadow-md transition-shadow',
                            statusColors[stage]
                          )}
                        >
                          <div className="font-medium truncate">
                            {record.candidate_name || record.contact_name || 'Unknown'}
                          </div>
                          {record.company_name && (
                            <div className="text-xs opacity-75 truncate">{record.company_name}</div>
                          )}
                          <div className="mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Select
                              value={record.status}
                              onValueChange={(newStatus) => handleStatusChange(record.id, newStatus)}
                              disabled={updating === record.id}
                            >
                              <SelectTrigger className="h-6 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {[...pipelineStages, ...exitLanes].map((status) => (
                                  <SelectItem key={status} value={status}>
                                    {statusLabels[status]}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Exit Lanes */}
            {exitCount > 0 && (
              <div className="space-y-4 border-t pt-4">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Exit Lanes
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {exitLanes.map((stage) => (
                    <div key={stage} className="space-y-2">
                      <div className="text-xs font-medium text-muted-foreground">
                        {statusLabels[stage]}
                        <span className="ml-1 text-foreground">({groupedBySendOuts[stage]?.length || 0})</span>
                      </div>
                      <div className="space-y-2">
                        {groupedBySendOuts[stage]?.map((record) => (
                          <div
                            key={record.id}
                            className={cn(
                              'p-2 rounded-md border text-xs flex items-center justify-between group',
                              statusColors[stage]
                            )}
                          >
                            <div>
                              <div className="font-medium truncate">
                                {record.candidate_name || record.contact_name || 'Unknown'}
                              </div>
                              {record.company_name && (
                                <div className="text-xs opacity-75">{record.company_name}</div>
                              )}
                            </div>
                            <button
                              onClick={() => handleRemove(record.id)}
                              className="opacity-0 group-hover:opacity-100 transition-opacity ml-2"
                              title="Remove record"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
};