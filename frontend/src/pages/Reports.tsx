import { useMemo, useState } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useProfiles } from '@/hooks/useProfiles';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, TrendingUp, Users, Building2, Calendar as CalendarIcon, Trophy } from 'lucide-react';
import { format, startOfMonth, endOfMonth, subMonths, startOfYear, parseISO } from 'date-fns';
import { cn } from '@/lib/utils';

type RangeKey = 'this_month' | 'last_month' | 'last_3' | 'ytd';

interface SendOutMetric {
  id: string;
  recruiter_id: string | null;
  job_id: string | null;
  candidate_id: string | null;
  stage: string | null;
  created_at: string;
  updated_at: string | null;
  candidate: { target_total_comp: number | null; target_base_comp: number | null } | null;
  job: { id: string; title: string | null; company_name: string | null; company_id: string | null } | null;
}

const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'this_month', label: 'This Month' },
  { key: 'last_month', label: 'Last Month' },
  { key: 'last_3', label: 'Last 90 Days' },
  { key: 'ytd', label: 'Year to Date' },
];

function rangeToDates(r: RangeKey): { start: Date; end: Date } {
  const now = new Date();
  if (r === 'this_month') return { start: startOfMonth(now), end: endOfMonth(now) };
  if (r === 'last_month') {
    const last = subMonths(now, 1);
    return { start: startOfMonth(last), end: endOfMonth(last) };
  }
  if (r === 'last_3') return { start: subMonths(now, 3), end: now };
  return { start: startOfYear(now), end: now };
}

function feeFromComp(comp: number | null | undefined): number {
  if (!comp || comp <= 0) return 0;
  return comp * 0.25;
}

function useSendOutMetrics(start: Date, end: Date) {
  return useQuery({
    queryKey: ['report_send_outs', start.toISOString(), end.toISOString()],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('send_outs')
        .select(`
          id, recruiter_id, job_id, candidate_id, stage, created_at, updated_at,
          candidate:people!send_outs_candidate_id_fkey(target_total_comp, target_base_comp),
          job:jobs!send_outs_job_id_fkey(id, title, company_name, company_id)
        `)
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString());
      if (error) throw error;
      return (data ?? []) as unknown as SendOutMetric[];
    },
    staleTime: 60_000,
  });
}

function fmtMoney(n: number) {
  if (n === 0) return '$0';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

export default function Reports() {
  const [range, setRange] = useState<RangeKey>('this_month');
  const { start, end } = useMemo(() => rangeToDates(range), [range]);
  const { data: rows = [], isLoading } = useSendOutMetrics(start, end);
  const { data: profiles = [] } = useProfiles();

  const profileById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of profiles) m.set(p.id, p.full_name || p.email || 'Unknown');
    return m;
  }, [profiles]);

  // Headline KPIs
  const totals = useMemo(() => {
    const sentOut = rows.filter((r) => ['submitted', 'sent'].includes(String(r.stage))).length;
    const interviews = rows.filter((r) => String(r.stage).startsWith('interview')).length;
    const offers = rows.filter((r) => r.stage === 'offer').length;
    const placements = rows.filter((r) => r.stage === 'placed').length;
    const placedFee = rows
      .filter((r) => r.stage === 'placed')
      .reduce((sum, r) => sum + feeFromComp(r.candidate?.target_total_comp ?? r.candidate?.target_base_comp), 0);
    const offerFee = rows
      .filter((r) => r.stage === 'offer')
      .reduce((sum, r) => sum + feeFromComp(r.candidate?.target_total_comp ?? r.candidate?.target_base_comp), 0);
    return { total: rows.length, sentOut, interviews, offers, placements, placedFee, offerFee };
  }, [rows]);

  return (
    <MainLayout>
      <PageHeader
        title="Reports"
        description="Performance breakdown by recruiter, client, and month."
        actions={
          <Select value={range} onValueChange={(v) => setRange(v as RangeKey)}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              {RANGES.map((r) => <SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>)}
            </SelectContent>
          </Select>
        }
      />

      <div className="bg-page-bg min-h-[calc(100vh-4rem)] p-6 lg:p-8 space-y-6">
        {/* KPI strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          <KpiCard label="Total Send-outs" value={totals.total.toString()} />
          <KpiCard label="Sent Out" value={totals.sentOut.toString()} />
          <KpiCard label="Interviews" value={totals.interviews.toString()} />
          <KpiCard label="Offers" value={totals.offers.toString()} />
          <KpiCard label="Placements" value={totals.placements.toString()} highlight />
          <KpiCard label="Placed Fee" value={fmtMoney(totals.placedFee)} highlight />
          <KpiCard label="Pending (Offer) Fee" value={fmtMoney(totals.offerFee)} />
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin mr-2" /> Loading…
          </div>
        ) : (
          <Tabs defaultValue="recruiter" className="w-full">
            <TabsList>
              <TabsTrigger value="recruiter"><Users className="h-3.5 w-3.5 mr-1.5" /> By Recruiter</TabsTrigger>
              <TabsTrigger value="client"><Building2 className="h-3.5 w-3.5 mr-1.5" /> By Client</TabsTrigger>
              <TabsTrigger value="month"><CalendarIcon className="h-3.5 w-3.5 mr-1.5" /> By Month</TabsTrigger>
            </TabsList>

            <TabsContent value="recruiter">
              <RecruiterTable rows={rows} profileById={profileById} />
            </TabsContent>
            <TabsContent value="client">
              <ClientTable rows={rows} />
            </TabsContent>
            <TabsContent value="month">
              <MonthTable rows={rows} />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </MainLayout>
  );
}

function KpiCard({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={cn(
      'rounded-xl border p-3 bg-white',
      highlight ? 'border-gold/40 bg-gold-bg/40' : 'border-card-border',
    )}>
      <p className="text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn(
        'mt-1 text-xl font-display font-bold tabular-nums',
        highlight ? 'text-gold-deep' : 'text-emerald-dark',
      )}>{value}</p>
    </div>
  );
}

interface AggRow {
  key: string;
  label: string;
  total: number;
  sentOut: number;
  interviews: number;
  offers: number;
  placements: number;
  fee: number;
}

function aggregate(rows: SendOutMetric[], keyOf: (r: SendOutMetric) => { key: string; label: string } | null): AggRow[] {
  const map = new Map<string, AggRow>();
  for (const r of rows) {
    const k = keyOf(r);
    if (!k) continue;
    if (!map.has(k.key)) {
      map.set(k.key, {
        key: k.key, label: k.label,
        total: 0, sentOut: 0, interviews: 0, offers: 0, placements: 0, fee: 0,
      });
    }
    const agg = map.get(k.key)!;
    agg.total++;
    const s = String(r.stage);
    if (s === 'submitted' || s === 'sent') agg.sentOut++;
    else if (s.startsWith('interview')) agg.interviews++;
    else if (s === 'offer') agg.offers++;
    else if (s === 'placed') {
      agg.placements++;
      agg.fee += feeFromComp(r.candidate?.target_total_comp ?? r.candidate?.target_base_comp);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.fee - a.fee || b.placements - a.placements || b.total - a.total);
}

function AggTable({ rows, headerLabel, emptyText }: { rows: AggRow[]; headerLabel: string; emptyText: string }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-card-border bg-white py-16 text-center">
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      </div>
    );
  }
  const top = rows[0];
  return (
    <div className="rounded-xl border border-card-border bg-white overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="text-left text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground border-b border-card-border bg-page-bg/40">
            <th className="px-4 py-2.5">{headerLabel}</th>
            <th className="px-3 py-2.5 text-right">Total</th>
            <th className="px-3 py-2.5 text-right">Sent</th>
            <th className="px-3 py-2.5 text-right">Interviews</th>
            <th className="px-3 py-2.5 text-right">Offers</th>
            <th className="px-3 py-2.5 text-right">Placed</th>
            <th className="px-3 py-2.5 text-right">Fee</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-card-border last:border-b-0 hover:bg-emerald-light/15">
              <td className="px-4 py-2.5 text-sm font-medium text-emerald-dark flex items-center gap-2">
                {r.key === top.key && top.fee > 0 && <Trophy className="h-3.5 w-3.5 text-gold-deep" />}
                {r.label}
              </td>
              <td className="px-3 py-2.5 text-sm text-muted-foreground tabular-nums text-right">{r.total}</td>
              <td className="px-3 py-2.5 text-sm text-muted-foreground tabular-nums text-right">{r.sentOut}</td>
              <td className="px-3 py-2.5 text-sm text-muted-foreground tabular-nums text-right">{r.interviews}</td>
              <td className="px-3 py-2.5 text-sm text-muted-foreground tabular-nums text-right">{r.offers}</td>
              <td className="px-3 py-2.5 text-sm font-semibold text-emerald-dark tabular-nums text-right">{r.placements}</td>
              <td className="px-3 py-2.5 text-sm font-semibold text-gold-deep tabular-nums text-right">
                {r.fee > 0 ? fmtMoney(r.fee) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecruiterTable({ rows, profileById }: { rows: SendOutMetric[]; profileById: Map<string, string> }) {
  const agg = useMemo(
    () => aggregate(rows, (r) => r.recruiter_id
      ? { key: r.recruiter_id, label: profileById.get(r.recruiter_id) || 'Unknown' }
      : { key: 'unassigned', label: 'Unassigned' }),
    [rows, profileById],
  );
  return <AggTable rows={agg} headerLabel="Recruiter" emptyText="No send-outs in this range." />;
}

function ClientTable({ rows }: { rows: SendOutMetric[] }) {
  const agg = useMemo(
    () => aggregate(rows, (r) => {
      const name = r.job?.company_name;
      const id = r.job?.company_id || (name ? `name:${name}` : null);
      if (!id || !name) return null;
      return { key: id, label: name };
    }),
    [rows],
  );
  return <AggTable rows={agg} headerLabel="Client" emptyText="No client-tagged send-outs in this range." />;
}

function MonthTable({ rows }: { rows: SendOutMetric[] }) {
  const agg = useMemo(
    () => aggregate(rows, (r) => {
      const d = parseISO(r.created_at);
      const key = format(d, 'yyyy-MM');
      return { key, label: format(d, 'MMMM yyyy') };
    }),
    [rows],
  );
  // Month list sorts by key descending (newest first) instead of by fee
  const sorted = [...agg].sort((a, b) => b.key.localeCompare(a.key));
  return <AggTable rows={sorted} headerLabel="Month" emptyText="No send-outs in this range." />;
}
