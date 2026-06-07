import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  CalendarDays,
  Clock,
  Loader2,
  MapPin,
  Video,
  Phone,
  Check,
  ArrowLeft,
  CalendarX,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

// ── types mirror /api/schedule/slots + /api/schedule/book ──────────────────
interface DayGroup {
  date: string; // YYYY-MM-DD (link timezone)
  slots: { start: string; end: string }[]; // UTC ISO
}
interface SlotsResponse {
  slug: string;
  title: string | null;
  timezone: string;
  duration_min: number;
  meeting_type: 'phone' | 'teams' | 'in_person';
  location: string | null;
  days: DayGroup[];
}

type Step = 'pick' | 'details' | 'done';

const MEETING_META: Record<SlotsResponse['meeting_type'], { label: string; Icon: typeof Phone }> = {
  phone: { label: 'Phone call', Icon: Phone },
  teams: { label: 'Microsoft Teams', Icon: Video },
  in_person: { label: 'In person', Icon: MapPin },
};

export default function Book() {
  const { slug } = useParams<{ slug: string }>();
  const [params] = useSearchParams();

  const [data, setData] = useState<SlotsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [step, setStep] = useState<Step>('pick');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<{ start: string; end: string } | null>(null);

  // Prefill from ?name= / ?email= / ?phone= and link the person via ?person=.
  const personId = params.get('person') || '';
  const [form, setForm] = useState({
    name: params.get('name') || '',
    email: params.get('email') || '',
    phone: params.get('phone') || '',
    notes: '',
  });

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{
    start_at: string;
    end_at: string;
    meeting_type: string;
    join_url: string | null;
  } | null>(null);

  const tz = data?.timezone || 'America/New_York';

  // ── formatters in the link's timezone ────────────────────────────────────
  const fmtTime = (iso: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));

  const fmtDayLabel = (ymd: string) => {
    // Build a noon-UTC instant for the calendar day so the weekday/label is
    // stable regardless of the viewer's own timezone.
    const d = new Date(`${ymd}T12:00:00Z`);
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(d);
  };

  const fmtConfirmed = (iso: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(iso));

  // ── load availability ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const r = await fetch(`/api/schedule/slots?slug=${encodeURIComponent(slug)}`, {
          cache: 'no-store',
        });
        const json = await r.json();
        if (!r.ok) throw new Error(json.error || 'This link is unavailable.');
        if (cancelled) return;
        setData(json as SlotsResponse);
        const firstDay = (json.days as DayGroup[])[0]?.date ?? null;
        setSelectedDate(firstDay);
      } catch (e: any) {
        if (!cancelled) setLoadError(e.message || 'Failed to load.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const slotsForDay = useMemo(
    () => data?.days.find((d) => d.date === selectedDate)?.slots ?? [],
    [data, selectedDate],
  );

  const meetingMeta = data ? MEETING_META[data.meeting_type] : MEETING_META.phone;

  const handleConfirm = async () => {
    if (!slug || !selectedSlot) return;
    if (!form.name.trim() || !form.email.trim()) {
      setSubmitError('Name and email are required.');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const r = await fetch('/api/schedule/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          start_at: selectedSlot.start,
          invitee_name: form.name.trim(),
          invitee_email: form.email.trim(),
          invitee_phone: form.phone.trim() || undefined,
          notes: form.notes.trim() || undefined,
          person_id: personId || undefined,
        }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || 'Could not book this time.');
      setConfirmed(json);
      setStep('done');
    } catch (e: any) {
      setSubmitError(e.message || 'Booking failed.');
    } finally {
      setSubmitting(false);
    }
  };

  // ── shells ────────────────────────────────────────────────────────────────
  const Shell = ({ children }: { children: React.ReactNode }) => (
    <div className="min-h-screen bg-page-bg px-4 py-8 sm:py-14">
      <div className="mx-auto w-full max-w-lg">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-emerald text-white shadow-sm">
            <CalendarDays className="h-6 w-6" />
          </div>
          <h1 className="font-display text-xl font-semibold text-emerald-dark">
            The Emerald Recruiting Group
          </h1>
        </div>
        {children}
      </div>
    </div>
  );

  if (loading) {
    return (
      <Shell>
        <div className="card-elevated p-12 text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-emerald" />
          <p className="mt-3 text-sm text-muted-foreground">Loading availability…</p>
        </div>
      </Shell>
    );
  }

  if (loadError || !data) {
    return (
      <Shell>
        <div className="card-elevated p-10 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <CalendarX className="h-6 w-6 text-muted-foreground" />
          </div>
          <h2 className="text-base font-semibold text-foreground">This link isn't available</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {loadError || 'The scheduling link may have been turned off or removed.'}
          </p>
        </div>
      </Shell>
    );
  }

  // ── success ─────────────────────────────────────────────────────────────
  if (step === 'done' && confirmed) {
    return (
      <Shell>
        <div className="card-elevated p-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-light">
            <Check className="h-7 w-7 text-emerald" />
          </div>
          <h2 className="font-display text-lg font-semibold text-emerald-dark">You're booked!</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            A calendar invite is on its way to <span className="font-medium">{form.email}</span>.
          </p>

          <div className="mt-6 rounded-lg border border-card-border bg-white p-4 text-left">
            <div className="flex items-start gap-3">
              <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-emerald" />
              <p className="text-sm font-medium text-foreground">{fmtConfirmed(confirmed.start_at)}</p>
            </div>
            <div className="mt-2 flex items-center gap-3">
              <meetingMeta.Icon className="h-4 w-4 shrink-0 text-emerald" />
              <p className="text-sm text-muted-foreground">{meetingMeta.label}</p>
            </div>
            {data.meeting_type === 'in_person' && data.location && (
              <p className="mt-1 pl-7 text-sm text-muted-foreground">{data.location}</p>
            )}
            {confirmed.join_url && (
              <a
                href={confirmed.join_url}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-emerald hover:underline"
              >
                <Video className="h-4 w-4" /> Join Teams meeting
              </a>
            )}
          </div>
        </div>
      </Shell>
    );
  }

  // ── details form ────────────────────────────────────────────────────────
  if (step === 'details' && selectedSlot) {
    return (
      <Shell>
        <div className="card-elevated overflow-hidden">
          <div className="border-b border-card-border bg-emerald-light/40 p-5">
            <button
              onClick={() => {
                setStep('pick');
                setSelectedSlot(null);
                setSubmitError(null);
              }}
              className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-emerald-dark hover:underline"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back to times
            </button>
            <h2 className="font-display text-base font-semibold text-emerald-dark">
              {data.title || 'Confirm your meeting'}
            </h2>
            <div className="mt-2 space-y-1 text-sm text-emerald-dark/80">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4" /> {fmtConfirmed(selectedSlot.start)}
              </div>
              <div className="flex items-center gap-2">
                <meetingMeta.Icon className="h-4 w-4" /> {data.duration_min} min · {meetingMeta.label}
              </div>
            </div>
          </div>

          <div className="space-y-4 p-5">
            <div className="space-y-1.5">
              <Label className="text-xs">Name *</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Your full name"
                autoComplete="name"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Email *</Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="you@company.com"
                autoComplete="email"
                inputMode="email"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Phone</Label>
              <Input
                type="tel"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder="(555) 123-4567"
                autoComplete="tel"
                inputMode="tel"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Anything we should know?</Label>
              <Textarea
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                rows={3}
                placeholder="Optional"
              />
            </div>

            {submitError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {submitError}
              </div>
            )}

            <Button
              variant="gold"
              className="w-full"
              disabled={submitting}
              onClick={handleConfirm}
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Booking…
                </>
              ) : (
                'Confirm booking'
              )}
            </Button>
          </div>
        </div>
      </Shell>
    );
  }

  // ── pick a day + time ─────────────────────────────────────────────────────
  return (
    <Shell>
      <div className="card-elevated overflow-hidden">
        <div className="border-b border-card-border p-5">
          <h2 className="font-display text-base font-semibold text-emerald-dark">
            {data.title || 'Pick a time'}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" /> {data.duration_min} min
            </span>
            <span className="flex items-center gap-1.5">
              <meetingMeta.Icon className="h-3.5 w-3.5" /> {meetingMeta.label}
            </span>
            <span>Times shown in {tz.replace(/_/g, ' ')}</span>
          </div>
        </div>

        {data.days.length === 0 ? (
          <div className="p-10 text-center">
            <CalendarX className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No times are available right now. Please check back later.
            </p>
          </div>
        ) : (
          <div className="p-5">
            {/* Day picker — horizontal scroll on mobile */}
            <div className="-mx-1 mb-5 flex gap-2 overflow-x-auto px-1 pb-1">
              {data.days.map((d) => {
                const active = d.date === selectedDate;
                return (
                  <button
                    key={d.date}
                    onClick={() => setSelectedDate(d.date)}
                    className={cn(
                      'shrink-0 rounded-lg border px-3 py-2 text-center transition-colors',
                      active
                        ? 'border-emerald bg-emerald text-white'
                        : 'border-card-border bg-white text-foreground hover:border-emerald/40',
                    )}
                  >
                    <span className="block text-xs font-medium">{fmtDayLabel(d.date)}</span>
                    <span
                      className={cn(
                        'block text-[10px]',
                        active ? 'text-white/80' : 'text-muted-foreground',
                      )}
                    >
                      {d.slots.length} {d.slots.length === 1 ? 'slot' : 'slots'}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Slots for the selected day */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {slotsForDay.map((s) => (
                <button
                  key={s.start}
                  onClick={() => {
                    setSelectedSlot(s);
                    setStep('details');
                  }}
                  className="rounded-lg border border-emerald/30 bg-white px-3 py-2.5 text-sm font-medium text-emerald-dark transition-colors hover:border-emerald hover:bg-emerald-light/50"
                >
                  {fmtTime(s.start)}
                </button>
              ))}
            </div>
            {slotsForDay.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No times left on this day — try another.
              </p>
            )}
          </div>
        )}
      </div>

      <p className="mt-4 text-center text-xs text-muted-foreground">
        Powered by Sully Recruit
      </p>
    </Shell>
  );
}
