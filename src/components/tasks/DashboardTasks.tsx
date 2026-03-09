import { useState } from 'react';
import { useTasks } from '@/hooks/useTasks';
import { TaskCard } from './TaskCard';
import { CreateTaskDialog } from './CreateTaskDialog';
import { Button } from '@/components/ui/button';
import { Plus, ListTodo } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { isPast } from 'date-fns';

export function DashboardTasks() {
  const { user } = useAuth();
  const { data: allTasks = [], isLoading } = useTasks();
  const [createOpen, setCreateOpen] = useState(false);
  const [tab, setTab] = useState<'pending' | 'overdue' | 'completed'>('pending');

  const myTasks = allTasks.filter(
    (t) => t.assigned_to === user?.id || t.created_by === user?.id
  );

  const pending = myTasks.filter((t) => t.status === 'pending' || t.status === 'in_progress');
  const overdue = pending.filter((t) => t.due_date && isPast(new Date(t.due_date)));
  const completed = myTasks.filter((t) => t.status === 'completed').slice(0, 5);

  const tabs = [
    { key: 'pending' as const, label: 'Pending', count: pending.length },
    { key: 'overdue' as const, label: 'Overdue', count: overdue.length },
    { key: 'completed' as const, label: 'Done', count: completed.length },
  ];

  const current = tab === 'pending' ? pending : tab === 'overdue' ? overdue : completed;
  const displayed = current.slice(0, 10);

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <ListTodo className="h-5 w-5 text-accent" />
          My Tasks
        </h2>
        <Button variant="ghost" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> New Task
        </Button>
      </div>

      <div className="flex gap-1 mb-4">
        {tabs.map((t) => (
          <Button
            key={t.key}
            variant={tab === t.key ? 'secondary' : 'ghost'}
            size="sm"
            className="text-xs"
            onClick={() => setTab(t.key)}
          >
            {t.label} ({t.count})
          </Button>
        ))}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading tasks...</p>
      ) : displayed.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {tab === 'pending' ? 'No pending tasks. Nice work!' : tab === 'overdue' ? 'No overdue tasks!' : 'No completed tasks yet.'}
        </p>
      ) : (
        <div className="space-y-2">
          {displayed.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
          {current.length > 10 && (
            <p className="text-xs text-muted-foreground text-center">
              +{current.length - 10} more tasks
            </p>
          )}
        </div>
      )}

      <CreateTaskDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
