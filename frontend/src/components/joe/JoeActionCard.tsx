import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { Check, X, ExternalLink, Loader2, Wand2 } from 'lucide-react';
import { enrollPeopleInSequence } from '@/lib/enrollPeople';

/**
 * Renders an approve/edit/reject card for a Joe-proposed action (Phase 2,
 * agentic). The backend tool only PROPOSES — nothing has happened yet.
 *
 * Safety: only the genuinely low-risk `add_note` executes inline here. The
 * consequential actions (drafting/sending a message, enrolling, moving a
 * pipeline stage) deep-link the recruiter to the proper UI to review and
 * confirm — Joe never sends or moves anyone on its own.
 */

export type JoeAction = {
  id: string;
  type: 'draft_message' | 'enroll_in_sequence' | 'move_pipeline_stage' | 'create_task' | 'add_note';
  title: string;
  preview?: string;
  params: Record<string, any>;
  route?: string | null;
  entity_type?: 'candidate' | 'contact';
};

const TYPE_LABEL: Record<JoeAction['type'], string> = {
  draft_message: 'Draft message',
  enroll_in_sequence: 'Enroll in sequence',
  move_pipeline_stage: 'Move stage',
  create_task: 'Create task',
  add_note: 'Add note',
};

export function JoeActionCard({
  action,
  onResolve,
}: {
  action: JoeAction;
  onResolve: (id: string) => void;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const inlineExecutable = action.type === 'add_note' || action.type === 'enroll_in_sequence';

  const approve = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (action.type === 'add_note') {
        const { error } = await supabase.from('notes').insert({
          entity_type: action.entity_type ?? 'candidate',
          entity_id: action.params.person_id,
          note: action.params.note,
          created_by: user?.id ?? null,
        } as any);
        if (error) throw error;
        toast.success('Note added');
      } else if (action.type === 'enroll_in_sequence') {
        const seqId = action.params.sequence_id as string | undefined;
        const ids = ((action.params.people as any[]) ?? [])
          .map((p) => p?.person_id)
          .filter(Boolean);
        if (!seqId || ids.length === 0) throw new Error('Nothing to enroll');
        const r = await enrollPeopleInSequence(seqId, ids);
        const parts: string[] = [];
        if (r.enrolled) parts.push(`${r.enrolled} enrolled`);
        if (r.skipped) parts.push(`${r.skipped} already in sequence`);
        if (r.blocked) parts.push(`${r.blocked} skipped (do-not-contact)`);
        if (r.unresolved) parts.push(`${r.unresolved} not found`);
        if (r.initFailed) toast.warning(`${r.initFailed} didn't pre-schedule — re-enroll those`);
        toast.success(parts.join(' · ') || 'No changes');
      }
      onResolve(action.id);
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not complete that');
    } finally {
      setBusy(false);
    }
  };

  const openToConfirm = () => {
    if (action.route) navigate(action.route);
    onResolve(action.id);
  };

  return (
    <Card className="border-gold/40 bg-gold/5">
      <CardContent className="p-3">
        <div className="flex items-center gap-2 mb-1">
          <Wand2 className="h-3.5 w-3.5 text-gold-deep" />
          <Badge variant="outline" className="text-[10px]">{TYPE_LABEL[action.type]}</Badge>
          <span className="text-[10px] text-muted-foreground">Joe's proposal — needs your OK</span>
        </div>
        <div className="text-sm font-medium">{action.title}</div>
        {action.preview && (
          <div className="text-xs text-muted-foreground mt-0.5 line-clamp-3 whitespace-pre-wrap">
            {action.preview}
          </div>
        )}
        <div className="flex items-center gap-2 mt-2">
          {inlineExecutable ? (
            <Button size="xs" variant="gold" onClick={approve} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Approve
            </Button>
          ) : (
            <Button size="xs" variant="gold" onClick={openToConfirm} disabled={!action.route}>
              <ExternalLink className="h-3.5 w-3.5" /> Review &amp; confirm
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={() => onResolve(action.id)} disabled={busy}>
            <X className="h-3.5 w-3.5" /> Dismiss
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
