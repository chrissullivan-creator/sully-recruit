import { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Trash2, Pencil } from 'lucide-react';
import { format } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { invalidateNoteScope } from '@/lib/invalidate';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@/hooks/use-toast';

interface SendOutNoteRow {
  id: string;
  note: string;
  created_at: string;
  created_by: string | null;
  note_source: string | null;
}

const SOURCE_LABEL: Record<string, string> = {
  add_send_out: 'Added to job',
  stage_move: 'Stage move',
  send_out_note: 'Note',
};

/**
 * Notes panel for a single send_out. Backed by the polymorphic `notes`
 * table (entity_type='send_out', entity_id=<send_out_id>) — *not*
 * `send_outs.submittal_notes`, which is a separate field used for
 * client-facing submittal copy.
 *
 * Behaviour:
 *  - Loads every note row for this send-out on open, newest first.
 *  - Composer at the top: type → Save adds a new note tagged
 *    `note_source='send_out_note'`.
 *  - Per-row edit + delete for notes the current user authored
 *    (or any note when the user is admin — RLS handles the gate so
 *    we keep the UI simple and let the server reject if needed).
 *  - Invalidates note + entity-feed scopes so the candidate sidebar
 *    activity log refreshes.
 *
 * Sibling to `SendOutNotesDialog` (write-only stage-move collector).
 */
export function EditSendOutNotesDialog({
  open,
  onOpenChange,
  sendOutId,
  candidateName,
  jobTitle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sendOutId: string | null;
  candidateName?: string | null;
  jobTitle?: string | null;
}) {
  const qc = useQueryClient();
  const [notes, setNotes] = useState<SendOutNoteRow[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  // Load fresh notes every time the dialog opens. Pulls the current
  // user too so per-row edit/delete only show on rows they authored.
  useEffect(() => {
    if (!open || !sendOutId) return;
    let cancelled = false;
    setLoading(true);
    setDraft('');
    setEditingId(null);
    Promise.all([
      supabase
        .from('notes')
        .select('id, note, created_at, created_by, note_source')
        .eq('entity_type', 'send_out')
        .eq('entity_id', sendOutId)
        .order('created_at', { ascending: false })
        .limit(100),
      supabase.auth.getSession(),
    ]).then(([notesRes, sessionRes]) => {
      if (cancelled) return;
      if (notesRes.error) {
        toast({ title: 'Could not load notes', description: notesRes.error.message, variant: 'destructive' });
        setNotes([]);
      } else {
        setNotes(((notesRes.data ?? []) as unknown) as SendOutNoteRow[]);
      }
      setCurrentUserId(sessionRes.data.session?.user?.id ?? null);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, sendOutId]);

  const refreshNotes = async () => {
    if (!sendOutId) return;
    const { data } = await supabase
      .from('notes')
      .select('id, note, created_at, created_by, note_source')
      .eq('entity_type', 'send_out')
      .eq('entity_id', sendOutId)
      .order('created_at', { ascending: false })
      .limit(100);
    setNotes(((data ?? []) as unknown) as SendOutNoteRow[]);
  };

  const handleAdd = async () => {
    const trimmed = draft.trim();
    if (!sendOutId || !trimmed) return;
    setSaving(true);
    const { error } = await supabase.from('notes').insert({
      entity_type: 'send_out',
      entity_id: sendOutId,
      note: trimmed,
      created_by: currentUserId,
      note_source: 'send_out_note',
    } as any);
    setSaving(false);
    if (error) {
      toast({ title: 'Could not save note', description: error.message, variant: 'destructive' });
      return;
    }
    setDraft('');
    invalidateNoteScope(qc);
    await refreshNotes();
    toast({ title: 'Note added' });
  };

  const startEdit = (n: SendOutNoteRow) => {
    setEditingId(n.id);
    setEditingText(n.note);
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    const trimmed = editingText.trim();
    if (!trimmed) return;
    setSaving(true);
    const { error } = await supabase
      .from('notes')
      .update({ note: trimmed })
      .eq('id', editingId);
    setSaving(false);
    if (error) {
      toast({ title: 'Could not update note', description: error.message, variant: 'destructive' });
      return;
    }
    setEditingId(null);
    setEditingText('');
    invalidateNoteScope(qc);
    await refreshNotes();
    toast({ title: 'Note updated' });
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this note?')) return;
    setSaving(true);
    const { error } = await supabase.from('notes').delete().eq('id', id);
    setSaving(false);
    if (error) {
      toast({ title: 'Could not delete note', description: error.message, variant: 'destructive' });
      return;
    }
    invalidateNoteScope(qc);
    await refreshNotes();
    toast({ title: 'Note deleted' });
  };

  const subject = candidateName && jobTitle
    ? `${candidateName} → ${jobTitle}`
    : candidateName || jobTitle || '';

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!saving) onOpenChange(v); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send-out notes</DialogTitle>
          <DialogDescription>
            {subject
              ? <>Notes for <span className="font-medium">{subject}</span>.</>
              : <>Notes attached to this send-out.</>}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <Label htmlFor="new-send-out-note" className="text-xs uppercase tracking-wide text-muted-foreground">
            Add a note
          </Label>
          <Textarea
            id="new-send-out-note"
            autoFocus
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Why this candidate, what to flag for the client, comp expectations…"
            className="resize-y"
          />
          <div className="flex justify-end">
            <Button
              variant="gold" size="sm"
              onClick={handleAdd}
              disabled={saving || !draft.trim()}
              type="button"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              Add note
            </Button>
          </div>
        </div>

        <div className="border-t pt-3 max-h-72 overflow-y-auto space-y-2">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : notes.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">No notes yet.</p>
          ) : (
            notes.map((n) => {
              const ownedByMe = !!currentUserId && n.created_by === currentUserId;
              const isEditing = editingId === n.id;
              return (
                <div key={n.id} className="rounded-md border border-card-border bg-secondary/30 p-2.5">
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
                    <span>{SOURCE_LABEL[n.note_source ?? ''] ?? 'Note'}</span>
                    <span>{format(new Date(n.created_at), 'MMM d, yyyy h:mm a')}</span>
                  </div>
                  {isEditing ? (
                    <div className="space-y-2">
                      <Textarea
                        rows={3}
                        value={editingText}
                        onChange={(e) => setEditingText(e.target.value)}
                        className="resize-y text-xs"
                      />
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => { setEditingId(null); setEditingText(''); }} disabled={saving} type="button">
                          Cancel
                        </Button>
                        <Button variant="gold" size="sm" onClick={handleSaveEdit} disabled={saving || !editingText.trim()} type="button">
                          Save
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-xs whitespace-pre-wrap text-foreground">{n.note}</p>
                      {ownedByMe && (
                        <div className="flex justify-end gap-1 mt-1">
                          <button
                            onClick={() => startEdit(n)}
                            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
                            title="Edit"
                            type="button"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            onClick={() => handleDelete(n.id)}
                            className="p-1 rounded text-muted-foreground hover:text-red-600 hover:bg-red-50"
                            title="Delete"
                            type="button"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving} type="button">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
