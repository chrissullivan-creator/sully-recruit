import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  X, ChevronDown, ChevronRight, CalendarIcon, RotateCcw, Save, Bookmark, Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ContactFilters {
  status: string;        // 'all' | new | reached_out | engaged
  role: string;          // 'all' | client_only | also_candidate
  owner: string;         // 'all' | mine | <profileId>
  company: string;
  title: string;
  sentiment: string;     // 'all' | <sentiment key>
  channel: string;       // 'all' | email | linkedin | sms | phone
  lastReachedFrom: Date | undefined;   // reached out on/after
  lastReachedTo: Date | undefined;     // reached out on/before
  lastRespondedFrom: Date | undefined; // responded on/after
  lastRespondedTo: Date | undefined;   // responded on/before
  dateAddedFrom: Date | undefined;
  dateAddedTo: Date | undefined;
}

export const DEFAULT_CONTACT_FILTERS: ContactFilters = {
  status: 'all',
  role: 'all',
  owner: 'all',
  company: '',
  title: '',
  sentiment: 'all',
  channel: 'all',
  lastReachedFrom: undefined,
  lastReachedTo: undefined,
  lastRespondedFrom: undefined,
  lastRespondedTo: undefined,
  dateAddedFrom: undefined,
  dateAddedTo: undefined,
};

export interface SavedContactSearch {
  id: string;
  name: string;
  filters: ContactFilters;
  searchQuery: string;
  created_at: string;
}

export const ROLE_LABELS: Record<string, string> = {
  all: 'All',
  client_only: 'Client only',
  also_candidate: 'Also a candidate',
};

export const SENTIMENT_OPTIONS: { value: string; label: string }[] = [
  { value: 'interested', label: 'Interested' },
  { value: 'positive', label: 'Positive' },
  { value: 'booked_meeting', label: 'Booked Meeting' },
  { value: 'maybe', label: 'Maybe' },
  { value: 'neutral', label: 'Neutral' },
  { value: 'ooo', label: 'Out of Office' },
  { value: 'negative', label: 'Negative' },
  { value: 'not_interested', label: 'Not Interested' },
  { value: 'do_not_contact', label: 'Do Not Contact' },
];

export const CHANNEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'email', label: 'Email' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'sms', label: 'SMS' },
  { value: 'phone', label: 'Phone' },
];

export function getActiveContactFilterCount(filters: ContactFilters): number {
  let count = 0;
  if (filters.status !== 'all') count++;
  if (filters.role !== 'all') count++;
  if (filters.owner !== 'all') count++;
  if (filters.company) count++;
  if (filters.title) count++;
  if (filters.sentiment !== 'all') count++;
  if (filters.channel !== 'all') count++;
  if (filters.lastReachedFrom) count++;
  if (filters.lastReachedTo) count++;
  if (filters.lastRespondedFrom) count++;
  if (filters.lastRespondedTo) count++;
  if (filters.dateAddedFrom) count++;
  if (filters.dateAddedTo) count++;
  return count;
}

export function getActiveContactFilterChips(
  filters: ContactFilters,
  statusLabels: Record<string, string>,
  profiles: any[],
): { key: string; label: string }[] {
  const chips: { key: string; label: string }[] = [];
  if (filters.status !== 'all') chips.push({ key: 'status', label: `Status: ${statusLabels[filters.status] ?? filters.status}` });
  if (filters.role !== 'all') chips.push({ key: 'role', label: `Role: ${ROLE_LABELS[filters.role] ?? filters.role}` });
  if (filters.owner !== 'all') {
    const ownerLabel = filters.owner === 'mine' ? 'Mine' : (profiles.find((p: any) => p.id === filters.owner)?.full_name ?? filters.owner);
    chips.push({ key: 'owner', label: `Owner: ${ownerLabel}` });
  }
  if (filters.company) chips.push({ key: 'company', label: `Company: ${filters.company}` });
  if (filters.title) chips.push({ key: 'title', label: `Title: ${filters.title}` });
  if (filters.sentiment !== 'all') {
    const s = SENTIMENT_OPTIONS.find((o) => o.value === filters.sentiment);
    chips.push({ key: 'sentiment', label: `Sentiment: ${s?.label ?? filters.sentiment}` });
  }
  if (filters.channel !== 'all') {
    const c = CHANNEL_OPTIONS.find((o) => o.value === filters.channel);
    chips.push({ key: 'channel', label: `Channel: ${c?.label ?? filters.channel}` });
  }
  if (filters.lastReachedFrom) chips.push({ key: 'lastReachedFrom', label: `Reached after: ${format(filters.lastReachedFrom, 'MMM d, yyyy')}` });
  if (filters.lastReachedTo) chips.push({ key: 'lastReachedTo', label: `Reached before: ${format(filters.lastReachedTo, 'MMM d, yyyy')}` });
  if (filters.lastRespondedFrom) chips.push({ key: 'lastRespondedFrom', label: `Responded after: ${format(filters.lastRespondedFrom, 'MMM d, yyyy')}` });
  if (filters.lastRespondedTo) chips.push({ key: 'lastRespondedTo', label: `Responded before: ${format(filters.lastRespondedTo, 'MMM d, yyyy')}` });
  if (filters.dateAddedFrom) chips.push({ key: 'dateAddedFrom', label: `Added after: ${format(filters.dateAddedFrom, 'MMM d, yyyy')}` });
  if (filters.dateAddedTo) chips.push({ key: 'dateAddedTo', label: `Added before: ${format(filters.dateAddedTo, 'MMM d, yyyy')}` });
  return chips;
}

export function clearContactFilterByKey(filters: ContactFilters, key: string): ContactFilters {
  const f = { ...filters };
  switch (key) {
    case 'status': f.status = 'all'; break;
    case 'role': f.role = 'all'; break;
    case 'owner': f.owner = 'all'; break;
    case 'company': f.company = ''; break;
    case 'title': f.title = ''; break;
    case 'sentiment': f.sentiment = 'all'; break;
    case 'channel': f.channel = 'all'; break;
    case 'lastReachedFrom': f.lastReachedFrom = undefined; break;
    case 'lastReachedTo': f.lastReachedTo = undefined; break;
    case 'lastRespondedFrom': f.lastRespondedFrom = undefined; break;
    case 'lastRespondedTo': f.lastRespondedTo = undefined; break;
    case 'dateAddedFrom': f.dateAddedFrom = undefined; break;
    case 'dateAddedTo': f.dateAddedTo = undefined; break;
  }
  return f;
}

// ── Sidebar component ────────────────────────────────────────────────────────

interface Props {
  filters: ContactFilters;
  onFiltersChange: (filters: ContactFilters) => void;
  onClose: () => void;
  statusOptions: { value: string; label: string }[];
  profiles: any[];
  savedSearches: SavedContactSearch[];
  onSaveSearch: (name: string) => void;
  onLoadSearch: (search: SavedContactSearch) => void;
  onDeleteSearch: (id: string) => void;
  searchQuery: string;
}

export function ContactFilterSidebar({
  filters,
  onFiltersChange,
  onClose,
  statusOptions,
  profiles,
  savedSearches,
  onSaveSearch,
  onLoadSearch,
  onDeleteSearch,
  searchQuery,
}: Props) {
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [savedOpen, setSavedOpen] = useState(true);

  const update = (partial: Partial<ContactFilters>) => {
    onFiltersChange({ ...filters, ...partial });
  };

  const activeCount = getActiveContactFilterCount(filters);

  const handleSave = () => {
    if (saveName.trim()) {
      onSaveSearch(saveName.trim());
      setSaveName('');
      setSaveDialogOpen(false);
    }
  };

  return (
    <div className="w-72 border-r border-border bg-background flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Filters</h3>
          {activeCount > 0 && (
            <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
              {activeCount}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {activeCount > 0 && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onFiltersChange(DEFAULT_CONTACT_FILTERS)}>
              <RotateCcw className="h-3 w-3 mr-1" />
              Reset
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-5">

          {/* ── Saved Searches ──────────────────────────────────────────── */}
          {savedSearches.length > 0 && (
            <Collapsible open={savedOpen} onOpenChange={setSavedOpen}>
              <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide w-full hover:text-foreground transition-colors">
                {savedOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <Bookmark className="h-3 w-3" />
                Saved Searches
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-1">
                {savedSearches.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between group rounded-md px-2 py-1.5 hover:bg-muted/50 cursor-pointer transition-colors"
                    onClick={() => onLoadSearch(s)}
                  >
                    <span className="text-xs text-foreground truncate">{s.name}</span>
                    <button
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                      onClick={(e) => { e.stopPropagation(); onDeleteSearch(s.id); }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* ── Status ─────────────────────────────────────────────────── */}
          <FilterSection title="Status">
            <Select value={filters.status} onValueChange={(v) => update({ status: v })}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                {statusOptions.map((s) => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterSection>

          {/* ── Role ───────────────────────────────────────────────────── */}
          <FilterSection title="Role">
            <Select value={filters.role} onValueChange={(v) => update({ role: v })}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="client_only">Client only</SelectItem>
                <SelectItem value="also_candidate">Also a candidate</SelectItem>
              </SelectContent>
            </Select>
          </FilterSection>

          {/* ── Owner ──────────────────────────────────────────────────── */}
          <FilterSection title="Owner">
            <Select value={filters.owner} onValueChange={(v) => update({ owner: v })}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="All Owners" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Owners</SelectItem>
                <SelectItem value="mine">My Contacts</SelectItem>
                {profiles.filter((p: any) => p.full_name).map((p: any) => (
                  <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterSection>

          {/* ── Company ────────────────────────────────────────────────── */}
          <FilterSection title="Company">
            <Input
              className="h-8 text-xs"
              placeholder="e.g. Millennium"
              value={filters.company}
              onChange={(e) => update({ company: e.target.value })}
            />
          </FilterSection>

          {/* ── Title ──────────────────────────────────────────────────── */}
          <FilterSection title="Title">
            <Input
              className="h-8 text-xs"
              placeholder="e.g. Portfolio Manager"
              value={filters.title}
              onChange={(e) => update({ title: e.target.value })}
            />
          </FilterSection>

          {/* ── Sentiment ──────────────────────────────────────────────── */}
          <FilterSection title="Last Sentiment">
            <Select value={filters.sentiment} onValueChange={(v) => update({ sentiment: v })}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Any" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any</SelectItem>
                {SENTIMENT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterSection>

          {/* ── Channel ────────────────────────────────────────────────── */}
          <FilterSection title="Last Channel">
            <Select value={filters.channel} onValueChange={(v) => update({ channel: v })}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Any" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any</SelectItem>
                {CHANNEL_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterSection>

          {/* ── Last Reached Out ───────────────────────────────────────── */}
          <FilterSection title="Last Reached Out">
            <div className="space-y-2">
              <DatePickerField
                label="On or after"
                date={filters.lastReachedFrom}
                onSelect={(d) => update({ lastReachedFrom: d })}
              />
              <DatePickerField
                label="On or before"
                date={filters.lastReachedTo}
                onSelect={(d) => update({ lastReachedTo: d })}
              />
            </div>
          </FilterSection>

          {/* ── Last Response ──────────────────────────────────────────── */}
          <FilterSection title="Last Response">
            <div className="space-y-2">
              <DatePickerField
                label="On or after"
                date={filters.lastRespondedFrom}
                onSelect={(d) => update({ lastRespondedFrom: d })}
              />
              <DatePickerField
                label="On or before"
                date={filters.lastRespondedTo}
                onSelect={(d) => update({ lastRespondedTo: d })}
              />
            </div>
          </FilterSection>

          {/* ── Date Added ─────────────────────────────────────────────── */}
          <FilterSection title="Date Added">
            <div className="space-y-2">
              <DatePickerField
                label="On or after"
                date={filters.dateAddedFrom}
                onSelect={(d) => update({ dateAddedFrom: d })}
              />
              <DatePickerField
                label="On or before"
                date={filters.dateAddedTo}
                onSelect={(d) => update({ dateAddedTo: d })}
              />
            </div>
          </FilterSection>
        </div>
      </ScrollArea>

      {/* ── Footer: Save search ─────────────────────────────────────────── */}
      <div className="p-4 border-t border-border">
        {saveDialogOpen ? (
          <div className="space-y-2">
            <Input
              className="h-8 text-xs"
              placeholder="Search name..."
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
              autoFocus
            />
            <div className="flex gap-2">
              <Button variant="gold" size="sm" className="flex-1 h-7 text-xs" onClick={handleSave} disabled={!saveName.trim()}>
                Save
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => { setSaveDialogOpen(false); setSaveName(''); }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="w-full h-8 text-xs"
            onClick={() => setSaveDialogOpen(true)}
            disabled={activeCount === 0 && !searchQuery}
          >
            <Save className="h-3 w-3 mr-1.5" />
            Save This Search
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Helper components ────────────────────────────────────────────────────────

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{title}</label>
      {children}
    </div>
  );
}

function DatePickerField({
  label,
  date,
  onSelect,
}: {
  label: string;
  date: Date | undefined;
  onSelect: (date: Date | undefined) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            'w-full h-8 justify-start text-left text-xs font-normal',
            !date && 'text-muted-foreground'
          )}
        >
          <CalendarIcon className="mr-2 h-3 w-3" />
          {date ? format(date, 'MMM d, yyyy') : label}
          {date && (
            <button
              className="ml-auto hover:text-destructive"
              onClick={(e) => { e.stopPropagation(); onSelect(undefined); }}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          onSelect={onSelect}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
}
