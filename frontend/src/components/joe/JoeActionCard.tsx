import { useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { Check, X, ExternalLink, Loader2, Wand2 } from 'lucide-react';
import {
  executeJoeAction,
  isInlineExecutableJoeAction,
  type JoeAction,
  type JoeActionResolution,
} from '@/lib/joeActions';

/**
 * Renders an approve/edit/reject card for a Joe-proposed action (Phase 2,
 * agentic). The backend tool only PROPOSES — nothing has happened yet.
 *
 * Safety: only the genuinely low-risk `add_note` executes inline here. The
 * consequential actions (drafting/sending a message, enrolling, moving a
 * pipeline stage) deep-link the recruiter to the proper UI to review and
 * confirm — Joe never sends or moves anyone on its own.
 */

export type { JoeAction } from '@/lib/joeActions';

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
  footerActions,
}: {
  action: JoeAction;
  onResolve: (id: string, resolution?: JoeActionResolution) => void | Promise<void>;
  footerActions?: ReactNode;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const inlineExecutable = isInlineExecutableJoeAction(action);

  const approve = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await executeJoeAction(action, user?.id ?? null);
      toast.success(result.summary);
      await onResolve(action.id, 'done');
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not complete that');
    } finally {
      setBusy(false);
    }
  };

  const openToConfirm = () => {
    if (action.route) navigate(action.route);
    onResolve(action.id, 'approved');
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
              <ExternalLink className="h-3.5 w-3.5" /> Review/edit
            </Button>
          )}
          {footerActions}
          <Button size="xs" variant="ghost" onClick={() => onResolve(action.id, 'dismissed')} disabled={busy}>
            <X className="h-3.5 w-3.5" /> Dismiss
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
