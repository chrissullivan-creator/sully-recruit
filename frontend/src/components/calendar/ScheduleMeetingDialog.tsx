import { useState, useEffect } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Loader2, CalendarPlus, Video, MapPin } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { addMinutes, format } from 'date-fns';
import { invalidateTaskScope } from '@/lib/invalidate';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Person to invite (candidate or contact). Their email becomes an attendee. */
  attendee?: {
    id: string;
    type: 'candidate' | 'contact';
    name: string;
    email: string | null;
  };
  /** Default subject — usually pre-filled from caller (e.g. "Intro call w/ Jane Doe"). */
  defaultSubject?: string;
  /** Default body — e.g. job/role context. */
  defaultDescription?: string;
}

function localDatetimeValue(d: Date): string {
  // <input type="datetime-local"> wants YYYY-MM-DDTHH:mm in local time.
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function nextHalfHour(d = new Date()): Date {
  const next = new Date(d);
  next.setSeconds(0, 0);
  const min = next.getMinutes();
  if (min < 30) next.setMinutes(30);
  else { next.setMinutes(0); next.setHours(next.getHours() + 1); }
  return next;
}

export function ScheduleMeetingDialog({
  open, onOpenChange, attendee,
  defaultSubject, defaultDescription,
}: Props) {
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState(defaultSubject ?? '');
  const [start, setStart] = useState(() => localDatetimeValue(nextHalfHour()));
  const [duration, setDuration] = useState(30);
  const [location, setLocation] = useState('');
  const [online, setOnline] = useState(true);
  const [description, setDescription] = useState(defaultDescription ?? '');
  const [saving, setSaving] = useState(false);

  // Reset when dialog opens with new defaults
  useEffect(() => {
    if (!open) return;
    setSubject(defaultSubject ?? (attendee ? `Meeting with ${attendee.name}` : ''));
    setDescription(defaultDescription ?? '');
    setStart(localDatetimeValue(nextHalfHour()));
    setDuration(30);
    setLocation('');
    setOnline(true);
  }, [open, defaultSubject, defaultDescription, attendee?.name]);

  const handleSave = async () => {
    if (!subject.trim()) { toast.error('Subject is required'); return; }
    setSaving(true);
    try {
      const startDate = new Date(start);
      if (isNaN(startDate.getTime())) throw new Error('Invalid start time');
      const endDate = addMinutes(startDate, duration);

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const resp = await fetch('/api/create-outlook-event', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          subject: subject.trim(),
          start_iso: startDate.toISOString(),
          end_iso: endDate.toISOString(),
          description: description.trim(),
          location: location.trim(),
          online,
          attendee_email: attendee?.email ?? null,
          attendee_name: attendee?.name ?? null,
          entity_id: attendee?.id ?? null,
          entity_type: attendee?.type ?? null,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `API error ${resp.status}`);

      toast.success(`Meeting scheduled for ${format(startDate, 'MMM d, h:mm a')}`);
      invalidateTaskScope(queryClient);
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to schedule meeting');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md bg-page-bg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display text-emerald-dark">
            <CalendarPlus className="h-4 w-4" /> Schedule meeting
          </DialogTitle>
          <DialogDescription>
            Creates an Outlook event on your calendar
            {attendee?.email && <> and invites <span className="font-medium">{attendee.name}</span></>}
            .
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Subject <span className="text-gold-deep">*</span></Label>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. Intro call w/ Jane Doe"
              className="h-9 border-card-border"
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2 space-y-1.5">
              <Label className="text-xs">Start</Label>
              <Input
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="h-9 border-card-border"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Minutes</Label>
              <Input
                type="number"
                min={5}
                step={5}
                value={duration}
                onChange={(e) => setDuration(Math.max(5, Number(e.target.value) || 30))}
                className="h-9 border-card-border tabular-nums"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1">
              <MapPin className="h-3 w-3" /> Location (optional)
            </Label>
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Phone, 123 Main St, or leave blank for Teams"
              className="h-9 border-card-border"
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-card-border bg-white px-3 py-2">
            <div className="flex items-center gap-2">
              <Video className="h-3.5 w-3.5 text-emerald" />
              <Label htmlFor="online-switch" className="text-sm cursor-pointer">Add Teams meeting link</Label>
            </div>
            <Switch id="online-switch" checked={online} onCheckedChange={setOnline} />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Notes / agenda (optional)</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Anything you want them to see in the invite…"
              className="border-card-border resize-none"
            />
          </div>

          {attendee && !attendee.email && (
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
              Note: {attendee.name} has no email on file, so the event will be created on your calendar without an invite.
            </p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button variant="gold" onClick={handleSave} disabled={saving || !subject.trim()} className="gap-1.5">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarPlus className="h-4 w-4" />}
            Schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
