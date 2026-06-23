import type { Dispatch, SetStateAction } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { authHeaders } from '@/lib/api-auth';
import { SCHEDULE_DAYS, COMMON_TIMEZONES, defaultWorkingHours } from '@/components/settings/settings-constants';
import type { SchedulingLink } from '@/components/settings/settings-types';

interface SchedulingSectionProps {
  schedLink: SchedulingLink | null;
  setSchedLink: Dispatch<SetStateAction<SchedulingLink | null>>;
  schedLoaded: boolean;
  schedSaving: boolean;
  setSchedSaving: Dispatch<SetStateAction<boolean>>;
}

export function SchedulingSection({
  schedLink,
  setSchedLink,
  schedLoaded,
  schedSaving,
  setSchedSaving,
}: SchedulingSectionProps) {
  const schedDraft: SchedulingLink = schedLink ?? {
    id: '',
    slug: '',
    title: '',
    duration_min: 30,
    meeting_type: 'phone',
    location: '',
    timezone: 'America/New_York',
    working_hours: defaultWorkingHours,
    buffer_min: 0,
    min_notice_hours: 12,
    max_days_out: 21,
    active: true,
  };

  const updateSchedDraft = (patch: Partial<SchedulingLink>) => {
    setSchedLink((prev) => ({ ...(prev ?? schedDraft), ...patch }));
  };

  const toggleSchedDay = (dayKey: string, enabled: boolean) => {
    const wh = { ...(schedDraft.working_hours ?? {}) };
    wh[dayKey] = enabled ? [{ start: '09:00', end: '17:00' }] : [];
    updateSchedDraft({ working_hours: wh });
  };

  const updateSchedDayWindow = (dayKey: string, field: 'start' | 'end', value: string) => {
    const wh = { ...(schedDraft.working_hours ?? {}) };
    const win = wh[dayKey]?.[0] ?? { start: '09:00', end: '17:00' };
    wh[dayKey] = [{ ...win, [field]: value }];
    updateSchedDraft({ working_hours: wh });
  };

  const saveScheduling = async () => {
    setSchedSaving(true);
    try {
      const exists = !!schedLink?.id;
      const payload = {
        title: schedDraft.title,
        duration_min: schedDraft.duration_min,
        meeting_type: schedDraft.meeting_type,
        location: schedDraft.location,
        timezone: schedDraft.timezone,
        working_hours: schedDraft.working_hours,
        buffer_min: schedDraft.buffer_min,
        min_notice_hours: schedDraft.min_notice_hours,
        max_days_out: schedDraft.max_days_out,
        active: schedDraft.active,
        ...(exists ? { id: schedLink!.id } : {}),
      };
      const res = await fetch('/api/schedule-links', {
        method: exists ? 'PATCH' : 'POST',
        headers: await authHeaders(),
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      setSchedLink(data.link as SchedulingLink);
      toast.success('Scheduling settings saved');
    } catch (err: any) {
      toast.error(err.message || 'Failed to save scheduling settings');
    } finally {
      setSchedSaving(false);
    }
  };

  const bookingUrl = schedLink?.slug
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/book/${schedLink.slug}`
    : '';

  return (
                  <div>
                    <div className="mb-6">
                      <h2 className="text-lg font-semibold text-foreground mb-1">Scheduling</h2>
                      <p className="text-sm text-muted-foreground">
                        Share a personal booking page. Invitees pick an open time from your Outlook calendar and the meeting lands on both calendars automatically.
                      </p>
                    </div>

                    {!schedLoaded ? (
                      <div className="flex items-center gap-2 text-muted-foreground py-8">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                      </div>
                    ) : (
                      <div className="space-y-6">
                        {/* Shareable link */}
                        <div className="rounded-lg border border-border bg-card p-5 space-y-3">
                          <div className="flex items-center justify-between">
                            <h3 className="text-sm font-medium text-foreground">Your booking link</h3>
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground">Active</span>
                              <Switch
                                checked={schedDraft.active}
                                onCheckedChange={(v) => updateSchedDraft({ active: v })}
                              />
                            </div>
                          </div>
                          {bookingUrl ? (
                            <div className="flex items-center gap-2">
                              <Input readOnly value={bookingUrl} className="font-mono text-xs" />
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  navigator.clipboard.writeText(bookingUrl);
                                  toast.success('Link copied');
                                }}
                              >
                                <Copy className="h-3.5 w-3.5 mr-1" /> Copy
                              </Button>
                              <a href={bookingUrl} target="_blank" rel="noreferrer">
                                <Button variant="ghost" size="sm">Preview</Button>
                              </a>
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              Save below to generate your link (e.g. <code className="text-[11px]">/book/your-name</code>).
                            </p>
                          )}
                        </div>

                        {/* Meeting details */}
                        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
                          <h3 className="text-sm font-medium text-foreground">Meeting details</h3>
                          <div className="space-y-1.5">
                            <Label className="text-xs">Title</Label>
                            <Input
                              value={schedDraft.title ?? ''}
                              onChange={(e) => updateSchedDraft({ title: e.target.value })}
                              placeholder="Intro call"
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-1.5">
                              <Label className="text-xs">Duration</Label>
                              <Select
                                value={String(schedDraft.duration_min)}
                                onValueChange={(v) => updateSchedDraft({ duration_min: parseInt(v, 10) })}
                              >
                                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  {[15, 20, 30, 45, 60, 90].map((m) => (
                                    <SelectItem key={m} value={String(m)}>{m} minutes</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs">Meeting type</Label>
                              <Select
                                value={schedDraft.meeting_type}
                                onValueChange={(v) => updateSchedDraft({ meeting_type: v as SchedulingLink['meeting_type'] })}
                              >
                                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="phone">Phone call</SelectItem>
                                  <SelectItem value="teams">Microsoft Teams</SelectItem>
                                  <SelectItem value="in_person">In person</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          </div>
                          {(schedDraft.meeting_type === 'in_person' || schedDraft.meeting_type === 'phone') && (
                            <div className="space-y-1.5">
                              <Label className="text-xs">
                                {schedDraft.meeting_type === 'in_person' ? 'Location' : 'Phone note (optional)'}
                              </Label>
                              <Input
                                value={schedDraft.location ?? ''}
                                onChange={(e) => updateSchedDraft({ location: e.target.value })}
                                placeholder={schedDraft.meeting_type === 'in_person' ? 'Office address' : "We'll call the number you provide"}
                              />
                            </div>
                          )}
                          <div className="space-y-1.5">
                            <Label className="text-xs">Timezone</Label>
                            <Select
                              value={schedDraft.timezone}
                              onValueChange={(v) => updateSchedDraft({ timezone: v })}
                            >
                              <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {COMMON_TIMEZONES.map((tz) => (
                                  <SelectItem key={tz} value={tz}>{tz.replace(/_/g, ' ')}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        {/* Working hours */}
                        <div className="rounded-lg border border-border bg-card p-5 space-y-3">
                          <h3 className="text-sm font-medium text-foreground">Working hours</h3>
                          <p className="text-xs text-muted-foreground">
                            Slots are only offered inside these windows (in your timezone), minus anything already on your calendar.
                          </p>
                          <div className="space-y-2">
                            {SCHEDULE_DAYS.map((day) => {
                              const windows = schedDraft.working_hours?.[day.key] ?? [];
                              const enabled = windows.length > 0;
                              const win = windows[0] ?? { start: '09:00', end: '17:00' };
                              return (
                                <div key={day.key} className="flex items-center gap-3">
                                  <div className="flex items-center gap-2 w-24">
                                    <Switch
                                      checked={enabled}
                                      onCheckedChange={(v) => toggleSchedDay(day.key, v)}
                                    />
                                    <span className="text-sm text-foreground">{day.label}</span>
                                  </div>
                                  {enabled ? (
                                    <div className="flex items-center gap-2">
                                      <Input
                                        type="time"
                                        value={win.start}
                                        onChange={(e) => updateSchedDayWindow(day.key, 'start', e.target.value)}
                                        className="h-8 w-28 text-sm"
                                      />
                                      <span className="text-xs text-muted-foreground">to</span>
                                      <Input
                                        type="time"
                                        value={win.end}
                                        onChange={(e) => updateSchedDayWindow(day.key, 'end', e.target.value)}
                                        className="h-8 w-28 text-sm"
                                      />
                                    </div>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">Unavailable</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        {/* Booking rules */}
                        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
                          <h3 className="text-sm font-medium text-foreground">Booking rules</h3>
                          <div className="grid grid-cols-3 gap-4">
                            <div className="space-y-1.5">
                              <Label className="text-xs">Buffer (min)</Label>
                              <Input
                                type="number"
                                min={0}
                                value={schedDraft.buffer_min}
                                onChange={(e) => updateSchedDraft({ buffer_min: parseInt(e.target.value) || 0 })}
                                className="h-9"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs">Min notice (hrs)</Label>
                              <Input
                                type="number"
                                min={0}
                                value={schedDraft.min_notice_hours}
                                onChange={(e) => updateSchedDraft({ min_notice_hours: parseInt(e.target.value) || 0 })}
                                className="h-9"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs">Days out</Label>
                              <Input
                                type="number"
                                min={1}
                                value={schedDraft.max_days_out}
                                onChange={(e) => updateSchedDraft({ max_days_out: parseInt(e.target.value) || 1 })}
                                className="h-9"
                              />
                            </div>
                          </div>
                        </div>

                        <div className="flex justify-end">
                          <Button variant="gold" size="sm" disabled={schedSaving} onClick={saveScheduling}>
                            {schedSaving ? (
                              <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Saving…</>
                            ) : (
                              'Save Scheduling'
                            )}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
  );
}
