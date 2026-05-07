import { useState, useCallback, useRef, useEffect } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { invalidatePersonScope } from '@/lib/invalidate';
import { toast } from 'sonner';
import {
  Upload, FileText, CheckCircle2, XCircle, Loader2, X, ArrowRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const ACCEPTED_EXTS = ['.pdf', '.doc', '.docx', '.txt'];
const MAX_BYTES = 20 * 1024 * 1024;
const RESUMES_BUCKET = 'resumes';
// How many uploads run in parallel. The queue itself is unbounded —
// you can drop hundreds of files and they'll all process. 8 is a good
// balance between throughput and not hammering Supabase Storage's
// connection pool.
const CONCURRENCY = 8;

type RowStatus =
  | 'pending'      // dropped, not yet uploaded
  | 'uploading'    // upload in progress
  | 'queued'       // uploaded; resumes row created with parsing_status=pending
  | 'parsing'      // ingestion task picked it up (parsing_status=processing)
  | 'completed'    // parsing_status=completed AND candidate_id set
  | 'parse_failed' // parsing_status=failed/rejected_not_a_resume/skipped
  | 'failed';      // upload itself failed (pre-DB)

interface UploadRow {
  id: string;
  file: File;
  status: RowStatus;
  storagePath?: string;
  candidateId?: string | null;
  error?: string;
}

const rowKey = () => `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export default function PeopleImport() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [running, setRunning] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const acceptFiles = (files: FileList | File[]) => {
    const next: UploadRow[] = [];
    for (const f of Array.from(files)) {
      const lower = f.name.toLowerCase();
      if (!ACCEPTED_EXTS.some((ext) => lower.endsWith(ext))) {
        toast.error(`${f.name}: only PDF / DOC / DOCX / TXT`);
        continue;
      }
      if (f.size > MAX_BYTES) {
        toast.error(`${f.name}: over 20 MB`);
        continue;
      }
      next.push({ id: rowKey(), file: f, status: 'pending' });
    }
    if (next.length === 0) return;
    setRows((prev) => [...prev, ...next]);
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) acceptFiles(e.dataTransfer.files);
  }, []);

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) acceptFiles(e.target.files);
    e.target.value = '';
  };

  const updateRow = (id: string, patch: Partial<UploadRow>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const removeRow = (id: string) =>
    setRows((prev) => prev.filter((r) => r.id !== id || r.status === 'queued'));

  const clearDone = () =>
    setRows((prev) => prev.filter((r) => r.status !== 'completed' && r.status !== 'queued'));

  // Poll the resumes table while any row is post-upload but pre-terminal.
  // The reconciler / resume-ingestion task writes parsing_status, so we
  // just look up our storage paths and translate that into UI status.
  useEffect(() => {
    const inFlightPaths = rows
      .filter((r) => (r.status === 'queued' || r.status === 'parsing') && r.storagePath)
      .map((r) => r.storagePath!) as string[];
    if (inFlightPaths.length === 0) return;

    let cancelled = false;
    const poll = async () => {
      const { data, error } = await supabase
        .from('resumes')
        .select('file_path, parsing_status, candidate_id, parse_error')
        .in('file_path', inFlightPaths);
      if (cancelled || error || !data) return;
      const byPath = new Map<string, { parsing_status: string; candidate_id: string | null; parse_error: string | null }>();
      for (const r of data as any[]) byPath.set(r.file_path, r);
      setRows((prev) =>
        prev.map((row) => {
          if (!row.storagePath) return row;
          if (row.status !== 'queued' && row.status !== 'parsing') return row;
          const hit = byPath.get(row.storagePath);
          if (!hit) return row;
          if (hit.parsing_status === 'completed') {
            return { ...row, status: 'completed', candidateId: hit.candidate_id };
          }
          if (hit.parsing_status === 'failed' || hit.parsing_status === 'rejected_not_a_resume' || hit.parsing_status === 'skipped') {
            return {
              ...row,
              status: 'parse_failed',
              error: hit.parse_error || hit.parsing_status,
            };
          }
          if (hit.parsing_status === 'processing' && row.status !== 'parsing') {
            return { ...row, status: 'parsing' };
          }
          return row;
        }),
      );
    };

    // First poll right away so the UI updates fast for already-parsed rows;
    // then on a 4s cadence — matches typical reconciler/parse latency.
    poll();
    const t = setInterval(poll, 4000);
    return () => { cancelled = true; clearInterval(t); };
  }, [rows]);

  const uploadOne = async (row: UploadRow, userId: string) => {
    updateRow(row.id, { status: 'uploading', error: undefined });
    try {
      const safeName = row.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `bulk_import/${userId}/${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${safeName}`;
      const buf = await row.file.arrayBuffer();
      const { error } = await supabase.storage
        .from(RESUMES_BUCKET)
        .upload(storagePath, buf, {
          contentType: row.file.type || 'application/octet-stream',
          upsert: false,
        });
      if (error) throw new Error(error.message);
      // After upload, the storage trigger creates the resumes row with
      // candidate_id=null and parsing_status='pending'. The reconciler
      // (Trigger.dev, every minute) parses, matches, and links — fully
      // automatic. Nothing left for the UI to do.
      updateRow(row.id, { status: 'queued', storagePath });
    } catch (err: any) {
      updateRow(row.id, { status: 'failed', error: err.message || 'unknown error' });
    }
  };

  const startAll = async () => {
    if (running) return;
    setRunning(true);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      toast.error('Not authenticated');
      setRunning(false);
      return;
    }

    // Snapshot the queue and process in fixed-size waves of N.
    const queue = rows.filter((r) => r.status === 'pending' || r.status === 'failed');
    let i = 0;
    while (i < queue.length) {
      const batch = queue.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map((r) => uploadOne(r, user.id)));
      i += CONCURRENCY;
    }

    invalidatePersonScope(queryClient);
    setRunning(false);

    const ok = rows.filter((r) => r.status === 'queued' || r.status === 'parsing' || r.status === 'completed').length;
    if (ok > 0) {
      toast.success(`${ok} resume${ok === 1 ? '' : 's'} uploaded — parsing in the background`);
    }
  };

  const total = rows.length;
  const completed = rows.filter((r) => r.status === 'completed').length;
  const queued = rows.filter((r) => r.status === 'queued' || r.status === 'parsing').length;
  const parseFailed = rows.filter((r) => r.status === 'parse_failed').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  const inFlight = rows.filter((r) => r.status === 'uploading').length;
  const pending = rows.filter((r) => r.status === 'pending').length;
  // Progress = upload-or-better. Completed counts double weight to feel
  // like real forward motion (queued doesn't, since parsing is async).
  const terminal = completed + failed + parseFailed;
  const progressPct = total === 0 ? 0 : Math.round(((terminal + queued * 0.5) / total) * 100);

  return (
    <MainLayout>
      <PageHeader
        title="Bulk Resume Import"
        description="Drop a folder of resumes — they upload to Storage, the parser auto-creates candidates, and any duplicates land in the Duplicates queue. No clicking through each one."
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate('/people')}>
            View people <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
          </Button>
        }
      />

      <div className="bg-page-bg min-h-[calc(100vh-4rem)] p-6 lg:p-8 space-y-5">
        <div
          onDrop={onDrop}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onClick={() => fileInputRef.current?.click()}
          className={cn(
            'rounded-xl border-2 border-dashed bg-white py-10 px-6 text-center cursor-pointer transition-colors',
            dragOver
              ? 'border-emerald bg-emerald-light/30 text-emerald-dark'
              : 'border-card-border hover:border-emerald/50',
          )}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_EXTS.join(',')}
            onChange={onPick}
            className="hidden"
          />
          <Upload className="h-8 w-8 mx-auto text-emerald mb-3" />
          <p className="text-sm font-display font-semibold text-emerald-dark">
            Drop resumes here, or click to choose
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            PDF / DOC / DOCX / TXT · 20 MB each · no cap on count — drop a whole folder
          </p>
        </div>

        <div className="rounded-lg border border-card-border bg-page-bg/40 p-3 text-xs text-muted-foreground">
          <p className="font-medium text-emerald-dark mb-1">How this works</p>
          <ol className="list-decimal pl-4 space-y-0.5">
            <li>Files upload to Supabase Storage (resumes bucket)</li>
            <li>A Postgres trigger registers each file as a pending resume</li>
            <li>The reconciler (runs every minute) parses with Claude, matches to existing people by email / LinkedIn / name+company</li>
            <li>If matched → updates the existing candidate with new resume info</li>
            <li>If not matched → creates a new candidate stub</li>
            <li>Any near-duplicates land in <span className="font-mono">/duplicates</span> for manual review</li>
          </ol>
        </div>

        {total > 0 && (
          <div className="rounded-lg border border-card-border bg-white p-4 space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3 text-sm">
                <span className="text-muted-foreground">Total: <strong className="text-foreground tabular-nums">{total}</strong></span>
                {completed > 0 && (
                  <span className="text-emerald">Completed: <strong className="tabular-nums">{completed}</strong></span>
                )}
                {queued > 0 && (
                  <span className="text-amber-700">Parsing: <strong className="tabular-nums">{queued}</strong></span>
                )}
                {inFlight > 0 && (
                  <span className="text-amber-700">Uploading: <strong className="tabular-nums">{inFlight}</strong></span>
                )}
                {failed > 0 && (
                  <span className="text-red-600">Upload failed: <strong className="tabular-nums">{failed}</strong></span>
                )}
                {parseFailed > 0 && (
                  <span className="text-red-600">Parse failed: <strong className="tabular-nums">{parseFailed}</strong></span>
                )}
                {pending > 0 && !running && (
                  <span className="text-muted-foreground">Pending: <strong className="tabular-nums">{pending}</strong></span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {(completed > 0 || queued > 0) && (
                  <Button variant="outline" size="sm" onClick={clearDone}>Clear completed</Button>
                )}
                <Button
                  variant="gold"
                  size="sm"
                  disabled={running || (pending === 0 && failed === 0)}
                  onClick={startAll}
                  className="gap-1.5"
                >
                  {running
                    ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Uploading…</>
                    : <><Upload className="h-3.5 w-3.5" /> Start{failed > 0 ? ' / Retry failed' : ''}</>}
                </Button>
              </div>
            </div>
            <Progress value={progressPct} />
          </div>
        )}

        {total > 0 && (
          <div className="rounded-lg border border-card-border bg-white overflow-hidden">
            <table className="w-full">
              <thead className="border-b border-card-border bg-page-bg/40">
                <tr className="text-left text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2.5">File</th>
                  <th className="px-3 py-2.5">Size</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-card-border">
                {rows.map((r) => (
                  <tr key={r.id} className="text-sm hover:bg-page-bg/40">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="truncate" title={r.file.name}>{r.file.name}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                      {(r.file.size / 1024 / 1024).toFixed(2)} MB
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={r.status} error={r.error} />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {(r.status === 'pending' || r.status === 'failed') && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => removeRow(r.id)}
                          title="Remove from queue"
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </MainLayout>
  );
}

function StatusBadge({ status, error }: { status: RowStatus; error?: string }) {
  if (status === 'pending') return <Badge variant="outline" className="text-xs">Pending</Badge>;
  if (status === 'uploading') {
    return <Badge className="bg-amber-50 text-amber-800 border-amber-200 gap-1 text-xs"><Loader2 className="h-3 w-3 animate-spin" /> Uploading</Badge>;
  }
  if (status === 'queued') {
    return <Badge className="bg-amber-50 text-amber-800 border-amber-200 gap-1 text-xs"><Loader2 className="h-3 w-3 animate-spin" /> Queued</Badge>;
  }
  if (status === 'parsing') {
    return <Badge className="bg-amber-50 text-amber-800 border-amber-200 gap-1 text-xs"><Loader2 className="h-3 w-3 animate-spin" /> Parsing</Badge>;
  }
  if (status === 'completed') {
    return <Badge className="bg-emerald-light text-emerald-dark border-emerald/30 gap-1 text-xs"><CheckCircle2 className="h-3 w-3" /> Completed</Badge>;
  }
  if (status === 'parse_failed') {
    return <Badge className="bg-red-50 text-red-700 border-red-200 gap-1 text-xs" title={error}><XCircle className="h-3 w-3" /> Parse failed</Badge>;
  }
  return <Badge className="bg-red-50 text-red-700 border-red-200 gap-1 text-xs" title={error}><XCircle className="h-3 w-3" /> Failed</Badge>;
}
