import { useState } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { useTasks, useBulkUpdateTasks, useBulkDeleteTasks } from '@/hooks/useTasks';
import { TaskCard } from '@/components/tasks/TaskCard';
import { CreateTaskDialog } from '@/components/tasks/CreateTaskDialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Plus, Search, ListTodo, CheckCheck, Trash2, ArrowUpCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { isPast } from 'date-fns';
import { toast } from 'sonner';

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

export default function Tasks() {
  const { user } = useAuth();
  const { data: allTasks = [], isLoading } = useTasks();
  const bulkUpdate = useBulkUpdateTasks();
  const bulkDelete = useBulkDeleteTasks();
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  
  const [assignmentFilter, setAssignmentFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const filtered = allTasks.filter((t) => {
    if (search && !t.title.toLowerCase().includes(search.toLowerCase()) && !t.description?.toLowerCase().includes(search.toLowerCase())) return false;
    if (statusFilter === 'overdue') {
      if (t.status === 'completed' || !t.due_date || !isPast(new Date(t.due_date))) return false;
    } else if (statusFilter !== 'all' && t.status !== statusFilter) return false;
    
    if (assignmentFilter === 'assigned_to_me' && t.assigned_to !== user?.id) return false;
    if (assignmentFilter === 'created_by_me' && t.created_by !== user?.id) return false;
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
      <PageHeader title="Tasks" description={`${filtered.length} task${filtered.length !== 1 ? 's' : ''}`} actions={
        <Button variant="gold" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> New Task
        </Button>
      } />

      <div className="p-6 space-y-4">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search tasks..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
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
            </SelectContent>
          </Select>
        </div>

        {/* Bulk actions bar */}
        {selectedIds.length > 0 && (
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

        {/* Task list */}
        {isLoading ? (
          <p className="text-sm text-muted-foreground py-8 text-center">Loading tasks...</p>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 space-y-2">
            <ListTodo className="h-10 w-10 mx-auto text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No tasks match your filters</p>
          </div>
        ) : (
          <div className="space-y-2 max-w-3xl">
            {/* Select all */}
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

      <CreateTaskDialog open={createOpen} onOpenChange={setCreateOpen} />
    </MainLayout>
  );
}
