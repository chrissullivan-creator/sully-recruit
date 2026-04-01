import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { RichTextEditor } from '@/components/shared/RichTextEditor';
import { useCreateTask } from '@/hooks/useTasks';
import { useProfiles } from '@/hooks/useProfiles';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import {
  Loader2, CalendarIcon, Search, X, User, Briefcase, Building, Clock,
  Video, MapPin, Users,
} from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultLinks?: { entity_type: string; entity_id: string }[];
  defaultMode?: 'task' | 'meeting';
}

type EntityType = 'candidate' | 'job' | 'contact' | 'company';

const ENTITY_CONFIG: Record<EntityType, { label: string; plural: string; icon: React.ElementType; emoji: string }> = {
  candidate: { label: 'Candidate', plural: 'candidates', icon: User, emoji: '👤' },
  job: { label: 'Job', plural: 'jobs', icon: Briefcase, emoji: '💼' },
  contact: { label: 'Contact', plural: 'contacts', icon: Building, emoji: '🤝' },
  company: { label: 'Company', plural: 'companies', icon: Building, emoji: '🏢' },
};

const TASK_TYPES = [
  'Follow Up', 'Interview', 'Phone Screen', 'Reference Check',
  'Offer Call', 'Send Out', 'General',
];

const REMINDER_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: '5m', label: '5 Min Before' },
  { value: '15m', label: '15 Min Before' },
  { value: '30m', label: '30 Min Before' },
  { value: '1h', label: '1 Hour Before' },
  { value: '1d', label: '1 Day Before' },
];

const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2);
  const m = i % 2 === 0 ? '00' : '30';
  const ampm = h < 12 ? 'AM' : 'PM';
  const display = h === 0 ? `12:${m} AM` : h <= 12 ? `${h}:${m} ${ampm}` : `${h - 12}:${m} ${ampm}`;
  return { value: `${String(h).padStart(2, '0')}:${m}`, label: display };
});

const TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern Time - US & Canada' },
  { value: 'America/Chicago', label: 'Central Time - US & Canada' },
  { value: 'America/Denver', label: 'Mountain Time - US & Canada' },
  { value: 'America/Los_Angeles', label: 'Pacific Time - US & Canada' },
  { value: 'America/Phoenix', label: 'Arizona' },
  { value: 'America/Anchorage', label: 'Alaska' },
  { value: 'Pacific/Honolulu', label: 'Hawaii' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Paris', label: 'Central European' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
];

export function CreateTaskDialog({ open, onOpenChange, defaultLinks, defaultMode = 'task' }: Props) {
  const { user } = useAuth();
  const createTask = useCreateTask();
  const { data: profiles = [] } = useProfiles();
  const [mode, setMode] = useState<'task' | 'meeting'>(defaultMode);
  const [form, setForm] = useState({
    title: '',
    description: '',
    due_date: new Date(),
    start_time: '09:00',
    end_time: '09:30',
    timezone: 'America/Chicago',
    assigned_to: '',
    reminder: '30m',
    task_subtype: 'Follow Up',
    location: '',
    meeting_url: '',
    meeting_provider: '' as string,
    no_calendar_invites: false,
    create_followup: false,
  });
  const [links, setLinks] = useState<{ entity_type: string; entity_id: string; label: string }[]>([]);
  const [attendees, setAttendees] = useState<{ entity_type: string; entity_id: string; label: string }[]>([]);
  const [entitySearch, setEntitySearch] = useState('');
  const [entityType, setEntityType] = useState<EntityType>('candidate');
  const [searchResults, setSearchResults] = useState<{ id: string; label: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [attendeeSearch, setAttendeeSearch] = useState('');
  const [attendeeResults, setAttendeeResults] = useState<{ id: string; label: string; type: string }[]>([]);
  const [searchingAttendees, setSearchingAttendees] = useState(false);

  useEffect(() => {
    if (open) {
      setMode(defaultMode);
      setForm({
        title: '', description: '', due_date: new Date(), start_time: '09:00', end_time: '09:30',
        timezone: 'America/Chicago', assigned_to: '', reminder: '30m', task_subtype: 'Follow Up',
        location: '', meeting_url: '', meeting_provider: '', no_calendar_invites: false, create_followup: false,
      });
      setLinks(defaultLinks?.map(l => ({ ...l, label: '' })) || []);
      setAttendees([]);
      setEntitySearch('');
      setSearchResults([]);
      setAttendeeSearch('');
      setAttendeeResults([]);
    }
  }, [open, defaultLinks, defaultMode]);

  // Search entities with debounce
  useEffect(() => {
    if (!entitySearch.trim()) { setSearchResults([]); return; }
    const timeout = setTimeout(async () => {
      setSearching(true);
      if (entityType === 'candidate') {
        const { data } = await supabase.from('candidates').select('id, full_name').ilike('full_name', `%${entitySearch}%`).limit(8);
        setSearchResults((data || []).map(c => ({ id: c.id, label: c.full_name || 'Unnamed' })));
      } else if (entityType === 'job') {
        const { data } = await supabase.from('jobs').select('id, title, company_name, status').ilike('title', `%${entitySearch}%`).not('status', 'in', '("closed_won","closed_lost")').limit(8);
        setSearchResults((data || []).map(j => ({ id: j.id, label: `${j.title}${j.company_name ? ` — ${j.company_name}` : ''}` })));
      } else if (entityType === 'contact') {
        const { data } = await supabase.from('contacts').select('id, full_name, title, email').ilike('full_name', `%${entitySearch}%`).limit(8);
        setSearchResults((data || []).map(c => ({ id: c.id, label: `${c.full_name || 'Unnamed'}${c.title ? ` · ${c.title}` : ''}` })));
      } else if (entityType === 'company') {
        const { data } = await supabase.from('companies').select('id, name').ilike('name', `%${entitySearch}%`).limit(8);
        setSearchResults((data || []).map(c => ({ id: c.id, label: c.name || 'Unnamed' })));
      }
      setSearching(false);
    }, 300);
    return () => clearTimeout(timeout);
  }, [entitySearch, entityType]);

  // Search attendees (candidates + contacts + users)
  useEffect(() => {
    if (!attendeeSearch.trim()) { setAttendeeResults([]); return; }
    const timeout = setTimeout(async () => {
      setSearchingAttendees(true);
      const q = attendeeSearch.trim();
      const [cRes, ctRes, pRes] = await Promise.all([
        supabase.from('candidates').select('id, full_name').ilike('full_name', `%${q}%`).limit(5),
        supabase.from('contacts').select('id, full_name').ilike('full_name', `%${q}%`).limit(5),
        supabase.from('profiles').select('id, full_name, email').or(`full_name.ilike.%${q}%,email.ilike.%${q}%`).limit(5),
      ]);
      setAttendeeResults([
        ...(cRes.data || []).map(c => ({ id: c.id, label: c.full_name || 'Candidate', type: 'candidate' })),
        ...(ctRes.data || []).map(c => ({ id: c.id, label: c.full_name || 'Contact', type: 'contact' })),
        ...(pRes.data || []).map(p => ({ id: p.id, label: p.full_name || p.email || 'User', type: 'user' })),
      ]);
      setSearchingAttendees(false);
    }, 300);
    return () => clearTimeout(timeout);
  }, [attendeeSearch]);

  const addLink = (id: string, label: string) => {
    if (!links.find(l => l.entity_id === id)) {
      setLinks(prev => [...prev, { entity_type: entityType, entity_id: id, label }]);
    }
    setEntitySearch('');
    setSearchResults([]);
  };

  const removeLink = (id: string) => setLinks(prev => prev.filter(l => l.entity_id !== id));

  const addAttendee = (item: { id: string; label: string; type: string }) => {
    if (!attendees.find(a => a.entity_id === item.id)) {
      setAttendees(prev => [...prev, { entity_type: item.type, entity_id: item.id, label: item.label }]);
    }
    setAttendeeSearch('');
    setAttendeeResults([]);
  };

  const handleCreate = () => {
    if (!form.title.trim()) return;

    // Build start_time as ISO string
    const [sh, sm] = form.start_time.split(':').map(Number);
    const startDate = new Date(form.due_date);
    startDate.setHours(sh, sm, 0, 0);

    const [eh, em] = form.end_time.split(':').map(Number);
    const endDate = new Date(form.due_date);
    endDate.setHours(eh, em, 0, 0);

    createTask.mutate(
      {
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        due_date: format(form.due_date, 'yyyy-MM-dd'),
        assigned_to: form.assigned_to || undefined,
        links: links.map(l => ({ entity_type: l.entity_type, entity_id: l.entity_id })),
        task_type: mode,
        start_time: startDate.toISOString(),
        end_time: mode === 'meeting' ? endDate.toISOString() : undefined,
        timezone: form.timezone,
        reminder: form.reminder !== 'none' ? form.reminder : undefined,
        task_subtype: form.task_subtype,
        location: mode === 'meeting' ? form.location || undefined : undefined,
        meeting_url: mode === 'meeting' ? form.meeting_url || undefined : undefined,
        meeting_provider: mode === 'meeting' ? form.meeting_provider || undefined : undefined,
        no_calendar_invites: mode === 'meeting' ? form.no_calendar_invites : undefined,
        create_followup: mode === 'meeting' ? form.create_followup : undefined,
        attendees: mode === 'meeting' ? attendees.map(a => ({ entity_type: a.entity_type, entity_id: a.entity_id })) : undefined,
      },
      {
        onSuccess: () => onOpenChange(false),
      }
    );
  };

  const linkedChips = links.map(l => {
    const cfg = ENTITY_CONFIG[l.entity_type as EntityType] || ENTITY_CONFIG.candidate;
    const colorMap: Record<string, string> = {
      candidate: 'bg-accent/10 text-accent border-accent/20',
      job: 'bg-info/10 text-info border-info/20',
      contact: 'bg-warning/10 text-warning border-warning/20',
      company: 'bg-success/10 text-success border-success/20',
    };
    return (
      <span key={l.entity_id} className={cn('inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border', colorMap[l.entity_type] || colorMap.candidate)}>
        {cfg.emoji} {l.label || cfg.label}
        <button onClick={() => removeLink(l.entity_id)} className="hover:text-destructive ml-0.5"><X className="h-3 w-3" /></button>
      </span>
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{mode === 'task' ? 'Add Task' : 'Add Meeting'}</DialogTitle>
        </DialogHeader>

        {/* Task / Meeting toggle */}
        <RadioGroup value={mode} onValueChange={(v) => setMode(v as 'task' | 'meeting')} className="flex gap-4">
          <div className="flex items-center gap-2">
            <RadioGroupItem value="task" id="mode-task" />
            <Label htmlFor="mode-task" className="cursor-pointer text-sm font-medium">Add Task</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="meeting" id="mode-meeting" />
            <Label htmlFor="mode-meeting" className="cursor-pointer text-sm font-medium">Add Meeting</Label>
          </div>
        </RadioGroup>

        <ScrollArea className="flex-1 -mx-6 px-6">
          <div className="space-y-4 pb-4">
            {/* Title */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Title</Label>
              <Input value={form.title} onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))} placeholder="Staff meeting & Review to discuss issue" />
            </div>

            {/* Owner + Related To */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Owner</Label>
                <Select value={form.assigned_to} onValueChange={(v) => setForm(f => ({ ...f, assigned_to: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select user" /></SelectTrigger>
                  <SelectContent>
                    {profiles.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.full_name || p.email || 'Unknown'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Related to</Label>
                <div className="flex gap-1.5">
                  <Select value={entityType} onValueChange={(v) => { setEntityType(v as EntityType); setEntitySearch(''); setSearchResults([]); }}>
                    <SelectTrigger className="w-[100px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="candidate">Candidate</SelectItem>
                      <SelectItem value="contact">Contact</SelectItem>
                      <SelectItem value="company">Company</SelectItem>
                      <SelectItem value="job">Job</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="relative flex-1">
                    <Input
                      value={entitySearch}
                      onChange={(e) => setEntitySearch(e.target.value)}
                      placeholder={`Search...`}
                      className="h-9 text-sm pr-7"
                    />
                    {entitySearch && (
                      <button onClick={() => { setEntitySearch(''); setSearchResults([]); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {searching && <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                    {searchResults.length > 0 && (
                      <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-popover border border-border rounded-md shadow-lg max-h-40 overflow-y-auto">
                        {searchResults.map(r => (
                          <button key={r.id} onClick={() => addLink(r.id, r.label)} className="w-full text-left px-3 py-2 text-sm hover:bg-accent/10 text-foreground">
                            {r.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Linked entities */}
            {linkedChips.length > 0 && (
              <div className="flex flex-wrap gap-1.5">{linkedChips}</div>
            )}

            {/* Meeting: Where (video links) */}
            {mode === 'meeting' && (
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Where</Label>
                <div className="flex gap-2 mb-2">
                  {[
                    { key: 'google_meet', label: 'Connect G Meet Link', color: 'text-green-600 border-green-200 hover:bg-green-50' },
                    { key: 'ms_teams', label: 'Connect MS Teams Link', color: 'text-blue-600 border-blue-200 hover:bg-blue-50' },
                    { key: 'zoom', label: 'Connect Zoom Link', color: 'text-blue-500 border-blue-200 hover:bg-blue-50' },
                  ].map(({ key, label, color }) => (
                    <Button
                      key={key}
                      variant="outline"
                      size="sm"
                      className={cn('text-xs gap-1', color, form.meeting_provider === key && 'ring-2 ring-primary/30')}
                      onClick={() => setForm(f => ({ ...f, meeting_provider: f.meeting_provider === key ? '' : key }))}
                    >
                      <Video className="h-3 w-3" />
                      {label}
                    </Button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                  <Input
                    value={form.location}
                    onChange={(e) => setForm(f => ({ ...f, location: e.target.value }))}
                    placeholder="35, WF Park, New York"
                    className="h-9 text-sm"
                  />
                </div>
              </div>
            )}

            {/* Reminder + Starting date/time */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reminder</Label>
                <Select value={form.reminder} onValueChange={(v) => setForm(f => ({ ...f, reminder: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {REMINDER_OPTIONS.map(o => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {mode === 'meeting' ? 'Starting On' : 'Starting'}
                </Label>
                <div className="flex gap-1.5">
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className="flex-1 justify-start text-left font-normal text-sm h-9">
                        <CalendarIcon className="h-3.5 w-3.5 mr-1.5" />
                        {format(form.due_date, 'MMM d, yyyy')}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={form.due_date}
                        onSelect={(d) => d && setForm(f => ({ ...f, due_date: d }))}
                        className="p-3 pointer-events-auto"
                      />
                    </PopoverContent>
                  </Popover>
                  <Select value={form.start_time} onValueChange={(v) => setForm(f => ({ ...f, start_time: v }))}>
                    <SelectTrigger className="w-[100px] h-9 text-xs">
                      <Clock className="h-3 w-3 mr-1" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TIME_OPTIONS.map(t => (
                        <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            {/* Meeting: End time */}
            {mode === 'meeting' && (
              <div className="grid grid-cols-2 gap-4">
                <div />
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">End Time</Label>
                  <Select value={form.end_time} onValueChange={(v) => setForm(f => ({ ...f, end_time: v }))}>
                    <SelectTrigger className="h-9 text-xs">
                      <Clock className="h-3 w-3 mr-1" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TIME_OPTIONS.filter(t => t.value > form.start_time).map(t => (
                        <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {/* Timezone */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                Time Zone: ({TIMEZONES.find(t => t.value === form.timezone)?.label || form.timezone})
              </Label>
              <Select value={form.timezone} onValueChange={(v) => setForm(f => ({ ...f, timezone: v }))}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map(tz => (
                    <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Meeting: Attendees */}
            {mode === 'meeting' && (
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Attendees</Label>
                {attendees.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {attendees.map(a => (
                      <span key={a.entity_id} className="inline-flex items-center gap-1 bg-muted text-foreground text-xs px-2.5 py-1 rounded-full border border-border">
                        <Users className="h-3 w-3" />
                        {a.label}
                        <button onClick={() => setAttendees(prev => prev.filter(x => x.entity_id !== a.entity_id))} className="hover:text-destructive ml-0.5">
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    value={attendeeSearch}
                    onChange={(e) => setAttendeeSearch(e.target.value)}
                    placeholder="Candidates, Contact, Users"
                    className="pl-7 h-9 text-sm"
                  />
                  {searchingAttendees && <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin" />}
                  {attendeeResults.length > 0 && (
                    <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-popover border border-border rounded-md shadow-lg max-h-40 overflow-y-auto">
                      {attendeeResults.map(r => (
                        <button key={r.id + r.type} onClick={() => addAttendee(r)} className="w-full text-left px-3 py-2 text-sm hover:bg-accent/10 text-foreground flex items-center gap-2">
                          <span className="text-[10px] uppercase text-muted-foreground w-14">{r.type}</span>
                          {r.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <p className="text-[10px] text-muted-foreground text-right">{attendees.length} / 10</p>
              </div>
            )}

            {/* Type */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Type</Label>
              <Select value={form.task_subtype} onValueChange={(v) => setForm(f => ({ ...f, task_subtype: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TASK_TYPES.map(t => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Description</Label>
              <RichTextEditor
                value={form.description}
                onChange={(html) => setForm(f => ({ ...f, description: html }))}
                placeholder={mode === 'meeting' ? 'Type a short description of the event for attendees.' : 'Start typing...'}
                minHeight="100px"
              />
            </div>

            {/* Meeting checkboxes */}
            {mode === 'meeting' && (
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="no-cal-invites"
                    checked={form.no_calendar_invites}
                    onCheckedChange={(v) => setForm(f => ({ ...f, no_calendar_invites: !!v }))}
                  />
                  <Label htmlFor="no-cal-invites" className="text-xs cursor-pointer">Do not send calendar invites</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="create-followup"
                    checked={form.create_followup}
                    onCheckedChange={(v) => setForm(f => ({ ...f, create_followup: !!v }))}
                  />
                  <Label htmlFor="create-followup" className="text-xs cursor-pointer">Create a follow up task</Label>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="flex justify-between">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
          <Button variant="gold" onClick={handleCreate} disabled={!form.title.trim() || createTask.isPending}>
            {createTask.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
