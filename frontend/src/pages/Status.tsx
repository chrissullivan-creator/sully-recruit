import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

interface CheckResult {
  name: string;
  ok: boolean;
  latency_ms: number | null;
  detail?: string;
}

interface StatusPayload {
  status: 'ok' | 'degraded';
  checked_at: string;
  checks: CheckResult[];
}

export default function Status() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      const json = (await r.json()) as StatusPayload;
      setData(json);
      setErr(null);
    } catch (e: any) {
      setErr(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="min-h-screen bg-page-bg flex items-start justify-center pt-20 px-6">
      <div className="w-full max-w-xl">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-display font-semibold text-emerald-dark">System status</h1>
            {data && (
              <p className="text-xs text-muted-foreground mt-1">
                Last checked {format(new Date(data.checked_at), 'h:mm:ss a')} · auto-refreshes every 30s
              </p>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-1.5">
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        {err ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
            Couldn't reach the status endpoint: {err}
          </div>
        ) : !data ? (
          <div className="rounded-xl border border-card-border bg-white p-12 text-center">
            <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className={cn(
              'rounded-xl border px-5 py-4 mb-4 flex items-center gap-3',
              data.status === 'ok'
                ? 'border-emerald/40 bg-emerald-light/30 text-emerald-dark'
                : 'border-red-300 bg-red-50 text-red-700',
            )}>
              {data.status === 'ok' ? (
                <CheckCircle2 className="h-5 w-5" />
              ) : (
                <XCircle className="h-5 w-5" />
              )}
              <p className="text-sm font-medium">
                {data.status === 'ok' ? 'All systems normal' : 'One or more services are degraded'}
              </p>
            </div>

            <div className="rounded-xl border border-card-border bg-white overflow-hidden divide-y divide-card-border">
              {data.checks.map((c) => (
                <div key={c.name} className="px-5 py-3 flex items-center gap-3">
                  {c.ok ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-600" />
                  )}
                  <p className="text-sm font-medium text-foreground flex-1">{c.name}</p>
                  {c.latency_ms !== null && (
                    <span className={cn(
                      'text-xs tabular-nums',
                      c.latency_ms > 2000 ? 'text-amber-700' : 'text-muted-foreground',
                    )}>
                      {c.latency_ms}ms
                    </span>
                  )}
                  {!c.ok && c.detail && (
                    <span className="text-[11px] text-red-600 truncate max-w-[160px]" title={c.detail}>
                      {c.detail}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
