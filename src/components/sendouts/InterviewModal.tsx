import { useEffect, useState, useMemo } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem,
} from '@/components/ui/command';
import { Badge } from '@/components/ui/badge';
import { useContacts } from '@/hooks/useData';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { toast } from 'sonner';
import {
  INTERVIEW_TYPES, INTERVIEW_TYPE_LABEL, type InterviewRow,
} from '@/components/sendouts/interviewTypes';
import { Check, ChevronsUpDown, Loader2, Plus, X, CalendarPlus } from 'lucide-react';
import { cn } from '@/lib/utils';

interface InterviewModalProps {
  open: boolean;
  onClose: () => void;
  sendOutId: string;
  nextRound: number;
  interview?: InterviewRow | null;
  onSaved?: () => void;
}

interface PanelMember {
  contact_id?: string | null;
  name: string;
  email?: string | null;
}

const DEFAULT_STAGE = 'to_be_scheduled';

export function InterviewModal({
  open, onClose, sendOutId, nextRound, interview, onSaved,
}: InterviewModalProps) {
  const { data: contacts = [] } = useContacts();

  const [round, setRound] = useState<number>(nextRound);
  const [interviewType, setInterviewType] = useState<string>('phone_screen');
  const [stage, setStage] = useState<string>(DEFAULT_STAGE);
  const [scheduledDate, setScheduledDate] = useState<string>('');
  const [scheduledTime, setScheduledTime] = useState<string>('');
  const [timezone, setTimezone] = useState<string>(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  const [location, setLocation] = useState<string>('');
  const [meetingLink, setMeetingLink] = useState<string>('');
  const [interviewerContactId, setInterviewerContactId] = useState<string | null>(null);
  const [interviewerPickerOpen, setInterviewerPickerOpen] = useState(false);
  const [panel, setPanel] = useState<PanelMember[]>([]);
  const [panelQuery, setPanelQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [creatingEvent, setCreatingEvent] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (interview) {
      setRound(interview.round ?? 1);
      setInterviewType(interview.interview_type ?? 'phone_screen');
      setStage(interview.stage ?? DEFAULT_STAGE);
      if (interview.scheduled_at) {
        const d = new Date(interview.scheduled_at);
        setScheduledDate(d.toISOString().slice(0, 10));
        setScheduledTime(d.toTimeString().slice(0, 5));
      } else {
        setScheduledDate('');
        setScheduledTime('');
      }
      setTimezone(interview.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
      setLocation(interview.location ?? '');
      setMeetingLink(interview.meeting_link ?? '');
      setInterviewerContactId(interview.interviewer_contact_id ?? null);
      setPanel(Array.isArray(interview.additional_interviewers) ? interview.additional_interviewers : []);
    } else {
      setRound(nextRound);
      setInterviewType('phone_screen');
      setStage(DEFAULT_STAGE);
      setScheduledDate('');
      setScheduledTime('');
      setLocation('');
      setMeetingLink('');
      setInterviewerContactId(null);
      setPanel([]);
    }
  }, [open, interview, nextRound]);

  const contactById = useMemo(
    () => Object.fromEntries((contacts as any[]).map((c) => [c.id, c])),
    [contacts],
  );

  const scheduledAtIso = useMemo(() => {
    if (!scheduledDate) return null;
    const dt = new Date(`${scheduledDate}T${scheduledTime || '09:00'}`);
    return isNaN(dt.getTime()) ? null : dt.toISOString();
  }, [scheduledDate, scheduledTime]);

  const filteredPanelCandidates = useMemo(() => {
    const q = panelQuery.trim().toLowerCase();
    const already = new Set(panel.map((p) => p.contact_id).filter(Boolean) as string[]);
    return (contacts as any[])
      .filter((c) => !already.has(c.id))
      .filter((c) => {
        if (!q) return true;
        return (c.full_name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q);
      })
      .slice(0, 8);
  }, [contacts, panelQuery, panel]);

  const addPanelMember = (c: any) => {
    setPanel((prev) => [...prev, { contact_id: c.id, name: c.full_name || c.email, email: c.email }]);
    setPanelQuery('');
  };
  const removePanelMember = (idx: number) => {
    setPanel((prev) => prev.filter((_, i) => i !== idx));
  };

  const save = async (): Promise<InterviewRow | null> => {
    setSaving(true);
    try {
      const primaryContact = interviewerContactId ? contactById[interviewerContactId] : null;
      const payload = {
        send_out_id: sendOutId,
        round,
        interview_type: interviewType,
        stage: stage || DEFAULT_STAGE,
        scheduled_at: scheduledAtIso,
        timezone,
        location: location || null,
        meeting_link: meetingLink || null,
        interviewer_contact_id: interviewerContactId,
        interviewer_name: (primaryContact?.full_name as string | null) ?? null,
        interviewer_title: (primaryContact?.title as string | null) ?? null,
        interviewer_company: (primaryContact?.companies?.name as string | null) ?? null,
        additional_interviewers: panel as unknown as Json,
      };

      let saved: InterviewRow | null = null;
      if (interview?.id) {
        const { data, error } = await supabase
          .from('interviews')
          .update(payload)
          .eq('id', interview.id)
          .select()
          .single();
        if (error) throw error;
        saved = data as unknown as InterviewRow;
      } else {
        const { data, error } = await supabase
          .from('interviews')
          .insert(payload)
          .select()
          .single();
        if (error) throw error;
        saved = data as unknown as InterviewRow;
      }

      toast.success(interview?.id ? 'Interview updated' : 'Interview scheduled');
      onSaved?.();
      return saved;
    } catch (err: any) {
      toast.error(err?.message || 'Failed to save interview');
      return null;
    } finally {
      setSaving(false);
    }
  };

  const saveAndClose = async () => {
    const result = await save();
    if (result) onClose();
  };

  const createCalendarEvent = async () => {
    if (!scheduledAtIso) {
      toast.error('Set a date and time first');
      return;
    }
    setCreatingEvent(true);
    try {
      // Persist first so we have an id to attach the event to.
      const saved = await save();
      if (!saved) return;

      const primary = interviewerContactId ? contactById[interviewerContactId] : null;
      const attendees: Array<{ email: string; name?: string }> = [];
      if (primary?.email) attendees.push({ email: primary.email, name: primary.full_name });
      for (const m of panel) {
        if (m.email) attendees.push({ email: m.email, name: m.name });
      }

      const { data, error } = await supabase.functions.invoke('create-calendar-event', {
        body: {
          interview_id: saved.id,
          send_out_id: sendOutId,
          subject: `${INTERVIEW_TYPE_LABEL[interviewType as keyof typeof INTERVIEW_TYPE_LABEL] ?? interviewType} — Round ${round}`,
          start: scheduledAtIso,
          timezone,
          location: location || meetingLink || undefined,
          meeting_link: meetingLink || undefined,
          attendees,
        },
      });
      if (error) throw error;

      const d = (data as any) ?? {};
      const calendarEventId = d.event_id ?? d.id ?? null;
      const calendarEventUrl = d.event_url ?? d.url ?? null;
      if (calendarEventId || calendarEventUrl) {
        await supabase
          .from('interviews')
          .update({
            calendar_event_id: calendarEventId,
            calendar_event_url: calendarEventUrl,
            calendar_synced_at: new Date().toISOString(),
          })
          .eq('id', saved.id);
      }
      toast.success('Calendar event created');
      onSaved?.();
      onClose();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to create calendar event');
    } finally {
      setCreatingEvent(false);
    }
  };

  const selectedInterviewer = interviewerContactId ? contactById[interviewerContactId] : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{interview ? 'Edit Interview' : 'Schedule Interview'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Round</Label>
              <Input
                type="number"
                min={1}
                value={round}
                onChange={(e) => setRound(parseInt(e.target.value, 10) || 1)}
              />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label className="text-xs">Type</Label>
              <Select value={interviewType} onValueChange={setInterviewType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {INTERVIEW_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{INTERVIEW_TYPE_LABEL[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Stage / label</Label>
            <Input
              value={stage}
              onChange={(e) => setStage(e.target.value)}
              placeholder="e.g. First round, System design, Debrief"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Date</Label>
              <Input
                type="date"
                value={scheduledDate}
                onChange={(e) => setScheduledDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Time</Label>
              <Input
                type="time"
                value={scheduledTime}
                onChange={(e) => setScheduledTime(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Timezone</Label>
              <Input
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="America/Los_Angeles"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Location</Label>
              <Input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Office, address…"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Meeting link</Label>
              <Input
                value={meetingLink}
                onChange={(e) => setMeetingLink(e.target.value)}
                placeholder="https://…"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Primary interviewer</Label>
            <Popover open={interviewerPickerOpen} onOpenChange={setInterviewerPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  role="combobox"
                  className="w-full justify-between font-normal"
                >
                  {selectedInterviewer
                    ? (selectedInterviewer.full_name || selectedInterviewer.email)
                    : 'Search contacts…'}
                  <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
                <Command>
                  <CommandInput placeholder="Search contacts…" />
                  <CommandEmpty>No contact found.</CommandEmpty>
                  <CommandGroup className="max-h-60 overflow-auto">
                    {(contacts as any[]).slice(0, 50).map((c) => (
                      <CommandItem
                        key={c.id}
                        value={`${c.full_name || ''} ${c.email || ''}`}
                        onSelect={() => {
                          setInterviewerContactId(c.id);
                          setInterviewerPickerOpen(false);
                        }}
                      >
                        <Check
                          className={cn(
                            'mr-2 h-3.5 w-3.5',
                            interviewerContactId === c.id ? 'opacity-100' : 'opacity-0',
                          )}
                        />
                        <span className="truncate">{c.full_name || c.email}</span>
                        {c.companies?.name && (
                          <span className="ml-auto text-[10px] text-muted-foreground truncate">
                            {c.companies.name}
                          </span>
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Panel members</Label>
            <div className="flex flex-wrap gap-1.5">
              {panel.map((m, idx) => (
                <Badge key={`${m.contact_id ?? 'm'}-${idx}`} variant="outline" className="gap-1 pl-2 pr-1">
                  {m.name}
                  <button
                    type="button"
                    onClick={() => removePanelMember(idx)}
                    className="p-0.5 hover:bg-muted rounded"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
            <div className="relative">
              <Input
                value={panelQuery}
                onChange={(e) => setPanelQuery(e.target.value)}
                placeholder="Add panelist…"
              />
              {panelQuery && filteredPanelCandidates.length > 0 && (
                <div className="absolute z-10 mt-1 w-full rounded-md border border-border bg-popover shadow-md">
                  {filteredPanelCandidates.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => addPanelMember(c)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted"
                    >
                      <Plus className="h-3 w-3" />
                      <span className="truncate">{c.full_name || c.email}</span>
                      {c.email && c.full_name && (
                        <span className="ml-auto text-[10px] text-muted-foreground">{c.email}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            type="button"
            variant="outline"
            onClick={createCalendarEvent}
            disabled={creatingEvent || saving}
          >
            {creatingEvent ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <CalendarPlus className="h-3.5 w-3.5 mr-1" />
            )}
            Create Calendar Event
          </Button>
          <Button
            type="button"
            onClick={saveAndClose}
            disabled={saving}
            className="bg-emerald-700 hover:bg-emerald-800 text-white"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default InterviewModal;
