import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCheck, Clock, Loader2, Martini } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/shared/SectionCard';
import { DataErrorState } from '@/components/shared/EmptyState';
import { supabase } from '@/integrations/supabase/client';
import { JoeActionCard } from '@/components/joe/JoeActionCard';
import {
  executeJoeAction,
  isJoeQueueItemVisible,
  isLowRiskBatchAction,
  queueRowToJoeAction,
  updateJoeActionQueueStatus,
  type JoeActionQueueItem,
  type JoeActionResolution,
} from '@/lib/joeActions';
import { withQueryTimeout } from '@/lib/queryTimeout';

export function JoeActionQueue({ ownerUserId }: { ownerUserId: string | null }) {
  const queryClient = useQueryClient();
  const [batchBusy, setBatchBusy] = useState(false);
  const {
    data: queueItems = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['joe_action_queue', ownerUserId],
    enabled: !!ownerUserId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await withQueryTimeout((supabase.from('joe_action_queue' as any) as any)
        .select('id, source, action_type, entity_type, entity_id, title, preview, params, route, status, created_at, updated_at, resolved_at, snoozed_until, history')
        .eq('owner_user_id', ownerUserId)
        .in('status', ['pending', 'snoozed'])
        .order('created_at', { ascending: false })
        .limit(50), 'Joe action queue data source');
      if (error) throw error;
      return ((data ?? []) as any[]).map(queueRowToJoeAction);
    },
  });

  const visibleItems = useMemo(
    () => queueItems.filter((item) => isJoeQueueItemVisible(item)),
    [queueItems],
  );
  const lowRiskBatchItems = visibleItems.filter(isLowRiskBatchAction);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['joe_action_queue', ownerUserId] });

  const resolveItem = async (id: string, resolution: JoeActionResolution = 'dismissed') => {
    try {
      await updateJoeActionQueueStatus(id, resolution, {
        actor: 'recruiter',
        note: resolution === 'approved' ? 'Opened review surface from Today' : undefined,
      });
      invalidate();
    } catch (err: any) {
      toast.error(err?.message ?? 'Could not update Joe action');
    }
  };

  const snoozeItem = async (item: JoeActionQueueItem) => {
    const wakeAt = new Date();
    wakeAt.setDate(wakeAt.getDate() + 1);
    wakeAt.setHours(8, 0, 0, 0);
    try {
      await updateJoeActionQueueStatus(item.id, 'snoozed', {
        actor: 'recruiter',
        snoozedUntil: wakeAt,
        note: 'Snoozed from Today',
      });
      toast.success('Snoozed until tomorrow morning');
      invalidate();
    } catch (err: any) {
      toast.error(err?.message ?? 'Could not snooze Joe action');
    }
  };

  const approveLowRiskBatch = async () => {
    if (!ownerUserId || lowRiskBatchItems.length === 0 || batchBusy) return;
    setBatchBusy(true);
    let completed = 0;
    try {
      for (const item of lowRiskBatchItems) {
        await executeJoeAction(item, ownerUserId);
        await updateJoeActionQueueStatus(item.id, 'done', {
          actor: 'recruiter',
          note: 'Batch-approved from Today',
        });
        completed += 1;
      }
      toast.success(`${completed} Joe action${completed === 1 ? '' : 's'} completed`);
      invalidate();
    } catch (err: any) {
      toast.error(err?.message ?? 'Batch approval stopped');
      invalidate();
    } finally {
      setBatchBusy(false);
    }
  };

  if (!ownerUserId) return null;

  if (isLoading) {
    return (
      <SectionCard className="mb-6">
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading Joe's queue...
        </div>
      </SectionCard>
    );
  }

  if (isError) {
    return (
      <DataErrorState
        className="mb-6"
        title="Joe action queue unavailable"
        description="Queued proposals could not load. No queued sends, enrollments, tasks, notes, or stage moves have run."
        error={error}
        onRetry={() => refetch()}
      />
    );
  }

  if (visibleItems.length === 0) return null;

  return (
    <SectionCard className="mb-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Martini className="h-4 w-4" />
          </span>
          <div>
            <p className="font-display text-sm font-semibold text-foreground">Joe action queue</p>
            <p className="text-xs text-muted-foreground">
              {visibleItems.length} proposal{visibleItems.length === 1 ? '' : 's'} waiting for approval
            </p>
          </div>
        </div>
        {lowRiskBatchItems.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={approveLowRiskBatch}
            disabled={batchBusy}
          >
            {batchBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}
            Approve notes/tasks
          </Button>
        )}
      </div>

      <div className="space-y-2">
        {visibleItems.map((item) => (
          <JoeActionCard
            key={item.id}
            action={item}
            onResolve={resolveItem}
            footerActions={
              <Button size="xs" variant="ghost" onClick={() => snoozeItem(item)}>
                <Clock className="h-3.5 w-3.5" /> Snooze
              </Button>
            }
          />
        ))}
      </div>
    </SectionCard>
  );
}
