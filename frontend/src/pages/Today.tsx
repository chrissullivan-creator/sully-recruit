import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { SegmentedNav } from '@/components/layout/SegmentedNav';
import { SectionCard } from '@/components/shared/SectionCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Clock, X, ChevronRight, Martini } from 'lucide-react';

/**
 * "Today / For You" — Phase 1 of the proactive-Joe roadmap. Renders the
 * per-recruiter morning briefing written by the `joe-daily-brief` Inngest cron
 * into `joe_briefings`. READ-ONLY surface: actions here only update a briefing
 * row's status (done / snooze / dismiss) and link out to the entity — nothing
 * here messages or moves anyone.
 *
 * The cron only writes rows when JOE_PROACTIVE_ENABLED is on, so until the
 * feature is switched on this page shows a friendly empty state.
 */

type Briefing = {
  id: string;
  entity_type: 'candidate' | 'client' | 'job';
  entity_id: string;
  category: 'hot_lead' | 'going_cold' | 'stalled' | 'reply_waiting' | 'ops_warning';
  headline: string;
  rationale: string | null;
  score: number;
  status: 'open' | 'done' | 'dismissed' | 'snoozed';
};

const CATEGORY_META: Record<
  Briefing['category'],
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  hot_lead: { label: 'Hot lead', variant: 'default' },
  reply_waiting: { label: 'Reply waiting', variant: 'secondary' },
  going_cold: { label: 'Going cold', variant: 'destructive' },
  stalled: { label: 'Stalled', variant: 'outline' },
  ops_warning: { label: 'Heads up', variant: 'outline' },
};

function entityPath(b: Briefing): string {
  if (b.entity_type === 'job') return `/jobs/${b.entity_id}`;
  if (b.entity_type === 'client') return `/contacts/${b.entity_id}`;
  return `/candidates/${b.entity_id}`;
}

export default function Today() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ownerUserId = user?.id ?? null;

  const { data: briefings = [], isLoading } = useQuery({
    queryKey: ['joe_briefings', ownerUserId],
    enabled: !!ownerUserId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('joe_briefings')
        .select('id, entity_type, entity_id, category, headline, rationale, score, status')
        .eq('owner_user_id', ownerUserId)
        .eq('status', 'open')
        .order('score', { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as Briefing[];
    },
  });

  const updateStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: Briefing['status'] }) => {
      const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
      if (status === 'snoozed') {
        const t = new Date();
        t.setDate(t.getDate() + 1);
        patch.snoozed_until = t.toISOString();
      }
      const { error } = await (supabase as any).from('joe_briefings').update(patch).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['joe_briefings', ownerUserId] }),
    onError: (e: any) => toast.error(e?.message ?? 'Could not update'),
  });

  const grouped = useMemo(() => {
    const order: Briefing['category'][] = [
      'reply_waiting',
      'hot_lead',
      'stalled',
      'going_cold',
      'ops_warning',
    ];
    // Dedupe to one card per person. Briefings accumulate across daily runs and
    // a person can surface under more than one category, which showed the same
    // contact several times (e.g. two "Rachel Phillips"). Keep the highest-
    // scored card per entity — `briefings` is already ordered by score desc.
    const seen = new Set<string>();
    const deduped = briefings.filter((b) => {
      const key = `${b.entity_type}:${b.entity_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return order
      .map((cat) => ({ cat, items: deduped.filter((b) => b.category === cat) }))
      .filter((g) => g.items.length > 0);
  }, [briefings]);

  return (
    <MainLayout>
      <PageHeader
        title="Today"
        description="Joe's morning read on who needs you — ranked by priority."
        icon={<Martini />}
      >
        <SegmentedNav items={[{ label: 'Overview', href: '/' }, { label: 'Today', href: '/today' }]} />
      </PageHeader>

      <div className="bg-page-bg min-h-[calc(100vh-4rem)] p-6 lg:p-8">
        <div className="max-w-3xl mx-auto w-full">
          {isLoading ? (
            <SectionCard>
              <div className="text-sm text-muted-foreground py-12 text-center">Loading…</div>
            </SectionCard>
          ) : briefings.length === 0 ? (
            <SectionCard>
              <div className="py-12 text-center">
                <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Martini className="h-6 w-6" />
                </span>
                <p className="font-display text-base font-semibold text-foreground">No briefing items right now</p>
                <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
                  Joe builds a prioritized list each morning of the people who need your
                  attention — warm replies waiting on you, hot leads, and contacts going cold.
                  Items will appear here once proactive briefings are switched on.
                </p>
              </div>
            </SectionCard>
          ) : (
            <div className="space-y-6">
              {grouped.map(({ cat, items }) => (
                <div key={cat}>
                  <div className="flex items-center gap-2 mb-2.5">
                    <Badge variant={CATEGORY_META[cat].variant}>{CATEGORY_META[cat].label}</Badge>
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {items.length}
                    </span>
                  </div>
                  <div className="space-y-2.5">
                    {items.map((b) => (
                      <div
                        key={b.id}
                        className="group rounded-2xl border border-card-border bg-card shadow-sm p-4 flex items-start gap-3 transition-colors hover:border-primary/30"
                      >
                        <button
                          onClick={() => navigate(entityPath(b))}
                          className="flex-1 text-left min-w-0"
                        >
                          <div className="font-medium text-sm text-foreground flex items-center gap-1">
                            <span className="truncate group-hover:text-primary transition-colors">{b.headline}</span>
                            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                          </div>
                          {b.rationale && (
                            <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                              {b.rationale}
                            </div>
                          )}
                        </button>
                        <div className="flex items-center gap-0.5 shrink-0">
                          <Button
                            size="xs"
                            variant="ghost"
                            title="Mark done"
                            onClick={() => updateStatus.mutate({ id: b.id, status: 'done' })}
                          >
                            <Check className="h-4 w-4" />
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            title="Snooze to tomorrow"
                            onClick={() => updateStatus.mutate({ id: b.id, status: 'snoozed' })}
                          >
                            <Clock className="h-4 w-4" />
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            title="Dismiss"
                            onClick={() => updateStatus.mutate({ id: b.id, status: 'dismissed' })}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </MainLayout>
  );
}
