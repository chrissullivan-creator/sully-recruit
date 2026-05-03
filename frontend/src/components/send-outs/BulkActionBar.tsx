import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X, ArrowRight, Trash2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { CANONICAL_PIPELINE, canonicalConfig, type CanonicalStage } from '@/lib/pipeline';
import { moveStage } from '@/lib/mutations/move-stage';
import type { SendOutRow } from '@/lib/queries/send-outs';
import { invalidateSendOutScope } from '@/lib/invalidate';

interface BulkActionBarProps {
  selectedRows: SendOutRow[];
  onClear: () => void;
}

export function BulkActionBar({ selectedRows, onClear }: BulkActionBarProps) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<CanonicalStage | ''>('');

  if (selectedRows.length === 0) return null;

  const handleMove = async () => {
    if (!target) return;
    setBusy(true);
    try {
      // Sequential — same atomic helper as drag-and-drop. Failures collected and
      // surfaced once at the end so a single bad row doesn't kill the batch.
      let ok = 0;
      let failed = 0;
      for (const row of selectedRows) {
        const res = await moveStage({
          sendOutId: row.id,
          fromStage: row.stage,
          toStage: target,
          triggerSource: 'bulk',
          entityId: row.candidate?.id ?? null,
          entityType: 'send_out',
        });
        if (res.ok) ok++; else failed++;
      }
      invalidateSendOutScope(queryClient);
      if (failed === 0) toast.success(`Moved ${ok} to ${canonicalConfig(target).label}`);
      else toast.warning(`Moved ${ok}; ${failed} failed`);
      onClear();
    } finally {
      setBusy(false);
      setTarget('');
    }
  };

  const handleDelete = async () => {
    setBusy(true);
    try {
      const ids = selectedRows.map((r) => r.id);
      const { error } = await supabase.from('send_outs').delete().in('id', ids);
      if (error) throw error;
      invalidateSendOutScope(queryClient);
      toast.success(`Deleted ${ids.length} send-out${ids.length === 1 ? '' : 's'}`);
      onClear();
    } catch (err: any) {
      toast.error(err.message || 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sticky bottom-4 z-30 mx-auto max-w-3xl rounded-xl border border-emerald/40 bg-emerald-dark text-emerald-light shadow-lg flex items-center gap-3 px-4 py-2.5">
      <span className="text-xs font-semibold tracking-wider uppercase">
        {selectedRows.length} selected
      </span>

      <div className="h-5 w-px bg-emerald-light/30" />

      <Select value={target} onValueChange={(v) => setTarget(v as CanonicalStage)}>
        <SelectTrigger className="h-8 w-[170px] bg-emerald text-emerald-light border-emerald-light/30 text-xs">
          <SelectValue placeholder="Move to stage…" />
        </SelectTrigger>
        <SelectContent>
          {CANONICAL_PIPELINE.map((s) => (
            <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        onClick={handleMove}
        disabled={!target || busy}
        size="sm"
        variant="gold"
        className="h-8 gap-1.5"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
        Move
      </Button>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            className="h-8 gap-1.5 bg-transparent border-emerald-light/30 text-emerald-light hover:bg-emerald hover:text-white"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedRows.length} send-out{selectedRows.length === 1 ? '' : 's'}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the selected send-out rows. Candidates and jobs are unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <button
        onClick={onClear}
        className="ml-auto p-1 rounded text-emerald-light/70 hover:text-emerald-light hover:bg-emerald"
        title="Clear selection"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
