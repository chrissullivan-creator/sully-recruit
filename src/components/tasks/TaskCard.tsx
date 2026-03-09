import { useState } from 'react';
import { Task, useUpdateTaskStatus, useAddTaskComment } from '@/hooks/useTasks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { format, isPast, isToday } from 'date-fns';
import { Calendar, MessageSquare, ChevronDown, ChevronUp, Send } from 'lucide-react';

const priorityColors: Record<string, string> = {
  high: 'bg-destructive/10 text-destructive border-destructive/20',
  medium: 'bg-warning/10 text-warning border-warning/20',
  low: 'bg-muted text-muted-foreground border-border',
};

export function TaskCard({ task }: { task: Task }) {
  const [expanded, setExpanded] = useState(false);
  const [comment, setComment] = useState('');
  const updateStatus = useUpdateTaskStatus();
  const addComment = useAddTaskComment();

  const isOverdue = task.due_date && isPast(new Date(task.due_date)) && task.status !== 'completed';
  const isDueToday = task.due_date && isToday(new Date(task.due_date));

  const handleToggle = () => {
    const newStatus = task.status === 'completed' ? 'pending' : 'completed';
    updateStatus.mutate({ taskId: task.id, status: newStatus });
  };

  const handleComment = () => {
    if (!comment.trim()) return;
    addComment.mutate({ taskId: task.id, body: comment.trim() });
    setComment('');
  };

  const comments = task.task_comments || [];

  return (
    <div className={cn(
      'rounded-lg border p-3 transition-colors',
      task.status === 'completed' ? 'border-border bg-muted/30 opacity-70' : 'border-border bg-card',
      isOverdue && 'border-destructive/40'
    )}>
      <div className="flex items-start gap-2">
        <Checkbox
          checked={task.status === 'completed'}
          onCheckedChange={handleToggle}
          className="mt-0.5"
        />
        <div className="flex-1 min-w-0">
          <p className={cn('text-sm font-medium', task.status === 'completed' && 'line-through text-muted-foreground')}>
            {task.title}
          </p>
          {task.description && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{task.description}</p>
          )}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0', priorityColors[task.priority])}>
              {task.priority}
            </Badge>
            {task.due_date && (
              <span className={cn(
                'flex items-center gap-1 text-[10px]',
                isOverdue ? 'text-destructive font-medium' : isDueToday ? 'text-warning' : 'text-muted-foreground'
              )}>
                <Calendar className="h-3 w-3" />
                {format(new Date(task.due_date), 'MMM d')}
              </span>
            )}
            {comments.length > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                <MessageSquare className="h-3 w-3" /> {comments.length}
              </span>
            )}
          </div>
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </Button>
      </div>

      {expanded && (
        <div className="mt-3 border-t border-border pt-3 space-y-2">
          {comments.map((c) => (
            <div key={c.id} className="bg-muted/50 rounded px-2 py-1.5">
              <p className="text-xs text-foreground">{c.body}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {format(new Date(c.created_at), 'MMM d, h:mm a')}
              </p>
            </div>
          ))}
          <div className="flex gap-1.5">
            <input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleComment()}
              placeholder="Add a comment..."
              className="flex-1 bg-muted rounded px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={handleComment} disabled={!comment.trim()}>
              <Send className="h-3 w-3" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
