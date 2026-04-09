import { useState, useRef, useCallback } from 'react';
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
  X, ChevronDown, ChevronRight, CalendarIcon, RotateCcw, Save, Bookmark, Trash2, MapPin, Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { geocodeLocation } from '@/lib/geocoding';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CandidateFilters {
  status: string;
  jobTag: string;
  owner: string;
  location: string;
  locationRadius: number; // miles, 0 = text-match only
  locationLat: number | null;
  locationLng: number | null;
  title: string;
  company: string;
  skills: string[];
  minExperience: string;
  maxExperience: string;
  workAuthorization: string;
  dateAddedFrom: Date | undefined;
  dateAddedTo: Date | undefined;
  lastActivityFrom: Date | undefined;
}

export const DEFAULT_FILTERS: CandidateFilters = {
  status: 'all',
  jobTag: 'all',
  owner: 'all',
  location: '',
  locationRadius: 0,
  locationLat: null,
  locationLng: null,
  title: '',
  company: '',
  skills: [],
  minExperience: '',
  maxExperience: '',
  workAuthorization: 'all',
  dateAddedFrom: undefined,
  dateAddedTo: undefined,
  lastActivityFrom: undefined,
};

export interface SavedSearch {
  id: string;
  name: string;
  filters: CandidateFilters;
  searchQuery: string;
  created_at: string;
}

export function getActiveFilterCount(filters: CandidateFilters): number {
  let count = 0;
  if (filters.status !== 'all') count++;
  if (filters.jobTag !== 'all') count++;
  if (filters.owner !== 'all') count++;
  if (filters.location) count++;
  if (filters.title) count++;
  if (filters.company) count++;
  if (filters.skills.length > 0) count++;
  if (filters.minExperience || filters.maxExperience) count++;
  if (filters.workAuthorization !== 'all') count++;
  if (filters.dateAddedFrom) count++;
  if (filters.dateAddedTo) count++;
  if (filters.lastActivityFrom) count++;
  return count;
}

export function getActiveFilterChips(filters: CandidateFilters, statusLabels: Record<string, string>, jobs: any[], profiles: any[]): { key: string; label: string }[] {
  const chips: { key: string; label: string }[] = [];
  if (filters.status !== 'all') chips.push({ key: 'status', label: `Status: ${statusLabels[filters.status] ?? filters.status}` });
  if (filters.jobTag !== 'all') {
    const job = jobs.find((j: any) => j.id === filters.jobTag);
    chips.push({ key: 'jobTag', label: `Job: ${job?.title ?? filters.jobTag}` });
  }
  if (filters.owner !== 'all') {
    const ownerLabel = filters.owner === 'mine' ? 'Mine' : (profiles.find((p: any) => p.id === filters.owner)?.full_name ?? filters.owner);
    chips.push({ key: 'owner', label: `Owner: ${ownerLabel}` });
  }
  if (filters.location) {
    const radiusLabel = filters.locationRadius > 0 ? ` (${filters.locationRadius}mi)` : '';
    chips.push({ key: 'location', label: `Location: ${filters.location}${radiusLabel}` });
  }
  if (filters.title) chips.push({ key: 'title', label: `Title: ${filters.title}` });
  if (filters.company) chips.push({ key: 'company', label: `Company: ${filters.company}` });
  if (filters.skills.length > 0) chips.push({ key: 'skills', label: `Skills: ${filters.skills.join(', ')}` });
  if (filters.minExperience || filters.maxExperience) {
    const range = [filters.minExperience || '0', filters.maxExperience || '∞'].join('–');
    chips.push({ key: 'experience', label: `Experience: ${range} yrs` });
  }
  if (filters.workAuthorization !== 'all') chips.push({ key: 'workAuthorization', label: `Visa: ${filters.workAuthorization}` });
  if (filters.dateAddedFrom) chips.push({ key: 'dateAddedFrom', label: `Added after: ${format(filters.dateAddedFrom, 'MMM d, yyyy')}` });
  if (filters.dateAddedTo) chips.push({ key: 'dateAddedTo', label: `Added before: ${format(filters.dateAddedTo, 'MMM d, yyyy')}` });
  if (filters.lastActivityFrom) chips.push({ key: 'lastActivityFrom', label: `Active since: ${format(filters.lastActivityFrom, 'MMM d, yyyy')}` });
  return chips;
}

export function clearFilterByKey(filters: CandidateFilters, key: string): CandidateFilters {
  const f = { ...filters };
  switch (key) {
    case 'status': f.status = 'all'; break;
    case 'jobTag': f.jobTag = 'all'; break;
    case 'owner': f.owner = 'all'; break;
    case 'location': f.location = ''; f.locationRadius = 0; f.locationLat = null; f.locationLng = null; break;
    case 'title': f.title = ''; break;
    case 'company': f.company = ''; break;
    case 'skills': f.skills = []; break;
    case 'experience': f.minExperience = ''; f.maxExperience = ''; break;
    case 'workAuthorization': f.workAuthorization = 'all'; break;
    case 'dateAddedFrom': f.dateAddedFrom = undefined; break;
    case 'dateAddedTo': f.dateAddedTo = undefined; break;
    case 'lastActivityFrom': f.lastActivityFrom = undefined; break;
  }
  return f;
}

// ── Sidebar component ────────────────────────────────────────────────────────

interface Props {
  filters: CandidateFilters;
  onFiltersChange: (filters: CandidateFilters) => void;
  onClose: () => void;
  // Data for select options
  statusOptions: { value: string; label: string }[];
  jobs: any[];
  profiles: any[];
  availableSkills: string[];
  availableLocations: string[];
  // Saved searches
  savedSearches: SavedSearch[];
  onSaveSearch: (name: string) => void;
  onLoadSearch: (search: SavedSearch) => void;
  onDeleteSearch: (id: string) => void;
  searchQuery: string;
}

const WORK_AUTH_OPTIONS = [
  'US Citizen',
  'Green Card',
  'H1-B',
  'L1',
  'O1',
  'TN',
  'EAD/OPT',
  'Sponsorship Required',
];

export function CandidateFilterSidebar({
  filters,
  onFiltersChange,
  onClose,
  statusOptions,
  jobs,
  profiles,
  availableSkills,
  availableLocations,
  savedSearches,
  onSaveSearch,
  onLoadSearch,
  onDeleteSearch,
  searchQuery,
}: Props) {
  const [skillInput, setSkillInput] = useState('');
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [savedOpen, setSavedOpen] = useState(true);
  const [geocoding, setGeocoding] = useState(false);
  const geocodeTimer = useRef<ReturnType<typeof setTimeout>>();

  const handleGeocode = useCallback(async () => {
    if (!filters.location || geocoding) return;
    setGeocoding(true);
    try {
      const result = await geocodeLocation(filters.location);
      if (result) {
        onFiltersChange({ ...filters, locationLat: result.lat, locationLng: result.lng });
      }
    } finally {
      setGeocoding(false);
    }
  }, [filters, geocoding, onFiltersChange]);

  const debouncedGeocode = useCallback(() => {
    clearTimeout(geocodeTimer.current);
    geocodeTimer.current = setTimeout(() => {
      handleGeocode();
    }, 600);
  }, [handleGeocode]);

  const update = (partial: Partial<CandidateFilters>) => {
    onFiltersChange({ ...filters, ...partial });
  };

  const activeCount = getActiveFilterCount(filters);

  const addSkill = (skill: string) => {
    const trimmed = skill.trim().toLowerCase();
    if (trimmed && !filters.skills.includes(trimmed)) {
      update({ skills: [...filters.skills, trimmed] });
    }
    setSkillInput('');
  };

  const removeSkill = (skill: string) => {
    update({ skills: filters.skills.filter((s) => s !== skill) });
  };

  const handleSave = () => {
    if (saveName.trim()) {
      onSaveSearch(saveName.trim());
      setSaveName('');
      setSaveDialogOpen(false);
    }
  };

  // Filter skills suggestions based on input
  const skillSuggestions = skillInput.length >= 1
    ? availableSkills
        .filter((s) => s.toLowerCase().includes(skillInput.toLowerCase()) && !filters.skills.includes(s.toLowerCase()))
        .slice(0, 8)
    : [];

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
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onFiltersChange(DEFAULT_FILTERS)}>
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

          {/* ── Job ────────────────────────────────────────────────────── */}
          <FilterSection title="Job">
            <Select value={filters.jobTag} onValueChange={(v) => update({ jobTag: v })}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="All Jobs" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Jobs</SelectItem>
                {(jobs as any[])
                  .filter((j) => j.status !== 'lost' && j.status !== 'on_hold')
                  .sort((a, b) => a.title.localeCompare(b.title))
                  .map((job) => (
                    <SelectItem key={job.id} value={job.id}>
                      {job.title}{job.company_name ? ` — ${job.company_name}` : ''}
                    </SelectItem>
                  ))}
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
                <SelectItem value="mine">My Candidates</SelectItem>
                {profiles.filter((p: any) => p.full_name).map((p: any) => (
                  <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterSection>

          {/* ── Location / Radius ──────────────────────────────────────── */}
          <FilterSection title="Location">
            <div className="space-y-2">
              <div className="relative">
                <Input
                  className="h-8 text-xs pr-8"
                  placeholder="e.g. New York, Remote"
                  value={filters.location}
                  onChange={(e) => update({ location: e.target.value, locationLat: null, locationLng: null })}
                  list="location-suggestions"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && filters.location && filters.locationRadius > 0) {
                      handleGeocode();
                    }
                  }}
                />
                {geocoding && (
                  <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3 w-3 animate-spin text-muted-foreground" />
                )}
              </div>
              {availableLocations.length > 0 && (
                <datalist id="location-suggestions">
                  {availableLocations.slice(0, 20).map((loc) => (
                    <option key={loc} value={loc} />
                  ))}
                </datalist>
              )}
              {/* Radius slider */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <MapPin className="h-2.5 w-2.5" />
                    Radius Search
                  </label>
                  <span className="text-[10px] font-medium text-foreground">
                    {filters.locationRadius === 0 ? 'Off' : `${filters.locationRadius} mi`}
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="200"
                  step="5"
                  value={filters.locationRadius}
                  onChange={(e) => {
                    const radius = parseInt(e.target.value, 10);
                    update({ locationRadius: radius });
                    // Trigger geocoding when radius is enabled and location is set
                    if (radius > 0 && filters.location && !filters.locationLat) {
                      debouncedGeocode();
                    }
                  }}
                  className="w-full h-1.5 bg-muted rounded-full appearance-none cursor-pointer accent-accent"
                />
                <div className="flex justify-between text-[9px] text-muted-foreground/60">
                  <span>Text only</span>
                  <span>25mi</span>
                  <span>50mi</span>
                  <span>100mi</span>
                  <span>200mi</span>
                </div>
              </div>
              {/* Geocode status */}
              {filters.locationRadius > 0 && filters.location && (
                <div className="text-[10px]">
                  {filters.locationLat !== null ? (
                    <span className="text-emerald-500 flex items-center gap-1">
                      <MapPin className="h-2.5 w-2.5" />
                      Geocoded — searching within {filters.locationRadius}mi
                    </span>
                  ) : (
                    <button
                      onClick={handleGeocode}
                      className="text-accent hover:underline flex items-center gap-1"
                      disabled={geocoding}
                    >
                      <MapPin className="h-2.5 w-2.5" />
                      {geocoding ? 'Geocoding...' : 'Click to enable radius search'}
                    </button>
                  )}
                </div>
              )}
            </div>
          </FilterSection>

          {/* ── Title ──────────────────────────────────────────────────── */}
          <FilterSection title="Title">
            <Input
              className="h-8 text-xs"
              placeholder="e.g. Senior Engineer"
              value={filters.title}
              onChange={(e) => update({ title: e.target.value })}
            />
          </FilterSection>

          {/* ── Company ────────────────────────────────────────────────── */}
          <FilterSection title="Company">
            <Input
              className="h-8 text-xs"
              placeholder="e.g. Google"
              value={filters.company}
              onChange={(e) => update({ company: e.target.value })}
            />
          </FilterSection>

          {/* ── Skills / Tags ──────────────────────────────────────────── */}
          <FilterSection title="Skills / Tags">
            <div className="space-y-2">
              <div className="relative">
                <Input
                  className="h-8 text-xs"
                  placeholder="Type a skill and press Enter"
                  value={skillInput}
                  onChange={(e) => setSkillInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addSkill(skillInput);
                    }
                  }}
                />
                {skillSuggestions.length > 0 && (
                  <div className="absolute top-full left-0 right-0 z-50 mt-1 rounded-md border border-border bg-popover shadow-md max-h-32 overflow-y-auto">
                    {skillSuggestions.map((s) => (
                      <button
                        key={s}
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 transition-colors"
                        onClick={() => addSkill(s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {filters.skills.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {filters.skills.map((skill) => (
                    <Badge key={skill} variant="secondary" className="text-[10px] gap-1 pr-1">
                      {skill}
                      <button onClick={() => removeSkill(skill)} className="hover:text-destructive">
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </FilterSection>

          {/* ── Work Authorization ──────────────────────────────────────── */}
          <FilterSection title="Work Authorization">
            <Select value={filters.workAuthorization} onValueChange={(v) => update({ workAuthorization: v })}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Any" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any</SelectItem>
                {WORK_AUTH_OPTIONS.map((opt) => (
                  <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterSection>

          {/* ── Experience Range ────────────────────────────────────────── */}
          <FilterSection title="Years of Experience">
            <div className="flex items-center gap-2">
              <Input
                className="h-8 text-xs w-20"
                type="number"
                min="0"
                placeholder="Min"
                value={filters.minExperience}
                onChange={(e) => update({ minExperience: e.target.value })}
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                className="h-8 text-xs w-20"
                type="number"
                min="0"
                placeholder="Max"
                value={filters.maxExperience}
                onChange={(e) => update({ maxExperience: e.target.value })}
              />
            </div>
          </FilterSection>

          {/* ── Date Added Range ────────────────────────────────────────── */}
          <FilterSection title="Date Added">
            <div className="space-y-2">
              <DatePickerField
                label="From"
                date={filters.dateAddedFrom}
                onSelect={(d) => update({ dateAddedFrom: d })}
              />
              <DatePickerField
                label="To"
                date={filters.dateAddedTo}
                onSelect={(d) => update({ dateAddedTo: d })}
              />
            </div>
          </FilterSection>

          {/* ── Last Activity ──────────────────────────────────────────── */}
          <FilterSection title="Last Activity">
            <DatePickerField
              label="Active since"
              date={filters.lastActivityFrom}
              onSelect={(d) => update({ lastActivityFrom: d })}
            />
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
