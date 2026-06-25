import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { invalidatePersonScope } from '@/lib/invalidate';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Plus, X, Loader2 } from 'lucide-react';

/**
 * Inline editor for a person's `skills` text[] column.
 *
 * Renders the existing skills as removable chips and an "add skill" input
 * that writes back to people.skills. The column isn't in the generated
 * Supabase types in a typed-array shape everywhere, so the update is cast
 * as any (consistent with the rest of CandidateDetail).
 */
export function SkillsEditor({
  personId,
  skills,
  disabled = false,
}: {
  personId: string | null | undefined;
  skills: string[] | null | undefined;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const list = Array.isArray(skills) ? skills : [];

  const persist = async (next: string[]) => {
    if (!personId) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from('people')
        .update({ skills: next.length ? next : null } as any)
        .eq('id', personId);
      if (error) throw error;
      invalidatePersonScope(queryClient);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to update skills');
    } finally {
      setSaving(false);
    }
  };

  const addSkill = async () => {
    const v = draft.trim();
    if (!v) return;
    // Case-insensitive de-dupe so "Python" / "python" don't both land.
    if (list.some((s) => s.toLowerCase() === v.toLowerCase())) {
      setDraft('');
      return;
    }
    setDraft('');
    await persist([...list, v]);
  };

  const removeSkill = async (skill: string) => {
    await persist(list.filter((s) => s !== skill));
  };

  return (
    <div className="space-y-2">
      {list.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No skills recorded.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {list.map((skill) => (
            <span
              key={skill}
              className="inline-flex items-center gap-1 rounded-full bg-accent/10 text-accent border border-accent/20 px-2 py-0.5 text-xs font-medium"
            >
              {skill}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => removeSkill(skill)}
                  className="text-accent/70 hover:text-accent transition-colors"
                  aria-label={`Remove ${skill}`}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {!disabled && (
        <div className="flex items-center gap-1.5">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); addSkill(); }
            }}
            placeholder="Add a skill…"
            className="h-7 text-xs flex-1"
          />
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            onClick={addSkill}
            disabled={saving || !draft.trim()}
            title="Add skill"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          </Button>
        </div>
      )}
    </div>
  );
}
