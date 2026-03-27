import { useState } from 'react';
import { useEntityTasks } from '@/hooks/useTasks';
import { TaskCard } from './TaskCard';
import { CreateTaskDialog } from './CreateTaskDialog';
import { Button } from '@/components/ui/button';
import { Plus, ListTodo } from 'lucide-react';

interface Props {
  entityType: string;
  entityId: string;
  className?: string;
}

export function TaskSidebar({ entityType, entityId, className }: Props) {
  const { data: tasks = [], isLoading } = useEntityTasks(entityType, entityId);
  const [createOpen, setCreateOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const displayed = showAll ? tasks : tasks.slice(0, 10);

  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <ListTodo className="h-4 w-4 text-accent" />
          Tasks ({tasks.length})
        </h3>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3 w-3 mr-1" /> Add
        </Button>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading tasks...</p>
      ) : displayed.length === 0 ? (
        <p className="text-xs text-muted-foreground">No tasks linked to this record.</p>
      ) : (
        <div className="space-y-2">
          {displayed.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
          {tasks.length > 10 && !showAll && (
            <Button variant="ghost" size="sm" className="w-full text-xs" onClick={() => setShowAll(true)}>
              Show {tasks.length - 10} more
            </Button>
          )}
        </div>
      )}

      <CreateTaskDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        defaultLinks={[{ entity_type: entityType, entity_id: entityId }]}
      />
    </div>
  );
}
