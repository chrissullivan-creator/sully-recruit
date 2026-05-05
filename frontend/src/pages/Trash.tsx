import { useState } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { restoreSoftDeleted, type SoftDeletable } from '@/lib/softDelete';
import {
  invalidatePersonScope, invalidateJobScope, invalidateSendOutScope, invalidateCompanyScope,
} from '@/lib/invalidate';
import { toast } from 'sonner';
import { format, formatDistanceToNow, addDays } from 'date-fns';
import {
  Trash2, Undo2, Users2, Briefcase, Building2, Send, Loader2,
} from 'lucide-react';
import { useProfiles } from '@/hooks/useProfiles';

interface TrashRow {
  id: string;
  deleted_at: string;
  deleted_by_user_id: string | null;
  primary: string;
  secondary?: string;
}

const TABS: { value: SoftDeletable; label: string; icon: any }[] = [
  { value: 'people',    label: 'People',     icon: Users2 },
  { value: 'jobs',      label: 'Jobs',       icon: Briefcase },
  { value: 'send_outs', label: 'Send-outs',  icon: Send },
  { value: 'companies', label: 'Companies',  icon: Building2 },
];

function useTrash(table: SoftDeletable) {
  return useQuery({
    queryKey: ['trash', table],
    staleTime: 30_000,
    queryFn: async () => {
      let select = 'id, deleted_at, deleted_by_user_id';
      if (table === 'people')    select += ', full_name, first_name, last_name, email, type, current_title, current_company';
      if (table === 'jobs')      select += ', title, company_name, status';
      if (table === 'companies') select += ', name, industry, company_type';
      if (table === 'send_outs') select += ', stage, candidate_id, job_id';
      const { data, error } = await supabase
        .from(table)
        .select(select)
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: false })
        .limit(500);
      if (error) throw error;

      return (data ?? []).map((r: any): TrashRow => {
        if (table === 'people') {
          const name = r.full_name || `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email || r.id.slice(0, 8);
          return {
            id: r.id, deleted_at: r.deleted_at, deleted_by_user_id: r.deleted_by_user_id,
            primary: name,
            secondary: [r.type, r.current_title, r.current_company].filter(Boolean).join(' · '),
          };
        }
        if (table === 'jobs') {
          return {
            id: r.id, deleted_at: r.deleted_at, deleted_by_user_id: r.deleted_by_user_id,
            primary: r.title || r.id.slice(0, 8),
            secondary: [r.company_name, r.status].filter(Boolean).join(' · '),
          };
        }
        if (table === 'companies') {
          return {
            id: r.id, deleted_at: r.deleted_at, deleted_by_user_id: r.deleted_by_user_id,
            primary: r.name || r.id.slice(0, 8),
            secondary: [r.industry, r.company_type].filter(Boolean).join(' · '),
          };
        }
        return {
          id: r.id, deleted_at: r.deleted_at, deleted_by_user_id: r.deleted_by_user_id,
          primary: `Send-out → ${r.stage ?? '—'}`,
          secondary: r.id.slice(0, 8),
        };
      });
    },
  });
}

function invalidateScopeFor(table: SoftDeletable, qc: any) {
  if (table === 'people')    invalidatePersonScope(qc);
  if (table === 'jobs')      invalidateJobScope(qc);
  if (table === 'send_outs') invalidateSendOutScope(qc);
  if (table === 'companies') invalidateCompanyScope(qc);
}

function daysLeft(deletedAt: string): number {
  const purgeAt = addDays(new Date(deletedAt), 30);
  const ms = purgeAt.getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

export default function Trash() {
  const [tab, setTab] = useState<SoftDeletable>('people');
  const queryClient = useQueryClient();
  const { data: profiles = [] } = useProfiles();
  const profileById = new Map(profiles.map((p) => [p.id, p.full_name || p.email || '?']));

  return (
    <MainLayout>
      <PageHeader
        title="Trash"
        description="Soft-deleted records. Restore within 30 days; after that they're purged automatically."
      />

      <div className="bg-page-bg min-h-[calc(100vh-4rem)] p-6 lg:p-8">
        <Tabs value={tab} onValueChange={(v) => setTab(v as SoftDeletable)}>
          <TabsList>
            {TABS.map(({ value, label, icon: Icon }) => (
              <TabsTrigger key={value} value={value} className="gap-1.5">
                <Icon className="h-3.5 w-3.5" /> {label}
              </TabsTrigger>
            ))}
          </TabsList>

          {TABS.map(({ value, label }) => (
            <TabsContent key={value} value={value}>
              <TrashTable
                table={value}
                label={label}
                profileById={profileById}
                onRestored={() => invalidateScopeFor(value, queryClient)}
              />
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </MainLayout>
  );
}

function TrashTable({
  table, label, profileById, onRestored,
}: {
  table: SoftDeletable; label: string;
  profileById: Map<string, string>;
  onRestored: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: rows = [], isLoading, refetch } = useTrash(table);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const handleRestore = async (id: string, name: string) => {
    setRestoringId(id);
    const { error } = await restoreSoftDeleted(table, id);
    setRestoringId(null);
    if (error) { toast.error(error.message); return; }
    toast.success(`${name} restored`);
    queryClient.invalidateQueries({ queryKey: ['trash', table] });
    onRestored();
  };

  if (isLoading) {
    return (
      <div className="rounded-xl border border-card-border bg-white p-12 text-center text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" /> Loading…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-card-border bg-white p-12 text-center">
        <Trash2 className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
        <p className="text-sm font-display font-semibold text-emerald-dark">No deleted {label.toLowerCase()}</p>
        <p className="text-xs text-muted-foreground mt-1">Anything you delete shows up here for 30 days.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-card-border bg-white overflow-hidden">
      <div className="divide-y divide-card-border">
        {rows.map((r) => {
          const left = daysLeft(r.deleted_at);
          const purging = left <= 3;
          return (
            <div key={r.id} className="px-5 py-3 flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-emerald-dark truncate">{r.primary}</p>
                {r.secondary && (
                  <p className="text-xs text-muted-foreground truncate">{r.secondary}</p>
                )}
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Deleted {formatDistanceToNow(new Date(r.deleted_at), { addSuffix: true })}
                  {r.deleted_by_user_id && (
                    <> by <span className="font-medium">{profileById.get(r.deleted_by_user_id) || 'unknown'}</span></>
                  )}
                </p>
              </div>
              <Badge
                variant="outline"
                className={purging
                  ? 'border-red-300 text-red-700'
                  : 'border-amber-300 text-amber-700'}
              >
                {left} day{left === 1 ? '' : 's'} left
              </Badge>
              <Button
                size="sm"
                variant="outline"
                disabled={restoringId === r.id}
                onClick={() => handleRestore(r.id, r.primary)}
                className="gap-1.5"
              >
                {restoringId === r.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Undo2 className="h-3.5 w-3.5" />
                )}
                Restore
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
