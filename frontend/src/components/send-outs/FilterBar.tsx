import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export interface SendOutsFilters {
  q: string;
  jobId: string;          // 'all' or job uuid
  recruiterId: string;    // 'all' or user uuid
  from: string;           // ISO date or ''
  to: string;             // ISO date or ''
}

export const EMPTY_FILTERS: SendOutsFilters = {
  q: '', jobId: 'all', recruiterId: 'all', from: '', to: '',
};

interface FilterBarProps {
  filters: SendOutsFilters;
  onChange: (next: SendOutsFilters) => void;
  jobs: { id: string; title: string | null; company_name: string | null }[];
  recruiters: { id: string; full_name: string | null }[];
}

export function FilterBar({ filters, onChange, jobs, recruiters }: FilterBarProps) {
  const update = (patch: Partial<SendOutsFilters>) => onChange({ ...filters, ...patch });
  const hasFilters =
    filters.q !== '' || filters.jobId !== 'all' || filters.recruiterId !== 'all' || filters.from !== '' || filters.to !== '';

  return (
    <div className="rounded-xl border border-card-border bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* Search */}
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={filters.q}
            onChange={(e) => update({ q: e.target.value })}
            placeholder="Search candidate, title, company..."
            className="pl-9 h-9 border-card-border"
          />
        </div>

        {/* Job */}
        <Select value={filters.jobId} onValueChange={(v) => update({ jobId: v })}>
          <SelectTrigger className="h-9 w-[200px] border-card-border">
            <SelectValue placeholder="All jobs" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All jobs</SelectItem>
            {jobs.map((j) => (
              <SelectItem key={j.id} value={j.id}>
                {j.title ?? '(untitled)'} {j.company_name ? `· ${j.company_name}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Recruiter */}
        <Select value={filters.recruiterId} onValueChange={(v) => update({ recruiterId: v })}>
          <SelectTrigger className="h-9 w-[180px] border-card-border">
            <SelectValue placeholder="All recruiters" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All recruiters</SelectItem>
            {recruiters.map((r) => (
              <SelectItem key={r.id} value={r.id}>{r.full_name ?? '(unknown)'}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Date range */}
        <Input
          type="date" value={filters.from}
          onChange={(e) => update({ from: e.target.value })}
          className="h-9 w-[150px] border-card-border"
        />
        <span className="text-xs text-muted-foreground">to</span>
        <Input
          type="date" value={filters.to}
          onChange={(e) => update({ to: e.target.value })}
          className="h-9 w-[150px] border-card-border"
        />

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(EMPTY_FILTERS)}
            className={cn('h-9 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground')}
          >
            <X className="h-3.5 w-3.5" /> Clear all
          </Button>
        )}
      </div>
    </div>
  );
}
