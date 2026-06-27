import { useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Gift } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidateName?: string;
  jobTitle?: string;
  /** base / bonus are parsed numbers (USD) or null; details is free text. */
  onConfirm: (base: number | null, bonus: number | null, details: string) => Promise<void> | void;
}

/** Accepts "120k", "120,000", "$120k", "1.2M". */
function parseMoney(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const cleaned = t.replace(/[$,\s]/g, '');
  const m = cleaned.match(/^([0-9]*\.?[0-9]+)\s*([kKmM]?)$/);
  if (!m) return NaN as unknown as number; // signal invalid
  const n = parseFloat(m[1]);
  const sfx = m[2].toLowerCase();
  if (sfx === 'k') return Math.round(n * 1_000);
  if (sfx === 'm') return Math.round(n * 1_000_000);
  return Math.round(n);
}

/**
 * Dialog shown when moving an Interview-stage candidate to Offer. Captures the
 * offer base, bonus, and any additional details, written to
 * send_outs.offer_base / offer_bonus / offer_details before advancing the stage.
 */
export function OfferDialog({ open, onOpenChange, candidateName, jobTitle, onConfirm }: Props) {
  const [base, setBase] = useState('');
  const [bonus, setBonus] = useState('');
  const [details, setDetails] = useState('');
  const [saving, setSaving] = useState(false);

  const reset = () => { setBase(''); setBonus(''); setDetails(''); setSaving(false); };

  const handleSave = async () => {
    const baseN = parseMoney(base);
    const bonusN = parseMoney(bonus);
    if (Number.isNaN(baseN)) return;
    if (Number.isNaN(bonusN)) return;
    setSaving(true);
    try {
      await onConfirm(baseN ?? null, bonusN ?? null, details.trim());
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
            <Gift className="h-4 w-4 text-gold-deep" /> Record Offer
          </DialogTitle>
          <DialogDescription>
            Capture the offer for {candidateName ? candidateName : 'this candidate'}
            {jobTitle ? ` on ${jobTitle}` : ''}. This advances the card to Offer.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Offer base</Label>
              <Input value={base} onChange={(e) => setBase(e.target.value)} placeholder="e.g. 200k" inputMode="decimal" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Bonus</Label>
              <Input value={bonus} onChange={(e) => setBonus(e.target.value)} placeholder="e.g. 50k or 30%" inputMode="decimal" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Additional offer details <span className="text-muted-foreground">(optional)</span></Label>
            <Textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={3}
              placeholder="Equity, sign-on bonus, start date, relocation, contingencies…"
              className="border-card-border resize-none" />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button variant="gold" onClick={handleSave} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save Offer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
