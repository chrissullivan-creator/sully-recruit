import { useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, AlertTriangle } from 'lucide-react';

// Who drove the rejection — REQUIRED. Values are lowercase to match the
// send_outs.withdrawn_by_party / rejections.rejected_by_party CHECK.
const PARTIES = [
  { value: 'client', label: 'Client' },
  { value: 'candidate', label: 'Candidate' },
  { value: 'salesperson', label: 'Salesperson' },
  { value: 'recruiter', label: 'Recruiter' },
] as const;

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
  /** Receives the required party + the optional reason text, then saves.
   *  Resolves when the save completes. */
  onConfirm: (party: string, reason: string) => Promise<void> | void;
}

/**
 * Modal shown when moving a card to the terminal **Rejected** stage (the stage
 * formerly labeled "Withdrawn"; its internal key is still `withdrawn`). Requires
 * picking who drove it — client/candidate/salesperson/recruiter, stamped on
 * send_outs.withdrawn_by_party — plus an optional free-text reason (canned chips
 * + notes) stamped on send_outs.withdrawn_reason for Reports + the audit trail.
 */
export function WithdrawnReasonDialog({
  open, onOpenChange, candidateName, jobTitle, onConfirm,
}: Props) {
  const [party, setParty] = useState<string>('');
  const [pick, setPick] = useState<string>('');
  const [detail, setDetail] = useState('');
  const [saving, setSaving] = useState(false);

  const reset = () => { setParty(''); setPick(''); setDetail(''); setSaving(false); };

  const handleSave = async () => {
    if (!party) return; // party is required
    const finalText = [pick, detail.trim()].filter(Boolean).join(detail.trim() ? ' — ' : '');
    setSaving(true);
    try {
      await onConfirm(party, finalText);
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
            <AlertTriangle className="h-4 w-4 text-amber-600" /> Mark as Rejected
          </DialogTitle>
          <DialogDescription>
            Record why this {jobTitle ? `submission to ${jobTitle}` : 'send-out'} is closing
            {candidateName ? ` for ${candidateName}` : ''}. This shows up in Reports + the
            audit trail and helps the team learn what's costing us deals.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Rejected by <span className="text-red-500">*</span></Label>
            <div className="flex flex-wrap gap-1.5">
              {PARTIES.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setParty(p.value)}
                  className={
                    'inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ' +
                    (party === p.value
                      ? 'bg-emerald text-white border-emerald'
                      : 'bg-white text-muted-foreground border-card-border hover:border-emerald/40 hover:text-emerald-dark')
                  }
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Reason <span className="text-muted-foreground">(optional)</span></Label>
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
            disabled={saving || !party}
            className="gap-1.5"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Mark Rejected
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
