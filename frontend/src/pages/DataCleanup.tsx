import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import {
  UserRound,
  Wand2,
  HelpCircle,
  Users,
  Linkedin,
  Mail,
  Phone,
  ExternalLink,
} from 'lucide-react';
import { NeedsClassificationList } from '@/components/inbox/NeedsClassificationList';

type CleanupTab = 'needs_classification' | 'duplicates' | 'enrichment_ambiguous' | 'missing_channel_data';

const TAB_LABELS: Record<CleanupTab, string> = {
  needs_classification: 'Needs classification',
  duplicates: 'Duplicates',
  enrichment_ambiguous: 'Enrichment ambiguous',
  missing_channel_data: 'Missing channel data',
};

const TAB_ICONS: Record<CleanupTab, React.ElementType> = {
  needs_classification: HelpCircle,
  duplicates: Users,
  enrichment_ambiguous: Wand2,
  missing_channel_data: UserRound,
};

export default function DataCleanup() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (searchParams.get('tab') as CleanupTab) || 'needs_classification';
  const [tab, setTab] = useState<CleanupTab>(initialTab);

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (tab === 'needs_classification') next.delete('tab');
    else next.set('tab', tab);
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Counts (lightweight, head-only queries)
  const { data: needsClassCount = 0 } = useQuery({
    queryKey: ['cleanup_needs_class_count'],
    queryFn: async () => {
      const { count } = await (supabase as any)
        .from('people')
        .select('id', { count: 'exact', head: true })
        .eq('needs_classification', true);
      return count ?? 0;
    },
  });

  const { data: missingChannelCount = 0 } = useQuery({
    queryKey: ['cleanup_missing_channel_count'],
    queryFn: async () => {
      // People missing at least one of email / linkedin / phone
      const { count } = await supabase
        .from('people')
        .select('id', { count: 'exact', head: true })
        .or('primary_email.is.null,linkedin_url.is.null,phone.is.null');
      return count ?? 0;
    },
  });

  const { data: ambiguousCount = 0 } = useQuery({
    queryKey: ['cleanup_enrichment_ambiguous_count'],
    queryFn: async () => {
      // Table may not exist yet (migration ships with enrichment infra) —
      // catch + return 0 in that case.
      try {
        const { count, error } = await (supabase as any)
          .from('enrichment_ambiguity')
          .select('id', { count: 'exact', head: true })
          .is('resolved_at', null);
        if (error) return 0;
        return count ?? 0;
      } catch {
        return 0;
      }
    },
  });

  const counts: Record<CleanupTab, number> = {
    needs_classification: needsClassCount,
    duplicates: 0, // duplicate scan is on-demand; CollisionReview owns this
    enrichment_ambiguous: ambiguousCount,
    missing_channel_data: missingChannelCount,
  };

  return (
    <MainLayout>
      <PageHeader
        title="Data Cleanup"
        description="Resolve auto-added people, duplicates, ambiguous enrichments, and missing channel coverage."
      />

      <div className="px-6 pb-6">
        <Tabs value={tab} onValueChange={(v) => setTab(v as CleanupTab)}>
          <TabsList className="grid grid-cols-4 max-w-3xl">
            {(Object.keys(TAB_LABELS) as CleanupTab[]).map((k) => {
              const Icon = TAB_ICONS[k];
              return (
                <TabsTrigger key={k} value={k} className="flex items-center gap-1.5">
                  <Icon className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{TAB_LABELS[k]}</span>
                  {counts[k] > 0 && (
                    <span
                      className={cn(
                        'text-[10px] tabular-nums rounded px-1.5 py-0.5 ml-1',
                        tab === k ? 'bg-accent/20 text-accent font-semibold' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {counts[k]}
                    </span>
                  )}
                </TabsTrigger>
              );
            })}
          </TabsList>

          <TabsContent value="needs_classification" className="mt-4">
            <Card className="overflow-hidden">
              <div className="px-4 py-3 border-b border-border/60 bg-muted/30">
                <h3 className="text-sm font-semibold">Auto-added people awaiting Candidate / Client tag</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  When you send an email or LinkedIn message to someone not in the CRM, we auto-add them so the
                  conversation gets saved. Click <strong>Candidate</strong> or <strong>Client</strong> to confirm
                  who they are, or <strong>Remove</strong> if they don't belong.
                </p>
              </div>
              <NeedsClassificationList />
            </Card>
          </TabsContent>

          <TabsContent value="duplicates" className="mt-4">
            <Card className="p-6 space-y-4">
              <div>
                <h3 className="text-sm font-semibold">Suspected duplicate candidate records</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  We have two existing scans for duplicate people — one keyed on overlapping resume identities
                  (Collision Review) and one on overlapping LinkedIn URL / email (Duplicates Review). Both run
                  on-demand; open either to scan + merge.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline" size="sm">
                  <Link to="/admin/collisions" className="flex items-center gap-1.5">
                    <Users className="h-3.5 w-3.5" />
                    Resume identity collisions
                    <ExternalLink className="h-3 w-3 opacity-60" />
                  </Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link to="/duplicates" className="flex items-center gap-1.5">
                    <Users className="h-3.5 w-3.5" />
                    LinkedIn / email duplicates
                    <ExternalLink className="h-3 w-3 opacity-60" />
                  </Link>
                </Button>
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="enrichment_ambiguous" className="mt-4">
            <Card className="p-6">
              <h3 className="text-sm font-semibold mb-2">Enrichment ambiguous</h3>
              <p className="text-xs text-muted-foreground mb-4">
                When an enrichment provider (Apollo, FullEnrich, BetterContact, PDL) returns multiple plausible
                matches for a person we can't auto-pick. Those cases will appear here for manual disambiguation.
              </p>
              {ambiguousCount === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  No ambiguous matches right now.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {ambiguousCount} ambiguous matches — UI for disambiguation ships with the enrichment integration.
                </p>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="missing_channel_data" className="mt-4">
            <Card className="overflow-hidden">
              <div className="px-4 py-3 border-b border-border/60 bg-muted/30">
                <h3 className="text-sm font-semibold">People missing email, LinkedIn, or phone</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Sparse channel coverage means we can't recognize them on inbound webhooks. Once the enrichment
                  waterfall (Apollo → FullEnrich → BetterContact → PDL) is wired, this page will offer a one-click
                  enrich-all button. For now, you can spot-check by clicking through and editing manually.
                </p>
              </div>
              <MissingChannelList />
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </MainLayout>
  );
}

interface MissingChannelRow {
  id: string;
  full_name: string | null;
  type: string;
  primary_email: string | null;
  linkedin_url: string | null;
  phone: string | null;
  current_company: string | null;
  current_title: string | null;
}

function MissingChannelList() {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['cleanup_missing_channel_list'],
    queryFn: async () => {
      const { data } = await supabase
        .from('people')
        .select('id, full_name, type, primary_email, linkedin_url, phone, current_company, current_title')
        .or('primary_email.is.null,linkedin_url.is.null,phone.is.null')
        .order('created_at', { ascending: false })
        .limit(100);
      return (data ?? []) as MissingChannelRow[];
    },
  });

  if (isLoading) {
    return <div className="p-6 text-xs text-muted-foreground">Loading…</div>;
  }

  if (rows.length === 0) {
    return (
      <div className="p-6 text-xs text-muted-foreground italic">
        Everyone has full channel coverage. Nothing to enrich.
      </div>
    );
  }

  return (
    <div className="divide-y divide-border/60">
      {rows.map((p) => (
        <div key={p.id} className="px-4 py-3 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Link to={`/candidates/${p.id}`} className="text-sm font-semibold text-foreground hover:text-accent truncate">
                {p.full_name || 'Unnamed'}
              </Link>
              <span className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                {p.type}
              </span>
            </div>
            {(p.current_title || p.current_company) && (
              <p className="text-xs text-muted-foreground truncate">
                {[p.current_title, p.current_company].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <ChannelDot ok={!!p.primary_email} Icon={Mail} title="Email" />
            <ChannelDot ok={!!p.linkedin_url} Icon={Linkedin} title="LinkedIn" />
            <ChannelDot ok={!!p.phone} Icon={Phone} title="Phone" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ChannelDot({ ok, Icon, title }: { ok: boolean; Icon: React.ElementType; title: string }) {
  return (
    <span
      title={`${title}: ${ok ? 'present' : 'missing'}`}
      className={cn(
        'inline-flex items-center justify-center h-6 w-6 rounded',
        ok ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground/60',
      )}
    >
      <Icon className="h-3 w-3" />
    </span>
  );
}
