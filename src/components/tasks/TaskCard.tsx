import { useState } from 'react';
import { Task, useUpdateTaskStatus, useAddTaskComment, useCompleteTaskWithNote } from '@/hooks/useTasks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { format, isPast, isToday } from 'date-fns';
import { Calendar, MessageSquare, ChevronDown, ChevronUp, Send, CheckCircle2, User } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

export function TaskCard({ task }: { task: Task }) {
  const [expanded, setExpanded] = useState(false);
  const [comment, setComment] = useState('');
  const [completeOpen, setCompleteOpen] = useState(false);
  const [completionNote, setCompletionNote] = useState('');
  const updateStatus = useUpdateTaskStatus();
  const addComment = useAddTaskComment();
  const completeWithNote = useCompleteTaskWithNote();

  const isOverdue = task.due_date && isPast(new Date(task.due_date)) && task.status !== 'completed';
  const isDueToday = task.due_date && isToday(new Date(task.due_date));

  const handleToggle = () => {
    if (task.status === 'completed') {
      updateStatus.mutate({ taskId: task.id, status: 'pending' });
    } else {
      // Open completion dialog to add a note
      setCompleteOpen(true);
    }
  };

  const handleCompleteWithNote = () => {
    completeWithNote.mutate(
      { taskId: task.id, note: completionNote },
      { onSuccess: () => { setCompleteOpen(false); setCompletionNote(''); } }
    );
  };

  const handleQuickComplete = () => {
    updateStatus.mutate({ taskId: task.id, status: 'completed' });
  };

  const handleComment = () => {
    if (!comment.trim()) return;
    addComment.mutate({ taskId: task.id, body: comment.trim() });
    setComment('');
  };

  const comments = task.task_comments || [];
  const linkedEntities = task.task_links || [];

  return (
    <>
      <div className={cn(
        'rounded-lg border p-3 transition-colors',
        task.status === 'completed' ? 'border-border bg-muted/30 opacity-70' : 'border-border bg-card',
        isOverdue && 'border-destructive/40'
      )}>
        <div className="flex items-start gap-2">
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-5 w-5 mt-0.5 shrink-0", task.status === 'completed' && 'text-green-500')}
            onClick={handleToggle}
          >
            <CheckCircle2 className={cn("h-4 w-4", task.status === 'completed' ? 'fill-green-500 text-green-500' : 'text-muted-foreground')} />
          </Button>
          <div className="flex-1 min-w-0">
            <p className={cn('text-sm font-medium', task.status === 'completed' && 'line-through text-muted-foreground')}>
              {task.title}
            </p>
            {task.description && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{task.description}</p>
            )}
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              {task.due_date && (
                <span className={cn(
                  'flex items-center gap-1 text-[10px]',
                  isOverdue ? 'text-destructive font-medium' : isDueToday ? 'text-warning' : 'text-muted-foreground'
                )}>
                  <Calendar className="h-3 w-3" />
                  {format(new Date(task.due_date), 'MMM d')}
                </span>
              )}
              {task.assignee_name && (
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <User className="h-3 w-3" /> {task.assignee_name}
                </span>
              )}
              {task.creator_name && (
                <span className="text-[10px] text-muted-foreground">
                  from {task.creator_name}
                </span>
              )}
              {linkedEntities.length > 0 && (
                <span className="text-[10px] text-accent">
                  {linkedEntities.map(l => l.entity_type === 'candidate' ? '👤' : l.entity_type === 'job' ? '💼' : '🔗').join(' ')}
                  {' '}{linkedEntities.length} linked
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

      {/* Complete with note dialog */}
      <Dialog open={completeOpen} onOpenChange={setCompleteOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">Complete Task</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{task.title}</p>
            <div className="space-y-2">
              <Label className="text-sm">Completion Note</Label>
              <Textarea
                value={completionNote}
                onChange={(e) => setCompletionNote(e.target.value)}
                placeholder="e.g. Comp for this role is 120k, candidate interested..."
                rows={3}
              />
              <p className="text-[10px] text-muted-foreground">
                {task.created_by && task.created_by !== task.assigned_to
                  ? 'A follow-up task with your note will be created for the task creator.'
                  : 'Add any notes for your records.'}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={handleQuickComplete}>Skip Note</Button>
            <Button variant="gold" size="sm" onClick={handleCompleteWithNote} disabled={completeWithNote.isPending}>
              Complete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
