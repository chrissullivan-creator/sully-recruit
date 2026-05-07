import { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2 } from 'lucide-react';

/**
 * Captures notes the recruiter wants stamped on a send-out at the
 * moment the candidate gets pushed into the Send Out stage (or any
 * stage where the user wants context).
 *
 * The dialog itself is dumb — it collects the note and hands it back
 * via onConfirm(note). The caller decides what to do with it (usually
 * passes it as `note` to moveStage / send_outs.insert).
 *
 * Skip is allowed — pressing "Move without notes" calls onConfirm('').
 */
export function SendOutNotesDialog({
  open,
  onOpenChange,
  onConfirm,
  candidateName,
  jobTitle,
  saving = false,
  /** Optional override copy. Defaults to "Add to Send Out". */
  title = 'Add notes for this Send Out',
  /** What action label to show on the primary button. */
  confirmLabel = 'Save & Move',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (note: string) => void;
  candidateName?: string | null;
  jobTitle?: string | null;
  saving?: boolean;
  title?: string;
  confirmLabel?: string;
}) {
  const [note, setNote] = useState('');

  // Reset on open so a previous note doesn't bleed into the next move.
  useEffect(() => {
    if (open) setNote('');
  }, [open]);

  const subject =
    candidateName && jobTitle
      ? `${candidateName} → ${jobTitle}`
      : candidateName || jobTitle || '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {subject ? (
              <>Notes saved here show up in <span className="font-medium">{subject}</span>'s activity feed.</>
            ) : (
              <>Notes saved here show up in the activity feed.</>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <Label htmlFor="send-out-note" className="text-xs uppercase tracking-wide text-muted-foreground">
            Notes (optional)
          </Label>
          <Textarea
            id="send-out-note"
            autoFocus
            rows={5}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why this candidate, what to flag for the client, comp expectations…"
            className="resize-y"
          />
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onConfirm('')}
            disabled={saving}
            type="button"
          >
            Skip notes
          </Button>
          <Button
            variant="gold"
            onClick={() => onConfirm(note)}
            disabled={saving}
            type="button"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
