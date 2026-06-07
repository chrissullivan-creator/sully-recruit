import { useState, useCallback, useRef, useMemo } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { invalidatePersonScope, invalidateJobScope } from '@/lib/invalidate';
import { authHeaders } from '@/lib/api-auth';
import { toast } from 'sonner';
import {
  Upload, FileText, CheckCircle2, XCircle, Loader2, ArrowRight,
  Users2, Briefcase, Wand2, Building2, RotateCcw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  parseCsvToObjects, autoMapPeople, autoMapJobs, applyMapping,
  PEOPLE_FIELDS, JOB_FIELDS,
} from '@/lib/csv';

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_ROWS = 1000;
const PREVIEW_ROWS = 5;

type Entity = 'candidate' | 'client' | 'job';
type Step = 'choose' | 'map' | 'importing' | 'done';

const ENTITY_META: Record<Entity, { label: string; icon: typeof Users2; hint: string }> = {
  candidate: { label: 'Candidates', icon: Users2, hint: 'People you place — current title, company, location, phone' },
  client: { label: 'Clients', icon: Building2, hint: 'Hiring contacts — title, company, location, work email' },
  job: { label: 'Jobs', icon: Briefcase, hint: 'Open roles — created as leads, deduped by URL' },
};

interface PeopleResult {
  created: string[];
  merged: string[];
  failed: { index: number; error: string }[];
  peopleIds: string[];
}
interface JobResult {
  created: string[];
  duplicates: string[];
  failed: { index: number; error: string }[];
}

export default function CsvImport() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [entity, setEntity] = useState<Entity>('candidate');
  const [step, setStep] = useState<Step>('choose');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});

  const [progressPct, setProgressPct] = useState(0);
  const [peopleResult, setPeopleResult] = useState<PeopleResult | null>(null);
  const [jobResult, setJobResult] = useState<JobResult | null>(null);

  // Enrichment (people only, after import) — reuses the EnrichButton polling
  // mechanism against /api/enrichment-jobs/{id}.
  const [enriching, setEnriching] = useState(false);
  const [enriched, setEnriched] = useState(false);

  const isPeople = entity === 'candidate' || entity === 'client';
  const fieldDefs = isPeople ? PEOPLE_FIELDS : JOB_FIELDS;

  const resetFile = () => {
    setFileName('');
    setHeaders([]);
    setRows([]);
    setMapping({});
    setPeopleResult(null);
    setJobResult(null);
    setProgressPct(0);
    setEnriching(false);
    setEnriched(false);
    setStep('choose');
  };

  const acceptFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv') && file.type !== 'text/csv') {
      toast.error('Please choose a .csv file');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error('File is over 15 MB');
      return;
    }
    try {
      const text = await file.text();
      const { headers: hdrs, rows: parsed } = parseCsvToObjects(text);
      if (hdrs.length === 0 || parsed.length === 0) {
        toast.error('No rows found in that CSV');
        return;
      }
      setFileName(file.name);
      setHeaders(hdrs);
      setRows(parsed);
      setMapping(isPeople ? autoMapPeople(hdrs) : autoMapJobs(hdrs));
      setStep('map');
    } catch (e: any) {
      toast.error(e?.message || 'Failed to read file');
    }
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) acceptFile(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity]);

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) acceptFile(f);
    e.target.value = '';
  };

  // Mapped preview rows (first N), keyed by canonical field.
  const previewRows = useMemo(() => {
    return applyMapping(rows.slice(0, PREVIEW_ROWS), mapping as any);
  }, [rows, mapping]);

  // Which canonical fields are actually mapped (for the preview columns).
  const mappedFields = useMemo(
    () => fieldDefs.filter((f) => mapping[f.key]),
    [fieldDefs, mapping],
  );

  // Validation: people need a name source; jobs need a title.
  const mappingValid = useMemo(() => {
    if (isPeople) {
      return !!(mapping.first_name || mapping.last_name || mapping.full_name);
    }
    return !!mapping.title;
  }, [isPeople, mapping]);

  const tooManyRows = rows.length > MAX_ROWS;

  const runImport = async () => {
    if (!mappingValid || tooManyRows) return;
    setStep('importing');
    setProgressPct(8);

    try {
      const mapped = applyMapping(rows, mapping as any);
      const headersAuth = await authHeaders();
      setProgressPct(35);

      if (isPeople) {
        const res = await fetch('/api/import-people', {
          method: 'POST',
          headers: headersAuth,
          body: JSON.stringify({ type: entity, rows: mapped }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Import failed');
        setProgressPct(100);
        setPeopleResult(data as PeopleResult);
        invalidatePersonScope(queryClient);
        const { created, merged, failed } = data as PeopleResult;
        toast.success(`Imported ${created.length} new, ${merged.length} merged${failed.length ? `, ${failed.length} failed` : ''}`);
      } else {
        const res = await fetch('/api/import-jobs', {
          method: 'POST',
          headers: headersAuth,
          body: JSON.stringify({ rows: mapped }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Import failed');
        setProgressPct(100);
        setJobResult(data as JobResult);
        invalidateJobScope(queryClient);
        const { created, duplicates, failed } = data as JobResult;
        toast.success(`Imported ${created.length} new${duplicates.length ? `, ${duplicates.length} duplicate` : ''}${failed.length ? `, ${failed.length} failed` : ''}`);
      }
      setStep('done');
    } catch (e: any) {
      toast.error(e?.message || 'Import failed');
      setStep('map');
      setProgressPct(0);
    }
  };

  // Poll an enrichment job exactly like EnrichButton does — sticky toast that
  // updates on progress, terminal on completed/failed.
  const pollEnrichJob = async (jobId: string, total: number) => {
    const toastId = toast.loading(`Queued ${total} people for enrichment — starting…`);
    let backoff = 2000;
    let lastProcessed = -1;
    for (let i = 0; i < 900; i++) {
      await new Promise((r) => setTimeout(r, backoff));
      try {
        const res = await fetch(`/api/enrichment-jobs/${jobId}`, { headers: await authHeaders() });
        if (!res.ok) continue;
        const job = await res.json();
        if (job.processed !== lastProcessed) {
          lastProcessed = job.processed;
          backoff = 2000;
          toast.loading(`${job.processed}/${job.total} processed — ${job.changed} updated, ${job.failed} failed`, { id: toastId });
        } else {
          backoff = Math.min(backoff * 1.25, 6000);
        }
        if (job.status === 'completed') {
          toast.success(`Enrichment done: ${job.changed} updated, ${job.failed} failed`, { id: toastId });
          invalidatePersonScope(queryClient);
          setEnriching(false);
          setEnriched(true);
          return;
        }
        if (job.status === 'failed') {
          toast.error(`Enrichment job failed: ${job.error || 'unknown'}`, { id: toastId });
          setEnriching(false);
          return;
        }
      } catch {
        // network blip — keep polling
      }
    }
    toast.error('Enrichment is taking unusually long — check the enrichment_jobs table.', { id: toastId });
    setEnriching(false);
  };

  const runEnrichment = async () => {
    if (!peopleResult || peopleResult.peopleIds.length === 0) return;
    setEnriching(true);
    try {
      const res = await fetch('/api/people/enrich', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ peopleIds: peopleResult.peopleIds, fields: ['work_email'] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Enrich failed');

      // Async path (> 5 people): poll the job. The import almost always
      // produces > 5, so this is the common case.
      if (data.queued && data.jobId) {
        toast.info(`Queued ${data.total} people — running in background`);
        pollEnrichJob(data.jobId, data.total);
        return;
      }

      // Sync path (≤ 5 people): results are already done.
      const counts = data.counts || {};
      toast.success(`Enriched: ${counts.changed ?? 0} updated, ${counts.failed ?? 0} failed`);
      invalidatePersonScope(queryClient);
      setEnriching(false);
      setEnriched(true);
    } catch (e: any) {
      toast.error(e?.message || 'Enrich failed');
      setEnriching(false);
    }
  };

  const EntityIcon = ENTITY_META[entity].icon;

  return (
    <MainLayout>
      <PageHeader
        title="CSV Import"
        description="Bulk-import candidates, clients, or jobs from a spreadsheet. Columns auto-map; correct any mismatches, preview, then import — with an optional enrichment pass after."
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate(isPeople ? '/people' : '/jobs')}>
            View {isPeople ? 'people' : 'jobs'} <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
          </Button>
        }
      />

      <div className="bg-page-bg min-h-[calc(100vh-4rem)] p-6 lg:p-8 space-y-5 max-w-5xl">
        {/* ── Step 1: entity + file ─────────────────────────────── */}
        <div className="rounded-lg border border-card-border bg-white p-4 space-y-3">
          <p className="text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground">
            1 · What are you importing?
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {(Object.keys(ENTITY_META) as Entity[]).map((e) => {
              const meta = ENTITY_META[e];
              const Icon = meta.icon;
              const active = entity === e;
              return (
                <button
                  key={e}
                  type="button"
                  disabled={step === 'importing'}
                  onClick={() => {
                    if (e === entity) return;
                    setEntity(e);
                    // Re-map existing headers for the new entity, or reset.
                    if (headers.length > 0) {
                      const peopleNow = e === 'candidate' || e === 'client';
                      setMapping(peopleNow ? autoMapPeople(headers) : autoMapJobs(headers));
                      setPeopleResult(null);
                      setJobResult(null);
                      setEnriched(false);
                      setStep('map');
                    }
                  }}
                  className={cn(
                    'text-left rounded-lg border-2 p-3 transition-colors disabled:opacity-50',
                    active
                      ? 'border-emerald bg-emerald-light/30'
                      : 'border-card-border hover:border-emerald/50 bg-white',
                  )}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Icon className={cn('h-4 w-4', active ? 'text-emerald-dark' : 'text-muted-foreground')} />
                    <span className={cn('text-sm font-display font-semibold', active ? 'text-emerald-dark' : 'text-foreground')}>
                      {meta.label}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight">{meta.hint}</p>
                </button>
              );
            })}
          </div>

          <div
            onDrop={onDrop}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              'rounded-xl border-2 border-dashed bg-white py-8 px-6 text-center cursor-pointer transition-colors',
              dragOver
                ? 'border-emerald bg-emerald-light/30 text-emerald-dark'
                : 'border-card-border hover:border-emerald/50',
            )}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={onPick}
              className="hidden"
            />
            <Upload className="h-7 w-7 mx-auto text-emerald mb-2" />
            <p className="text-sm font-display font-semibold text-emerald-dark">
              {fileName ? `Selected: ${fileName}` : 'Drop a .csv here, or click to choose'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              CSV · up to 15 MB · {MAX_ROWS} rows per import · quoted fields & commas supported
            </p>
          </div>
        </div>

        {/* ── Step 2: column mapping + preview ───────────────────── */}
        {headers.length > 0 && step !== 'importing' && (
          <div className="rounded-lg border border-card-border bg-white p-4 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground">
                2 · Map columns
                <span className="ml-2 normal-case font-normal text-muted-foreground">
                  <EntityIcon className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
                  {rows.length} row{rows.length === 1 ? '' : 's'} detected
                </span>
              </p>
              <Button variant="ghost" size="sm" onClick={resetFile} className="gap-1.5">
                <RotateCcw className="h-3.5 w-3.5" /> Start over
              </Button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
              {fieldDefs.map((f) => (
                <div key={f.key} className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-foreground">{f.label}</span>
                  <Select
                    value={mapping[f.key] || '__none__'}
                    onValueChange={(v) =>
                      setMapping((m) => ({ ...m, [f.key]: v === '__none__' ? '' : v }))
                    }
                  >
                    <SelectTrigger className="h-8 w-44 text-xs">
                      <SelectValue placeholder="— skip —" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__" className="text-xs text-muted-foreground">— skip —</SelectItem>
                      {headers.map((h) => (
                        <SelectItem key={h} value={h} className="text-xs">{h}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            {!mappingValid && (
              <p className="text-xs text-red-600">
                {isPeople
                  ? 'Map at least a First/Last name or a Full name column.'
                  : 'Map a Title column — it is required for jobs.'}
              </p>
            )}
            {tooManyRows && (
              <p className="text-xs text-red-600">
                This file has {rows.length} rows; the import cap is {MAX_ROWS}. Split it into smaller files.
              </p>
            )}

            {/* Preview */}
            {mappedFields.length > 0 && (
              <div className="rounded-lg border border-card-border overflow-x-auto">
                <table className="w-full">
                  <thead className="border-b border-card-border bg-page-bg/40">
                    <tr className="text-left text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground">
                      {mappedFields.map((f) => (
                        <th key={f.key} className="px-3 py-2 whitespace-nowrap">{f.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-card-border">
                    {previewRows.map((row, i) => (
                      <tr key={i} className="text-xs">
                        {mappedFields.map((f) => (
                          <td key={f.key} className="px-3 py-2 max-w-[200px] truncate" title={(row as any)[f.key]}>
                            {(row as any)[f.key] || <span className="text-muted-foreground/50">—</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length > PREVIEW_ROWS && (
                  <p className="px-3 py-2 text-[11px] text-muted-foreground bg-page-bg/40 border-t border-card-border">
                    Showing first {PREVIEW_ROWS} of {rows.length} rows.
                  </p>
                )}
              </div>
            )}

            <div className="flex justify-end">
              <Button
                variant="gold"
                size="sm"
                disabled={!mappingValid || tooManyRows}
                onClick={runImport}
                className="gap-1.5"
              >
                <Upload className="h-3.5 w-3.5" />
                Import {rows.length} {ENTITY_META[entity].label.toLowerCase()}
              </Button>
            </div>
          </div>
        )}

        {/* ── Step: importing progress ──────────────────────────── */}
        {step === 'importing' && (
          <div className="rounded-lg border border-card-border bg-white p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm text-amber-700">
              <Loader2 className="h-4 w-4 animate-spin" />
              Importing {rows.length} {ENTITY_META[entity].label.toLowerCase()}…
            </div>
            <Progress value={progressPct} />
          </div>
        )}

        {/* ── Step 3: result summary ────────────────────────────── */}
        {step === 'done' && (
          <ResultSummary
            isPeople={isPeople}
            peopleResult={peopleResult}
            jobResult={jobResult}
            rows={rows}
            mapping={mapping}
            entityLabel={ENTITY_META[entity].label}
            enriching={enriching}
            enriched={enriched}
            onEnrich={runEnrichment}
            onReset={resetFile}
            onView={() => navigate(isPeople ? '/people' : '/jobs')}
          />
        )}
      </div>
    </MainLayout>
  );
}

function ResultSummary({
  isPeople, peopleResult, jobResult, rows, mapping, entityLabel,
  enriching, enriched, onEnrich, onReset, onView,
}: {
  isPeople: boolean;
  peopleResult: PeopleResult | null;
  jobResult: JobResult | null;
  rows: Record<string, string>[];
  mapping: Record<string, string>;
  entityLabel: string;
  enriching: boolean;
  enriched: boolean;
  onEnrich: () => void;
  onReset: () => void;
  onView: () => void;
}) {
  const created = isPeople ? peopleResult?.created.length ?? 0 : jobResult?.created.length ?? 0;
  const second = isPeople ? peopleResult?.merged.length ?? 0 : jobResult?.duplicates.length ?? 0;
  const secondLabel = isPeople ? 'merged' : 'duplicates';
  const failed = (isPeople ? peopleResult?.failed : jobResult?.failed) ?? [];
  const peopleIds = peopleResult?.peopleIds ?? [];

  // Build a label for a failed row from whatever name/title column was mapped,
  // so the failures list is human-readable.
  const rowLabel = (index: number): string => {
    const r = rows[index];
    if (!r) return `Row ${index + 1}`;
    const pick = (k: string) => (mapping[k] ? r[mapping[k]] : '');
    if (isPeople) {
      const name = [pick('first_name'), pick('last_name')].filter(Boolean).join(' ')
        || pick('full_name') || pick('email') || pick('work_email');
      return name || `Row ${index + 1}`;
    }
    return pick('title') || `Row ${index + 1}`;
  };

  const downloadFailures = () => {
    const lines = ['row,label,error'];
    for (const f of failed) {
      const label = rowLabel(f.index).replace(/"/g, '""');
      const err = f.error.replace(/"/g, '""');
      lines.push(`${f.index + 1},"${label}","${err}"`);
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'import-failures.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-lg border border-card-border bg-white p-4 space-y-4">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-5 w-5 text-emerald" />
        <p className="text-sm font-display font-semibold text-emerald-dark">Import complete</p>
      </div>

      <div className="flex items-center gap-4 text-sm flex-wrap">
        <span className="text-emerald">Created: <strong className="tabular-nums">{created}</strong></span>
        <span className="text-amber-700">{secondLabel}: <strong className="tabular-nums">{second}</strong></span>
        {failed.length > 0 && (
          <span className="text-red-600">Failed: <strong className="tabular-nums">{failed.length}</strong></span>
        )}
      </div>

      {/* People-only: run enrichment on everything we touched. */}
      {isPeople && peopleIds.length > 0 && (
        <div className="rounded-lg border border-card-border bg-page-bg/40 p-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="text-xs text-muted-foreground">
            <p className="font-medium text-emerald-dark mb-0.5">Run enrichment (Apollo → FullEnrich)</p>
            Find work emails for the {peopleIds.length} {entityLabel.toLowerCase()} you just imported.
          </div>
          <Button
            variant="gold"
            size="sm"
            onClick={onEnrich}
            disabled={enriching || enriched}
            className="gap-1.5 shrink-0"
          >
            {enriching
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Enriching…</>
              : enriched
                ? <><CheckCircle2 className="h-3.5 w-3.5" /> Enrichment started</>
                : <><Wand2 className="h-3.5 w-3.5" /> Run enrichment on {peopleIds.length}</>}
          </Button>
        </div>
      )}

      {/* Failures list (+ download). */}
      {failed.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50/50 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-red-200 bg-red-50">
            <span className="text-xs font-medium text-red-700 flex items-center gap-1.5">
              <XCircle className="h-3.5 w-3.5" /> {failed.length} row{failed.length === 1 ? '' : 's'} failed
            </span>
            <Button variant="ghost" size="sm" className="h-7 text-xs text-red-700 hover:text-red-800" onClick={downloadFailures}>
              Download CSV
            </Button>
          </div>
          <div className="max-h-48 overflow-y-auto divide-y divide-red-100">
            {failed.slice(0, 100).map((f) => (
              <div key={f.index} className="px-3 py-1.5 text-xs flex items-start gap-2">
                <span className="text-muted-foreground tabular-nums shrink-0">#{f.index + 1}</span>
                <span className="font-medium shrink-0 max-w-[140px] truncate" title={rowLabel(f.index)}>{rowLabel(f.index)}</span>
                <span className="text-red-600 break-words">{f.error}</span>
              </div>
            ))}
            {failed.length > 100 && (
              <p className="px-3 py-1.5 text-[11px] text-muted-foreground">Showing first 100 — download for the full list.</p>
            )}
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onReset} className="gap-1.5">
          <FileText className="h-3.5 w-3.5" /> Import another file
        </Button>
        <Button variant="gold" size="sm" onClick={onView} className="gap-1.5">
          View {isPeople ? 'people' : 'jobs'} <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
