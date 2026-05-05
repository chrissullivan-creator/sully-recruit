import { useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, AlertTriangle } from 'lucide-react';

const COMMON_REASONS = [
  'Client passed',
  'Candidate withdrew',
  'Comp mismatch',
  'Background check',
  'Counter-offer accepted',
  'Role on hold / closed',
  'Timing',
  'Cultural fit',
  'Other',
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidateName?: string;
  jobTitle?: string;
  /** Receives the chosen reason text + saves. Resolves when the save completes. */
  onConfirm: (reason: string) => Promise<void> | void;
}

/**
 * Modal that prompts for a withdrawn reason before stamping
 * send_outs.withdrawn_reason. Shows a list of common one-clicks plus a
 * free-form textarea — keeps the data both queryable (via the canned
 * picks) and rich (via the optional notes).
 */
export function WithdrawnReasonDialog({
  open, onOpenChange, candidateName, jobTitle, onConfirm,
}: Props) {
  const [pick, setPick] = useState<string>('');
  const [detail, setDetail] = useState('');
  const [saving, setSaving] = useState(false);

  const reset = () => { setPick(''); setDetail(''); setSaving(false); };

  const handleSave = async () => {
    const finalText = [pick, detail.trim()].filter(Boolean).join(detail.trim() ? ' — ' : '');
    if (!finalText) return;
    setSaving(true);
    try {
      await onConfirm(finalText);
      reset();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="max-w-md bg-page-bg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display text-emerald-dark">
            <AlertTriangle className="h-4 w-4 text-amber-600" /> Mark as Withdrawn
          </DialogTitle>
          <DialogDescription>
            Capture why this {jobTitle ? `submission to ${jobTitle}` : 'send-out'} is closing
            {candidateName ? ` for ${candidateName}` : ''}. The reason shows up in Reports + the
            audit trail and helps the team learn what's costing us deals.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Reason</Label>
            <div className="flex flex-wrap gap-1.5">
              {COMMON_REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setPick(pick === r ? '' : r)}
                  className={
                    'inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ' +
                    (pick === r
                      ? 'bg-emerald text-white border-emerald'
                      : 'bg-white text-muted-foreground border-card-border hover:border-emerald/40 hover:text-emerald-dark')
                  }
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Notes <span className="text-muted-foreground">(optional)</span></Label>
            <Textarea
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              placeholder="Specifics — quotes, deal-breakers, anything that helps the team next time"
              rows={3}
              className="border-card-border resize-none"
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="gold"
            onClick={handleSave}
            disabled={saving || (!pick && !detail.trim())}
            className="gap-1.5"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Mark Withdrawn
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
