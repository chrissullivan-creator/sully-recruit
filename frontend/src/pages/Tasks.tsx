import { useState, useMemo } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { useTasks, useBulkUpdateTasks, useBulkDeleteTasks } from '@/hooks/useTasks';
import { useQueryClient } from '@tanstack/react-query';
import { TaskCard } from '@/components/tasks/TaskCard';
import { CreateTaskDialog } from '@/components/tasks/CreateTaskDialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Plus, Search, ListTodo, CheckCheck, Trash2, Calendar, List, RefreshCw, Video, Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { isPast, format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, isSameMonth, addMonths, subMonths, startOfWeek, endOfWeek } from 'date-fns';
import { cn } from '@/lib/utils';
import { invalidateTaskScope } from '@/lib/invalidate';
import { authHeaders } from '@/lib/api-auth';

const ADMIN_EMAILS = [
  'chris.sullivan@emeraldrecruit.com',
  'emeraldrecruit@theemeraldrecruitinggroup.com',
];

const statusFilters = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'overdue', label: 'Overdue' },
];

const assignmentFilters = [
  { value: 'all', label: 'All Tasks' },
  { value: 'assigned_to_me', label: 'Assigned to Me' },
  { value: 'created_by_me', label: 'Created by Me' },
];

const priorityColors: Record<string, string> = {
  high: 'bg-destructive/10 text-destructive border-destructive/20',
  medium: 'bg-warning/10 text-warning border-warning/20',
  low: 'bg-muted text-muted-foreground border-border',
};

// ---- Calendar View ----
function CalendarView({ tasks, isAdmin }: { tasks: any[]; isAdmin: boolean }) {
  const [currentMonth, setCurrentMonth] = useState(new Date());

  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const calStart = startOfWeek(monthStart);
  const calEnd = endOfWeek(monthEnd);
  const days = eachDayOfInterval({ start: calStart, end: calEnd });

  const tasksByDate = useMemo(() => {
    const map = new Map<string, any[]>();
    tasks.forEach(t => {
      if (!t.due_date) return;
      const key = format(new Date(t.due_date), 'yyyy-MM-dd');
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    });
    return map;
  }, [tasks]);

  const today = new Date();

  return (
    <div>
      {/* Month nav */}
      <div className="flex items-center justify-between mb-4">
        <Button variant="ghost" size="sm" onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}>
          ← Prev
        </Button>
        <h3 className="text-sm font-semibold text-foreground">
          {format(currentMonth, 'MMMM yyyy')}
          {isAdmin && <Badge variant="secondary" className="ml-2 text-[9px]">Master Calendar</Badge>}
        </h3>
        <Button variant="ghost" size="sm" onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}>
          Next →
        </Button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 gap-px mb-1">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
          <div key={d} className="text-[10px] font-semibold text-muted-foreground text-center py-1 uppercase tracking-wider">
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden">
        {days.map((day) => {
          const key = format(day, 'yyyy-MM-dd');
          const dayTasks = tasksByDate.get(key) || [];
          const isToday = isSameDay(day, today);
          const inMonth = isSameMonth(day, currentMonth);
          const overdue = dayTasks.filter(t => t.status !== 'completed' && isPast(new Date(t.due_date)) && !isSameDay(new Date(t.due_date), today));

          return (
            <div
              key={key}
              className={cn(
                'min-h-[90px] bg-card p-1.5 transition-colors',
                !inMonth && 'bg-muted/30',
                isToday && 'ring-1 ring-inset ring-accent/50',
              )}
            >
              <div className={cn(
                'text-xs font-medium mb-1',
                isToday ? 'text-accent font-bold' : inMonth ? 'text-foreground' : 'text-muted-foreground/50'
              )}>
                {format(day, 'd')}
              </div>
              <div className="space-y-0.5">
                {dayTasks.slice(0, 3).map(t => {
                  const isMeeting = (t as any).task_type === 'meeting';
                  const isOutlook = t.title.startsWith('📅');
                  return (
                    <div
                      key={t.id}
                      className={cn(
                        'text-[10px] leading-tight px-1 py-0.5 rounded truncate border',
                        t.status === 'completed'
                          ? 'bg-muted/50 text-muted-foreground line-through border-transparent'
                          : isMeeting
                            ? 'bg-info/10 text-info border-info/20'
                            : isOutlook
                              ? 'bg-blue-500/10 text-blue-400 border-blue-400/20'
                              : priorityColors[t.priority] || priorityColors.medium,
                      )}
                      title={`${isMeeting ? '🗓 ' : ''}${t.title}${t.assignee_name ? ` — ${t.assignee_name}` : ''}${(t as any).start_time ? ` @ ${format(new Date((t as any).start_time), 'h:mm a')}` : ''}`}
                    >
                      {isMeeting && '🗓 '}{t.assignee_name ? `${t.assignee_name.split(' ')[0]}: ` : ''}{t.title}
                    </div>
                  );
                })}
                {dayTasks.length > 3 && (
                  <div className="text-[9px] text-muted-foreground text-center">
                    +{dayTasks.length - 3} more
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Main Page ----
export default function Tasks() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: allTasks = [], isLoading } = useTasks();
  const bulkUpdate = useBulkUpdateTasks();
  const bulkDelete = useBulkDeleteTasks();
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<'task' | 'meeting'>('task');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [assignmentFilter, setAssignmentFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'task' | 'meeting'>('all');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [viewTab, setViewTab] = useState<'list' | 'calendar'>('list');
  const [outlookSyncing, setOutlookSyncing] = useState(false);

  const isAdmin = ADMIN_EMAILS.includes(user?.email?.toLowerCase() || '');

  const filtered = allTasks.filter((t) => {
    if (search && !t.title.toLowerCase().includes(search.toLowerCase()) && !t.description?.toLowerCase().includes(search.toLowerCase())) return false;
    if (statusFilter === 'overdue') {
      if (t.status === 'completed' || !t.due_date || !isPast(new Date(t.due_date))) return false;
    } else if (statusFilter !== 'all' && t.status !== statusFilter) return false;

    // Type filter (task vs meeting)
    if (typeFilter !== 'all') {
      const taskType = (t as any).task_type || 'task';
      if (taskType !== typeFilter) return false;
    }

    // Non-admin: only show own tasks
    if (!isAdmin) {
      if (assignmentFilter === 'assigned_to_me' && t.assigned_to !== user?.id) return false;
      if (assignmentFilter === 'created_by_me' && t.created_by !== user?.id) return false;
      if (assignmentFilter === 'all' && t.assigned_to !== user?.id && t.created_by !== user?.id) return false;
    } else {
      if (assignmentFilter === 'assigned_to_me' && t.assigned_to !== user?.id) return false;
      if (assignmentFilter === 'created_by_me' && t.created_by !== user?.id) return false;
    }
    return true;
  });

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const toggleAll = () => {
    if (selectedIds.length === filtered.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filtered.map((t) => t.id));
    }
  };

  const handleBulkComplete = () => {
    bulkUpdate.mutate(
      { taskIds: selectedIds, updates: { status: 'completed' } },
      { onSuccess: () => { toast.success(`${selectedIds.length} tasks marked complete`); setSelectedIds([]); } }
    );
  };

  const handleBulkDelete = () => {
    bulkDelete.mutate(selectedIds, {
      onSuccess: () => setSelectedIds([]),
    });
  };

  const isBusy = bulkUpdate.isPending || bulkDelete.isPending;

  return (
    <MainLayout>
      <PageHeader title="To-Do's" description={`${filtered.length} task${filtered.length !== 1 ? 's' : ''}${isAdmin ? ' · Master View' : ''}`} actions={
        <div className="flex items-center gap-2">
          <div className="flex items-center border border-border rounded-lg overflow-hidden">
            <button
              onClick={() => setViewTab('list')}
              className={cn('p-2 transition-colors', viewTab === 'list' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              <List className="h-4 w-4" />
            </button>
            <button
              onClick={() => setViewTab('calendar')}
              className={cn('p-2 transition-colors', viewTab === 'calendar' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              <Calendar className="h-4 w-4" />
            </button>
          </div>
          <Button variant="ghost" size="sm" disabled={outlookSyncing} onClick={async () => {
            if (outlookSyncing) return;
            setOutlookSyncing(true);
            try {
              const resp = await fetch('/api/trigger-sync-outlook', { method: 'POST', headers: await authHeaders() });
              const data = await resp.json();
              if (data.error) { toast.error(data.error); return; }
              toast.success('Outlook sync triggered — events will appear shortly');
              setTimeout(() => invalidateTaskScope(queryClient), 8000);
            } catch (err: any) {
              toast.error(err.message || 'Sync failed');
            } finally {
              setOutlookSyncing(false);
            }
          }}>
            {outlookSyncing
              ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              : <RefreshCw className="h-4 w-4 mr-1" />}
            Outlook Sync
          </Button>
          <Button variant="outline" onClick={() => { setCreateMode('meeting'); setCreateOpen(true); }}>
            <Video className="h-4 w-4 mr-1" /> New Meeting
          </Button>
          <Button variant="gold" onClick={() => { setCreateMode('task'); setCreateOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" /> New Task
          </Button>
        </div>
      } />

      <div className="bg-page-bg min-h-[calc(100vh-4rem)] p-6 space-y-4">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search tasks…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {statusFilters.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={assignmentFilter} onValueChange={setAssignmentFilter}>
            <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {assignmentFilters.map((a) => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
              {isAdmin && <SelectItem value="all_team">All Team</SelectItem>}
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as any)}>
            <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="task">Tasks</SelectItem>
              <SelectItem value="meeting">Meetings</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Bulk actions bar */}
        {selectedIds.length > 0 && viewTab === 'list' && (
          <div className="flex items-center gap-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-2.5">
            <span className="text-sm font-medium text-foreground">{selectedIds.length} selected</span>
            <div className="h-4 w-px bg-border" />
            <Button variant="ghost" size="sm" onClick={handleBulkComplete} disabled={isBusy}>
              <CheckCheck className="h-3.5 w-3.5 mr-1" /> Mark Complete
            </Button>
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={handleBulkDelete} disabled={isBusy}>
              <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
            </Button>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => setSelectedIds([])}>Clear</Button>
          </div>
        )}

        {/* Content */}
        {isLoading ? (
          <p className="text-sm text-muted-foreground py-8 text-center">Loading tasks…</p>
        ) : viewTab === 'calendar' ? (
          <CalendarView tasks={filtered} isAdmin={isAdmin} />
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 space-y-2">
            <ListTodo className="h-10 w-10 mx-auto text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No tasks match your filters</p>
          </div>
        ) : (
          <div className="space-y-2 max-w-3xl">
            <div className="flex items-center gap-2 px-3 py-1">
              <Checkbox
                checked={selectedIds.length === filtered.length && filtered.length > 0}
                onCheckedChange={toggleAll}
              />
              <span className="text-xs text-muted-foreground">Select all</span>
            </div>
            {filtered.map((task) => (
              <div key={task.id} className="flex items-start gap-2">
                <Checkbox
                  checked={selectedIds.includes(task.id)}
                  onCheckedChange={() => toggleSelect(task.id)}
                  className="mt-3.5"
                />
                <div className="flex-1">
                  <TaskCard task={task} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <CreateTaskDialog open={createOpen} onOpenChange={setCreateOpen} defaultMode={createMode} />
    </MainLayout>
  );
}
