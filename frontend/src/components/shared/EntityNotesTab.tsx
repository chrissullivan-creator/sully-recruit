import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Loader2, FileText, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { useProfiles } from '@/hooks/useProfiles';

interface EntityNotesTabProps {
  /** Polymorphic notes target. Mirrors notes.entity_type values. */
  entityType: 'job' | 'candidate' | 'contact';
  entityId: string;
  /** Placeholder shown in the textarea. */
  placeholder?: string;
}

interface NoteRow {
  id: string;
  note: string;
  created_at: string;
  created_by: string | null;
}

export function EntityNotesTab({ entityType, entityId, placeholder }: EntityNotesTabProps) {
  const queryClient = useQueryClient();
  const { data: profiles = [] } = useProfiles();
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const queryKey = ['notes', entityType, entityId];
  const activityKey = entityType === 'job' ? ['job_activity', entityId] : null;

  const { data: notes = [], isLoading } = useQuery({
    queryKey,
    enabled: !!entityId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('notes')
        .select('id, note, created_at, created_by')
        .eq('entity_type', entityType)
        .eq('entity_id', entityId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as NoteRow[];
    },
  });

  const profileMap = Object.fromEntries((profiles as any[]).map((p) => [p.id, p]));

  const handleSave = async () => {
    if (!draft.trim()) return;
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase.from('notes').insert({
        entity_type: entityType,
        entity_id: entityId,
        note: draft.trim(),
        created_by: user?.id ?? null,
      });
      if (error) throw error;
      setDraft('');
      queryClient.invalidateQueries({ queryKey });
      if (activityKey) queryClient.invalidateQueries({ queryKey: activityKey });
      toast.success('Note added');
    } catch (err: any) {
      toast.error(err.message || 'Failed to save note');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from('notes').delete().eq('id', id);
    if (error) { toast.error(error.message); return; }
    queryClient.invalidateQueries({ queryKey });
    if (activityKey) queryClient.invalidateQueries({ queryKey: activityKey });
    toast.success('Note deleted');
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-card-border bg-white p-4">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder ?? 'Add a note — call summary, preferences, anything the team should see…'}
          rows={3}
          className="w-full rounded-md border border-card-border px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald/30 resize-y min-h-[80px]"
        />
        <div className="flex justify-end mt-2">
          <Button variant="gold" size="sm" onClick={handleSave} disabled={saving || !draft.trim()} className="gap-1.5">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
            Save Note
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">History</h3>
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading notes…
          </div>
        ) : notes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No notes yet.</p>
        ) : (
          <div className="space-y-2">
            {notes.map((n) => {
              const author = n.created_by ? profileMap[n.created_by] : null;
              const authorName = author?.full_name || author?.email || 'Unknown';
              const initials = authorName.split(' ').filter(Boolean).map((p: string) => p[0]).join('').slice(0, 2).toUpperCase() || '?';
              return (
                <div key={n.id} className="group rounded-lg border border-card-border bg-white p-3.5">
                  <div className="flex items-start gap-3">
                    <div className="h-7 w-7 shrink-0 rounded-full bg-emerald-light text-emerald flex items-center justify-center text-[10px] font-semibold">
                      {initials}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-xs font-medium text-emerald-dark">{authorName}</p>
                        <p className="text-[10px] text-muted-foreground">{format(new Date(n.created_at), 'MMM d, yyyy · h:mm a')}</p>
                      </div>
                      <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">{n.note}</p>
                    </div>
                    <button
                      onClick={() => handleDelete(n.id)}
                      title="Delete note"
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
