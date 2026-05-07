import { useMemo, useState } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { invalidateTaskScope } from '@/lib/invalidate';
import { authHeaders } from '@/lib/api-auth';
import { useAuth } from '@/contexts/AuthContext';
import { useProfiles } from '@/hooks/useProfiles';
import { toast } from 'sonner';
import {
  Calendar as CalendarIcon, ChevronLeft, ChevronRight, RefreshCw,
  MapPin, Video, Users as UsersIcon, ExternalLink, Clock, CalendarPlus, Loader2,
} from 'lucide-react';
import { ScheduleMeetingDialog } from '@/components/calendar/ScheduleMeetingDialog';
import { MeetingDetailDialog, type MeetingTask } from '@/components/calendar/MeetingDetailDialog';
import {
  format, startOfWeek, endOfWeek, addDays, addWeeks, subWeeks,
  isSameDay, isToday, eachDayOfInterval, parseISO, isWithinInterval,
} from 'date-fns';
import { cn } from '@/lib/utils';

interface CalendarTask {
  id: string;
  title: string;
  description: string | null;
  start_time: string | null;
  end_time: string | null;
  due_date: string | null;
  timezone: string | null;
  task_type: string | null;
  location: string | null;
  meeting_url: string | null;
  assigned_to: string | null;
  external_id: string | null;
  status: string | null;
}

type ViewMode = 'week' | 'day';

function useCalendarTasks(rangeStart: Date, rangeEnd: Date, ownerId: string | null) {
  return useQuery({
    queryKey: ['calendar_tasks', rangeStart.toISOString(), rangeEnd.toISOString(), ownerId],
    queryFn: async () => {
      let q = supabase
        .from('tasks')
        .select('id,title,description,start_time,end_time,due_date,timezone,task_type,location,meeting_url,assigned_to,external_id,status')
        .eq('task_type', 'meeting')
        .or(`start_time.gte.${rangeStart.toISOString()},and(start_time.is.null,due_date.gte.${format(rangeStart, 'yyyy-MM-dd')})`)
        .lte('start_time', rangeEnd.toISOString())
        .order('start_time', { ascending: true, nullsFirst: false });
      if (ownerId) q = q.eq('assigned_to', ownerId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as CalendarTask[];
    },
    staleTime: 60_000,
  });
}

function eventStart(t: CalendarTask): Date | null {
  if (t.start_time) return parseISO(t.start_time);
  if (t.due_date)   return parseISO(t.due_date + 'T00:00:00Z');
  return null;
}

function groupByDay(tasks: CalendarTask[], days: Date[]) {
  const map = new Map<string, CalendarTask[]>();
  for (const d of days) map.set(format(d, 'yyyy-MM-dd'), []);
  for (const t of tasks) {
    const s = eventStart(t);
    if (!s) continue;
    const key = format(s, 'yyyy-MM-dd');
    if (map.has(key)) map.get(key)!.push(t);
  }
  return map;
}

export default function CalendarPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: profiles = [] } = useProfiles();

  const [viewMode, setViewMode] = useState<ViewMode>('week');
  const [anchorDate, setAnchorDate] = useState(new Date());
  const [ownerFilter, setOwnerFilter] = useState<'me' | 'all' | string>('me');
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<MeetingTask | null>(null);

  const ownerId = ownerFilter === 'me'
    ? (user?.id ?? null)
    : ownerFilter === 'all'
      ? null
      : ownerFilter;

  const rangeStart = viewMode === 'week' ? startOfWeek(anchorDate, { weekStartsOn: 1 }) : anchorDate;
  const rangeEnd = viewMode === 'week'
    ? endOfWeek(anchorDate, { weekStartsOn: 1 })
    : new Date(anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate() + 1);

  const { data: tasks = [], isLoading, refetch } = useCalendarTasks(rangeStart, rangeEnd, ownerId);

  const days = useMemo(
    () => eachDayOfInterval({ start: rangeStart, end: viewMode === 'week' ? rangeEnd : rangeStart }),
    [rangeStart, rangeEnd, viewMode],
  );

  const tasksByDay = useMemo(() => groupByDay(tasks, days), [tasks, days]);

  const [syncing, setSyncing] = useState(false);
  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const resp = await fetch('/api/trigger-sync-outlook', { method: 'POST', headers: await authHeaders() });
      const data = await resp.json();
      if (!resp.ok || data.error) throw new Error(data.error || 'Sync failed');
      toast.success('Sync triggered — events will appear in a moment');
      setTimeout(() => {
        invalidateTaskScope(queryClient);
        refetch();
      }, 8000);
    } catch (err: any) {
      toast.error(err.message || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const goPrev = () => setAnchorDate((d) => viewMode === 'week' ? subWeeks(d, 1) : addDays(d, -1));
  const goNext = () => setAnchorDate((d) => viewMode === 'week' ? addWeeks(d, 1) : addDays(d, 1));
  const goToday = () => setAnchorDate(new Date());

  const rangeLabel = viewMode === 'week'
    ? `${format(rangeStart, 'MMM d')} – ${format(rangeEnd, 'MMM d, yyyy')}`
    : format(anchorDate, 'EEEE, MMMM d, yyyy');

  return (
    <MainLayout>
      <PageHeader
        title="Calendar"
        description="Outlook calendar events synced from Microsoft 365."
        actions={
          <div className="flex items-center gap-2">
            <Select value={ownerFilter} onValueChange={setOwnerFilter}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="me">My calendar</SelectItem>
                <SelectItem value="all">Everyone</SelectItem>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.full_name || p.email}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing} className="gap-1">
              {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {syncing ? 'Syncing…' : 'Sync Outlook'}
            </Button>
            <Button variant="gold" size="sm" onClick={() => setScheduleOpen(true)} className="gap-1">
              <CalendarPlus className="h-3.5 w-3.5" /> New meeting
            </Button>
          </div>
        }
      />

      <ScheduleMeetingDialog open={scheduleOpen} onOpenChange={setScheduleOpen} />
      <MeetingDetailDialog
        task={selectedTask}
        onOpenChange={(o) => { if (!o) setSelectedTask(null); }}
      />

      <div className="bg-page-bg min-h-[calc(100vh-4rem)] p-6 lg:p-8 space-y-4">
        {/* Toolbar */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <div className="flex items-center border border-card-border rounded-lg overflow-hidden bg-white">
              <button
                onClick={() => setViewMode('day')}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium transition-colors',
                  viewMode === 'day' ? 'bg-emerald-light text-emerald-dark' : 'text-muted-foreground hover:text-foreground',
                )}
              >Day</button>
              <button
                onClick={() => setViewMode('week')}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium transition-colors',
                  viewMode === 'week' ? 'bg-emerald-light text-emerald-dark' : 'text-muted-foreground hover:text-foreground',
                )}
              >Week</button>
            </div>
            <Button variant="outline" size="sm" onClick={goToday}>Today</Button>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={goPrev}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-display font-semibold text-emerald-dark min-w-[14rem] text-center">{rangeLabel}</span>
            <Button variant="ghost" size="sm" onClick={goNext}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Body */}
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-7 gap-3">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-card-border bg-white min-h-[180px] animate-pulse">
                <div className="px-3 py-2 border-b border-card-border bg-page-bg/40 flex justify-between">
                  <div className="h-3 w-8 bg-emerald-light/60 rounded" />
                  <div className="h-3 w-4 bg-emerald-light/60 rounded" />
                </div>
                <div className="p-2 space-y-1.5">
                  <div className="h-7 bg-emerald-light/30 rounded" />
                  <div className="h-7 bg-emerald-light/30 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : viewMode === 'week' ? (
          <WeekGrid days={days} tasksByDay={tasksByDay} onSelect={setSelectedTask} />
        ) : (
          <DayList day={anchorDate} tasks={tasksByDay.get(format(anchorDate, 'yyyy-MM-dd')) ?? []} onSelect={setSelectedTask} />
        )}
      </div>
    </MainLayout>
  );
}

function WeekGrid({
  days, tasksByDay, onSelect,
}: {
  days: Date[];
  tasksByDay: Map<string, CalendarTask[]>;
  onSelect: (t: CalendarTask) => void;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-7 gap-3">
      {days.map((day) => {
        const key = format(day, 'yyyy-MM-dd');
        const items = tasksByDay.get(key) ?? [];
        const today = isToday(day);
        return (
          <div
            key={key}
            className={cn(
              'rounded-xl border bg-white overflow-hidden flex flex-col min-h-[180px]',
              today ? 'border-emerald shadow-sm' : 'border-card-border',
            )}
          >
            <div className={cn(
              'px-3 py-2 border-b text-[11px] font-display font-semibold tracking-wider uppercase flex items-center justify-between',
              today ? 'bg-emerald text-white border-emerald' : 'bg-page-bg/40 text-emerald-dark border-card-border',
            )}>
              <span>{format(day, 'EEE')}</span>
              <span className={cn('text-base font-bold tabular-nums', today ? 'text-white' : 'text-emerald-dark')}>
                {format(day, 'd')}
              </span>
            </div>

            <div className="p-2 space-y-1.5 flex-1">
              {items.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/60 italic px-1.5 py-1">No events</p>
              ) : items.map((t) => <EventCard key={t.id} task={t} compact onSelect={onSelect} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DayList({
  day, tasks, onSelect,
}: {
  day: Date;
  tasks: CalendarTask[];
  onSelect: (t: CalendarTask) => void;
}) {
  return (
    <div className="rounded-xl border border-card-border bg-white">
      <div className={cn(
        'px-4 py-3 border-b border-card-border flex items-center justify-between',
        isToday(day) && 'bg-emerald-light/30',
      )}>
        <h3 className="text-sm font-display font-semibold text-emerald-dark">
          {format(day, 'EEEE, MMMM d')}
        </h3>
        <span className="text-xs text-muted-foreground">
          {tasks.length} event{tasks.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div className="p-4 space-y-2">
        {tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">No events scheduled.</p>
        ) : tasks.map((t) => <EventCard key={t.id} task={t} onSelect={onSelect} />)}
      </div>
    </div>
  );
}

function EventCard({
  task, compact = false, onSelect,
}: {
  task: CalendarTask;
  compact?: boolean;
  onSelect: (t: CalendarTask) => void;
}) {
  const start = eventStart(task);
  const end = task.end_time ? parseISO(task.end_time) : null;
  const timeLabel = start
    ? (end ? `${format(start, 'h:mm a')} – ${format(end, 'h:mm a')}` : format(start, 'h:mm a'))
    : 'All day';
  const completed = task.status === 'completed';

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => onSelect(task)}
        className={cn(
          'w-full text-left rounded-md border px-2 py-1.5 text-[11px] leading-tight transition-colors',
          completed
            ? 'bg-muted/40 border-card-border text-muted-foreground line-through hover:bg-muted/60'
            : 'bg-emerald-light/30 border-emerald/30 text-emerald-dark hover:bg-emerald-light/60',
        )}
      >
        <p className="font-semibold tabular-nums">{timeLabel}</p>
        <p className="truncate">{task.title.replace(/^📅\s*/, '')}</p>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(task)}
      className={cn(
        'w-full text-left rounded-lg border p-3 flex items-start gap-3 transition-colors',
        completed
          ? 'bg-muted/40 border-card-border hover:bg-muted/60'
          : 'bg-emerald-light/15 border-emerald/30 hover:bg-emerald-light/30',
      )}
    >
      <div className="shrink-0 w-20 text-right">
        <p className="text-xs font-semibold tabular-nums text-emerald-dark">{start ? format(start, 'h:mm a') : 'All day'}</p>
        {end && <p className="text-[10px] text-muted-foreground tabular-nums">{format(end, 'h:mm a')}</p>}
      </div>
      <div className="flex-1 min-w-0">
        <p className={cn('text-sm font-medium', completed && 'line-through text-muted-foreground')}>
          {task.title.replace(/^📅\s*/, '')}
        </p>
        {task.description && (
          <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{task.description}</p>
        )}
        <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground flex-wrap">
          {task.location && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              {task.location}
            </span>
          )}
          {task.meeting_url && (
            <a
              href={task.meeting_url} target="_blank" rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-emerald hover:text-emerald-dark"
            >
              <Video className="h-3 w-3" /> Join
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          )}
          {task.external_id && (
            <Badge variant="outline" className="text-[9px] border-emerald/30 text-emerald-dark px-1.5 py-0">
              <CalendarIcon className="h-2.5 w-2.5 mr-0.5" /> Outlook
            </Badge>
          )}
        </div>
      </div>
    </button>
  );
}
