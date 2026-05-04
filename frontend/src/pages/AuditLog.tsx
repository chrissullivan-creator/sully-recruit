import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { format, formatDistanceToNow } from 'date-fns';
import { History, Search, ExternalLink, Plus, Pencil, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AuditRow {
  id: number;
  at: string;
  actor_id: string | null;
  actor_email: string | null;
  table_name: string;
  row_id: string;
  action: 'insert' | 'update' | 'delete';
  before: Record<string, any> | null;
  after: Record<string, any> | null;
  changed: Record<string, [any, any]> | null;
}

const TABLES = [
  { value: 'all', label: 'All tables' },
  { value: 'people', label: 'People' },
  { value: 'jobs', label: 'Jobs' },
  { value: 'send_outs', label: 'Send-outs' },
  { value: 'candidate_jobs', label: 'Pipelines' },
  { value: 'companies', label: 'Companies' },
  { value: 'placements', label: 'Placements' },
  { value: 'notes', label: 'Notes' },
  { value: 'sequence_enrollments', label: 'Sequences' },
];

function actionRoute(row: AuditRow): string | null {
  const data = row.after ?? row.before;
  if (!data) return null;
  switch (row.table_name) {
    case 'people':
      return data.type === 'client' ? `/contacts/${row.row_id}` : `/candidates/${row.row_id}`;
    case 'jobs':
      return `/jobs/${row.row_id}`;
    case 'companies':
      return `/companies/${row.row_id}`;
    case 'send_outs':
      return data.candidate_id ? `/candidates/${data.candidate_id}` : null;
    case 'candidate_jobs':
      return data.job_id ? `/jobs/${data.job_id}` : null;
    default:
      return null;
  }
}

function describe(row: AuditRow): string {
  const data = row.after ?? row.before ?? {};
  const name = data.full_name || data.title || data.name || data.id?.slice(0, 8);
  switch (row.table_name) {
    case 'people':       return `${data.type === 'client' ? 'contact' : 'candidate'} ${name}`;
    case 'jobs':         return `job ${name}`;
    case 'companies':    return `company ${name}`;
    case 'send_outs':    return `send-out → ${data.stage ?? '—'}`;
    case 'candidate_jobs': return `pipeline → ${data.pipeline_stage ?? '—'}`;
    case 'placements':   return `placement`;
    case 'notes':        return `note on ${data.entity_type ?? '?'}`;
    case 'sequence_enrollments': return `enrollment ${data.status ?? ''}`;
    default:             return row.table_name;
  }
}

function formatValue(v: any): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80);
  const s = String(v);
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

export default function AuditLog() {
  const navigate = useNavigate();
  const [tableFilter, setTableFilter] = useState('all');
  const [actionFilter, setActionFilter] = useState<'all' | 'insert' | 'update' | 'delete'>('all');
  const [search, setSearch] = useState('');

  const { data: rows = [], isLoading } = useQuery<AuditRow[]>({
    queryKey: ['audit_log', tableFilter, actionFilter],
    staleTime: 30_000,
    queryFn: async () => {
      let q = supabase
        .from('audit_log')
        .select('*')
        .order('at', { ascending: false })
        .limit(200);
      if (tableFilter !== 'all') q = q.eq('table_name', tableFilter);
      if (actionFilter !== 'all') q = q.eq('action', actionFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as AuditRow[];
    },
  });

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter((r) => {
      if (r.actor_email?.toLowerCase().includes(q)) return true;
      if (describe(r).toLowerCase().includes(q)) return true;
      if (r.changed && Object.keys(r.changed).some((k) => k.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [rows, search]);

  return (
    <MainLayout>
      <PageHeader
        title="Audit trail"
        description="Every change to the firm's records — who, when, what changed."
      />

      <div className="bg-page-bg min-h-[calc(100vh-4rem)] p-6 lg:p-8 space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by actor, field, or entity name…"
              className="pl-9"
            />
          </div>
          <Select value={tableFilter} onValueChange={setTableFilter}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>{TABLES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={actionFilter} onValueChange={(v) => setActionFilter(v as any)}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              <SelectItem value="insert">Insert</SelectItem>
              <SelectItem value="update">Update</SelectItem>
              <SelectItem value="delete">Delete</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="rounded-xl border border-card-border bg-white overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-sm text-muted-foreground text-center">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="p-12 text-sm text-muted-foreground text-center">
              No audit rows match these filters.
            </div>
          ) : (
            <div className="divide-y divide-card-border">
              {filtered.map((r) => {
                const Icon = r.action === 'insert' ? Plus : r.action === 'update' ? Pencil : Trash2;
                const tone =
                  r.action === 'insert' ? 'text-emerald' :
                  r.action === 'update' ? 'text-gold-deep' : 'text-red-600';
                const route = actionRoute(r);
                return (
                  <div key={r.id} className="px-5 py-3.5 flex items-start gap-4 hover:bg-page-bg/40 transition-colors">
                    <Icon className={cn('h-4 w-4 mt-1 shrink-0', tone)} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm">
                        <span className="font-medium text-emerald-dark">{r.actor_email || 'system'}</span>
                        {' '}{r.action === 'insert' ? 'created' : r.action === 'update' ? 'updated' : 'deleted'}{' '}
                        <span className="text-foreground">{describe(r)}</span>
                      </p>
                      {r.changed && Object.keys(r.changed).length > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {Object.entries(r.changed).slice(0, 6).map(([k, [b, a]]) => (
                            <li key={k} className="text-[11px] text-muted-foreground tabular-nums">
                              <span className="font-mono text-emerald-dark">{k}</span>
                              {' '}<span className="line-through opacity-60">{formatValue(b)}</span>
                              {' → '}
                              <span className="text-foreground">{formatValue(a)}</span>
                            </li>
                          ))}
                          {Object.keys(r.changed).length > 6 && (
                            <li className="text-[11px] text-muted-foreground italic">
                              + {Object.keys(r.changed).length - 6} more
                            </li>
                          )}
                        </ul>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline" className="text-[10px]">{r.table_name}</Badge>
                      <span className="text-[10px] text-muted-foreground tabular-nums whitespace-nowrap" title={format(new Date(r.at), 'PPP p')}>
                        {formatDistanceToNow(new Date(r.at), { addSuffix: true })}
                      </span>
                      {route && (
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => navigate(route)}>
                          <ExternalLink className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </MainLayout>
  );
}
