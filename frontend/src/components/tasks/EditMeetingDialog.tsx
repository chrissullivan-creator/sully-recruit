import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Task, useUpdateTask } from '@/hooks/useTasks';
import { useProfiles } from '@/hooks/useProfiles';
import { supabase } from '@/integrations/supabase/client';
import {
  Loader2, CalendarIcon, Search, X, Clock, MapPin, Users, Video,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { cn } from '@/lib/utils';

const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2);
  const m = i % 2 === 0 ? '00' : '30';
  const ampm = h < 12 ? 'AM' : 'PM';
  const display = h === 0 ? `12:${m} AM` : h <= 12 ? `${h}:${m} ${ampm}` : `${h - 12}:${m} ${ampm}`;
  return { value: `${String(h).padStart(2, '0')}:${m}`, label: display };
});

const TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern' },
  { value: 'America/Chicago', label: 'Central' },
  { value: 'America/Denver', label: 'Mountain' },
  { value: 'America/Los_Angeles', label: 'Pacific' },
  { value: 'Europe/London', label: 'London' },
];

const REMINDER_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: '5m', label: '5 min before' },
  { value: '15m', label: '15 min before' },
  { value: '30m', label: '30 min before' },
  { value: '1h', label: '1 hour before' },
  { value: '1d', label: '1 day before' },
];

interface Attendee {
  entity_type: string;
  entity_id: string;
  name: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task;
  companyId?: string | null;
}

export function EditMeetingDialog({ open, onOpenChange, task, companyId }: Props) {
  const updateTask = useUpdateTask();
  const { data: profiles = [] } = useProfiles();

  // Form state
  const [title, setTitle] = useState(task.title);
  const [date, setDate] = useState<Date | undefined>(
    task.start_time ? parseISO(task.start_time) : task.due_date ? parseISO(task.due_date) : undefined
  );
  const [startTime, setStartTime] = useState(
    task.start_time ? format(parseISO(task.start_time), 'HH:mm') : '09:00'
  );
  const [endTime, setEndTime] = useState(
    task.end_time ? format(parseISO(task.end_time), 'HH:mm') : '09:30'
  );
  const [timezone, setTimezone] = useState(task.timezone || 'America/New_York');
  const [location, setLocation] = useState(task.location || '');
  const [meetingUrl, setMeetingUrl] = useState(task.meeting_url || '');
  const [reminder, setReminder] = useState(task.reminder || 'none');
  const [assignedTo, setAssignedTo] = useState<string>(task.assigned_to || '');

  // Attendees
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [attendeeSearch, setAttendeeSearch] = useState('');
  const [attendeeResults, setAttendeeResults] = useState<Attendee[]>([]);
  const [loadingAttendees, setLoadingAttendees] = useState(false);

  // Load existing attendees
  useEffect(() => {
    if (!open) return;
    (async () => {
      const { data } = await supabase
        .from('meeting_attendees')
        .select('entity_type, entity_id')
        .eq('task_id', task.id);
      if (!data?.length) return;

      const loaded: Attendee[] = [];
      for (const a of data) {
        if (a.entity_type === 'candidate') {
          const { data: c } = await supabase.from('candidates').select('full_name').eq('id', a.entity_id).maybeSingle();
          loaded.push({ ...a, name: c?.full_name || 'Unknown Candidate' });
        } else if (a.entity_type === 'contact') {
          const { data: c } = await supabase.from('contacts').select('full_name').eq('id', a.entity_id).maybeSingle();
          loaded.push({ ...a, name: c?.full_name || 'Unknown Contact' });
        } else if (a.entity_type === 'user') {
          const p = profiles.find(p => p.id === a.entity_id);
          loaded.push({ ...a, name: p?.full_name || 'Team Member' });
        }
      }
      setAttendees(loaded);
    })();
  }, [open, task.id, profiles]);

  // Search contacts (prioritize from same company)
  useEffect(() => {
    if (attendeeSearch.length < 2) { setAttendeeResults([]); return; }
    const timer = setTimeout(async () => {
      setLoadingAttendees(true);
      const results: Attendee[] = [];

      // Search contacts (prioritize same company)
      let contactQuery = supabase
        .from('contacts')
        .select('id, full_name, company_id')
        .ilike('full_name', `%${attendeeSearch}%`)
        .limit(10);
      const { data: contacts } = await contactQuery;
      for (const c of contacts || []) {
        if (!attendees.find(a => a.entity_id === c.id && a.entity_type === 'contact')) {
          results.push({ entity_type: 'contact', entity_id: c.id, name: `${c.full_name}${c.company_id === companyId ? ' (same firm)' : ''}` });
        }
      }
      // Sort same-firm contacts first
      results.sort((a, b) => {
        const aFirm = a.name.includes('(same firm)') ? 0 : 1;
        const bFirm = b.name.includes('(same firm)') ? 0 : 1;
        return aFirm - bFirm;
      });

      // Search candidates
      const { data: candidates } = await supabase
        .from('candidates')
        .select('id, full_name')
        .ilike('full_name', `%${attendeeSearch}%`)
        .limit(5);
      for (const c of candidates || []) {
        if (!attendees.find(a => a.entity_id === c.id && a.entity_type === 'candidate')) {
          results.push({ entity_type: 'candidate', entity_id: c.id, name: c.full_name || 'Candidate' });
        }
      }

      // Team members
      for (const p of profiles) {
        if (p.full_name?.toLowerCase().includes(attendeeSearch.toLowerCase()) &&
            !attendees.find(a => a.entity_id === p.id && a.entity_type === 'user')) {
          results.push({ entity_type: 'user', entity_id: p.id, name: `${p.full_name} (team)` });
        }
      }

      setAttendeeResults(results);
      setLoadingAttendees(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [attendeeSearch, attendees, companyId, profiles]);

  // Also load contacts at the company for quick-add
  const [companyContacts, setCompanyContacts] = useState<Attendee[]>([]);
  useEffect(() => {
    if (!open || !companyId) return;
    (async () => {
      const { data } = await supabase
        .from('contacts')
        .select('id, full_name')
        .eq('company_id', companyId)
        .order('full_name')
        .limit(20);
      setCompanyContacts(
        (data || []).map(c => ({ entity_type: 'contact', entity_id: c.id, name: c.full_name || 'Contact' }))
      );
    })();
  }, [open, companyId]);

  const handleSave = () => {
    const updates: any = {
      title,
      location: location || null,
      meeting_url: meetingUrl || null,
      timezone,
      reminder: reminder === 'none' ? null : reminder,
      assigned_to: assignedTo || null,
    };

    if (date) {
      const dateStr = format(date, 'yyyy-MM-dd');
      updates.due_date = `${dateStr}T${startTime}:00`;
      updates.start_time = `${dateStr}T${startTime}:00`;
      updates.end_time = `${dateStr}T${endTime}:00`;
    }

    updateTask.mutate(
      { taskId: task.id, updates, attendees: attendees.map(a => ({ entity_type: a.entity_type, entity_id: a.entity_id })) },
      { onSuccess: () => onOpenChange(false) }
    );
  };

  const addAttendee = (a: Attendee) => {
    setAttendees(prev => [...prev, a]);
    setAttendeeSearch('');
    setAttendeeResults([]);
  };

  const removeAttendee = (idx: number) => {
    setAttendees(prev => prev.filter((_, i) => i !== idx));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Edit Interview</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Title */}
          <div className="space-y-1.5">
            <Label className="text-xs">Title</Label>
            <Input value={title} onChange={e => setTitle(e.target.value)} className="h-8 text-sm" />
          </div>

          {/* Date */}
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1"><CalendarIcon className="h-3 w-3" /> Date</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className={cn('w-full justify-start text-left h-8 text-sm', !date && 'text-muted-foreground')}>
                  {date ? format(date, 'EEEE, MMMM d, yyyy') : 'Select date'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar mode="single" selected={date} onSelect={setDate} />
              </PopoverContent>
            </Popover>
          </div>

          {/* Time row */}
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs flex items-center gap-1"><Clock className="h-3 w-3" /> Start</Label>
              <Select value={startTime} onValueChange={setStartTime}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TIME_OPTIONS.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">End</Label>
              <Select value={endTime} onValueChange={setEndTime}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TIME_OPTIONS.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Timezone</Label>
              <Select value={timezone} onValueChange={setTimezone}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map(tz => <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Location */}
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1"><MapPin className="h-3 w-3" /> Location</Label>
            <Input value={location} onChange={e => setLocation(e.target.value)} placeholder="e.g. 1 World Trade Center, 85th Floor" className="h-8 text-sm" />
          </div>

          {/* Meeting URL */}
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1"><Video className="h-3 w-3" /> Meeting Link</Label>
            <Input value={meetingUrl} onChange={e => setMeetingUrl(e.target.value)} placeholder="Zoom / Teams / Google Meet URL" className="h-8 text-sm" />
          </div>

          {/* Reminder + Owner */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Reminder</Label>
              <Select value={reminder} onValueChange={setReminder}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {REMINDER_OPTIONS.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Owner</Label>
              <Select value={assignedTo || 'unassigned'} onValueChange={v => setAssignedTo(v === 'unassigned' ? '' : v)}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {profiles.filter(p => p.full_name).map(p => (
                    <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Attendees */}
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1"><Users className="h-3 w-3" /> Attendees</Label>

            {/* Current attendees */}
            {attendees.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {attendees.map((a, i) => (
                  <span key={`${a.entity_type}-${a.entity_id}`} className="flex items-center gap-1 bg-accent/10 text-accent text-xs px-2 py-0.5 rounded-full">
                    {a.entity_type === 'contact' ? '🤝' : a.entity_type === 'candidate' ? '👤' : '👥'} {a.name}
                    <button onClick={() => removeAttendee(i)} className="hover:text-destructive"><X className="h-3 w-3" /></button>
                  </span>
                ))}
              </div>
            )}

            {/* Quick add from company contacts */}
            {companyContacts.length > 0 && (
              <div className="mb-2">
                <p className="text-[10px] text-muted-foreground mb-1">Contacts at firm:</p>
                <div className="flex flex-wrap gap-1">
                  {companyContacts
                    .filter(c => !attendees.find(a => a.entity_id === c.entity_id))
                    .map(c => (
                      <button
                        key={c.entity_id}
                        onClick={() => addAttendee(c)}
                        className="text-[11px] px-2 py-0.5 rounded-full border border-border hover:border-accent hover:text-accent transition-colors"
                      >
                        + {c.name}
                      </button>
                    ))}
                </div>
              </div>
            )}

            {/* Search input */}
            <div className="relative">
              <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={attendeeSearch}
                onChange={e => setAttendeeSearch(e.target.value)}
                placeholder="Search contacts, candidates, team..."
                className="h-8 text-sm pl-7"
              />
              {loadingAttendees && <Loader2 className="h-3.5 w-3.5 animate-spin absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" />}
            </div>
            {attendeeResults.length > 0 && (
              <ScrollArea className="max-h-32 border border-border rounded-md">
                {attendeeResults.map(r => (
                  <button
                    key={`${r.entity_type}-${r.entity_id}`}
                    onClick={() => addAttendee(r)}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors flex items-center gap-2"
                  >
                    <span className="text-xs">{r.entity_type === 'contact' ? '🤝' : r.entity_type === 'candidate' ? '👤' : '👥'}</span>
                    {r.name}
                  </button>
                ))}
              </ScrollArea>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="gold" size="sm" onClick={handleSave} disabled={updateTask.isPending}>
            {updateTask.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
