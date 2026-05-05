import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useProfiles } from '@/hooks/useProfiles';
import { useAuth } from '@/contexts/AuthContext';
import {
  format, startOfDay, endOfWeek, isSameDay, parseISO, isToday, addDays,
} from 'date-fns';
import { Calendar, MapPin, Video, ExternalLink, Users as UsersIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface MeetingRow {
  id: string;
  title: string;
  start_time: string | null;
  end_time: string | null;
  due_date: string | null;
  task_type: string | null;
  location: string | null;
  meeting_url: string | null;
  assigned_to: string | null;
  status: string | null;
}

function useWeekMeetings() {
  const start = startOfDay(new Date());
  const end = endOfWeek(start, { weekStartsOn: 1 });

  return useQuery({
    queryKey: ['dashboard_week_meetings', start.toISOString().slice(0, 10)],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tasks')
        .select('id,title,start_time,end_time,due_date,task_type,location,meeting_url,assigned_to,status')
        .eq('task_type', 'meeting')
        .gte('start_time', start.toISOString())
        .lte('start_time', end.toISOString())
        .order('start_time', { ascending: true });
      if (error) throw error;
      return (data ?? []) as MeetingRow[];
    },
    staleTime: 60_000,
  });
}

export function WeekCalendar() {
  const { user } = useAuth();
  const { data: profiles = [] } = useProfiles();
  const { data: meetings = [], isLoading } = useWeekMeetings();
  const navigate = useNavigate();

  const today = startOfDay(new Date());
  const weekEnd = endOfWeek(today, { weekStartsOn: 1 });

  // Build day list from today through end-of-week.
  const days = useMemo(() => {
    const out: Date[] = [];
    let d = today;
    while (d <= weekEnd) {
      out.push(d);
      d = addDays(d, 1);
    }
    return out;
  }, [today, weekEnd]);

  const profileById = useMemo(() => {
    const m = new Map<string, { name: string; email: string | null }>();
    for (const p of profiles) m.set(p.id, { name: p.full_name || p.email || 'Unknown', email: p.email });
    return m;
  }, [profiles]);

  const meetingsByOwner = useMemo(() => {
    const m = new Map<string, MeetingRow[]>();
    for (const meeting of meetings) {
      const ownerId = meeting.assigned_to || 'unassigned';
      if (!m.has(ownerId)) m.set(ownerId, []);
      m.get(ownerId)!.push(meeting);
    }
    return m;
  }, [meetings]);

  // Order: current user first, then others alphabetical.
  const owners = useMemo(() => {
    const ids = Array.from(meetingsByOwner.keys());
    return ids.sort((a, b) => {
      if (a === user?.id) return -1;
      if (b === user?.id) return 1;
      const an = profileById.get(a)?.name || a;
      const bn = profileById.get(b)?.name || b;
      return an.localeCompare(bn);
    });
  }, [meetingsByOwner, user?.id, profileById]);

  return (
    <div className="rounded-lg border border-card-border bg-card overflow-hidden">
      <div className="px-5 py-3 border-b border-card-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar className="h-4 w-4 text-emerald" />
          <h2 className="text-sm font-display font-semibold text-emerald-dark">This week</h2>
          <span className="text-xs text-muted-foreground">
            {format(today, 'MMM d')} – {format(weekEnd, 'MMM d')}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/calendar')}>
          View calendar
        </Button>
      </div>

      {isLoading ? (
        <p className="px-5 py-8 text-sm text-muted-foreground text-center">Loading…</p>
      ) : meetings.length === 0 ? (
        <p className="px-5 py-8 text-sm text-muted-foreground text-center">
          No meetings scheduled for the rest of the week.
        </p>
      ) : (
        <div className="divide-y divide-card-border">
          {owners.map((ownerId) => {
            const owner = profileById.get(ownerId);
            const ownerMeetings = meetingsByOwner.get(ownerId) ?? [];
            return (
              <UserRow
                key={ownerId}
                ownerName={ownerId === user?.id ? 'You' : (owner?.name || 'Unassigned')}
                meetings={ownerMeetings}
                days={days}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function UserRow({ ownerName, meetings, days }: { ownerName: string; meetings: MeetingRow[]; days: Date[] }) {
  const meetingsByDay = useMemo(() => {
    const m = new Map<string, MeetingRow[]>();
    for (const d of days) m.set(format(d, 'yyyy-MM-dd'), []);
    for (const meeting of meetings) {
      const start = meeting.start_time ? parseISO(meeting.start_time) : null;
      if (!start) continue;
      const key = format(start, 'yyyy-MM-dd');
      if (m.has(key)) m.get(key)!.push(meeting);
    }
    return m;
  }, [meetings, days]);

  return (
    <div className="px-5 py-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-7 w-7 rounded-full bg-emerald-light text-emerald-dark flex items-center justify-center text-[11px] font-semibold">
          {ownerName.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()}
        </div>
        <p className="text-sm font-medium text-foreground">{ownerName}</p>
        <span className="text-xs text-muted-foreground ml-auto">
          {meetings.length} meeting{meetings.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-7 gap-2">
        {days.map((day) => {
          const key = format(day, 'yyyy-MM-dd');
          const dayMeetings = meetingsByDay.get(key) ?? [];
          const today = isToday(day);
          return (
            <div
              key={key}
              className={cn(
                'rounded-lg border bg-page-bg/40 p-2 min-h-[80px] flex flex-col gap-1',
                today ? 'border-emerald' : 'border-card-border',
              )}
            >
              <div className={cn(
                'flex items-center justify-between text-[10px] font-display font-semibold uppercase tracking-wider mb-1',
                today ? 'text-emerald' : 'text-muted-foreground',
              )}>
                <span>{format(day, 'EEE')}</span>
                <span className="text-base font-bold tabular-nums">{format(day, 'd')}</span>
              </div>
              {dayMeetings.length === 0 ? (
                <p className="text-[10px] text-muted-foreground/50 italic">No events</p>
              ) : dayMeetings.slice(0, 4).map((m) => {
                const start = m.start_time ? parseISO(m.start_time) : null;
                return (
                  <div key={m.id} className="text-[10px] leading-tight bg-emerald-light/40 border border-emerald/20 rounded px-1.5 py-1">
                    {start && <p className="font-semibold tabular-nums text-emerald-dark">{format(start, 'h:mm a')}</p>}
                    <p className="truncate text-foreground">{m.title.replace(/^📅\s*/, '')}</p>
                  </div>
                );
              })}
              {dayMeetings.length > 4 && (
                <p className="text-[10px] text-muted-foreground italic">+{dayMeetings.length - 4} more</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
