import { useMemo } from 'react';
import { SectionCard } from '@/components/shared/SectionCard';
import { HorizontalTableScroll } from '@/components/shared/HorizontalTableScroll';
import { canonicalConfig, stageToCanonical, daysSince } from '@/lib/pipeline';
import type { SendOutRow } from '@/lib/queries/send-outs';
import { cn } from '@/lib/utils';

/**
 * Flat table of EVERY loaded send-out row across all stages. Reuses the same
 * row fields shown in the stage tables (candidate, job, company, stage,
 * updated). No new data — `rows` is the already-loaded/filtered set.
 */
export function AllSendOutsTable({
  rows,
  onOpen,
}: {
  rows: SendOutRow[];
  onOpen: (row: SendOutRow) => void;
}) {
  // Sort newest-touched first (mirrors the query order).
  const sorted = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          new Date(b.updated_at ?? b.created_at).getTime() -
          new Date(a.updated_at ?? a.created_at).getTime(),
      ),
    [rows],
  );

  return (
    <SectionCard
      title="All Send Outs"
      actions={
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {rows.length} {rows.length === 1 ? 'row' : 'rows'}
        </span>
      }
      flush
    >
      {sorted.length === 0 ? (
        <div className="py-16 text-center">
          <p className="text-sm font-medium text-foreground">No send-outs match these filters.</p>
          <p className="mt-1 text-xs text-muted-foreground">Clear filters or start a new send-out.</p>
        </div>
      ) : (
        <HorizontalTableScroll minWidth={900}>
          <table className="w-full">
            <thead className="table-header-green">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Candidate</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Current Title</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Submitting For</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Company</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Stage</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sorted.map((row) => {
                const canonical = stageToCanonical(row.stage);
                const cfg = canonical ? canonicalConfig(canonical) : null;
                const days = daysSince(row.updated_at ?? row.created_at);
                return (
                  <tr
                    key={row.id}
                    onClick={() => onOpen(row)}
                    className="group cursor-pointer transition-colors hover:bg-muted/50"
                  >
                    <td className="px-4 py-3">
                      <span className="text-sm font-medium text-foreground">
                        {row.candidate?.full_name ?? '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {row.candidate?.current_title ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-foreground">
                      {row.job?.title ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {row.job?.company_name ?? row.candidate?.current_company ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      {cfg ? (
                        <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold', cfg.color)}>
                          <span className={cn('h-1.5 w-1.5 rounded-full', cfg.dotColor)} />
                          {cfg.label}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">{row.stage}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground tabular-nums">
                      {days === 0 ? 'Today' : `${days}d ago`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </HorizontalTableScroll>
      )}
    </SectionCard>
  );
}
