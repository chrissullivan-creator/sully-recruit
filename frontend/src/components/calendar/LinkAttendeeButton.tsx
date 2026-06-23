import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Link2, Loader2, Search } from 'lucide-react';
import { toast } from 'sonner';

/**
 * "Link to person" for an unmatched calendar invitee. Searches `people`
 * by name/email and, on select, sets the meeting_attendees row's
 * entity_id/entity_type so the invitee becomes a linked attendee (clickable,
 * with the résumé + send-outs panel). This is the manual fix for invites
 * whose email isn't on the person's CRM record.
 */
export function LinkAttendeeButton({
  attendeeRowId,
  defaultQuery,
  onLinked,
}: {
  attendeeRowId: string;
  defaultQuery?: string;
  onLinked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(defaultQuery ?? '');
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const term = q.trim();
  const { data: results = [], isFetching } = useQuery({
    queryKey: ['attendee_person_search', term],
    enabled: open && term.length >= 2,
    queryFn: async () => {
      const { data } = await supabase
        .from('people')
        .select('id, full_name, type, primary_email')
        .or(`full_name.ilike.%${term}%,primary_email.ilike.%${term}%`)
        .limit(8);
      return (data ?? []) as any[];
    },
  });

  const link = async (person: any) => {
    setLinkingId(person.id);
    try {
      const entityType = person.type === 'client' ? 'contact' : 'candidate';
      const { error } = await supabase
        .from('meeting_attendees')
        .update({ entity_id: person.id, entity_type: entityType } as any)
        .eq('id', attendeeRowId);
      if (error) throw error;
      toast.success(`Linked to ${person.full_name}`);
      setOpen(false);
      onLinked();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLinkingId(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-6 px-2 text-[10px] shrink-0">
          <Link2 className="h-3 w-3 mr-1" /> Link
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="end">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search people by name or email…"
            className="h-8 pl-7 text-sm"
            autoFocus
          />
        </div>
        <div className="mt-2 max-h-56 overflow-y-auto space-y-0.5">
          {term.length < 2 && (
            <p className="text-[11px] text-muted-foreground italic px-1 py-1">Type at least 2 characters.</p>
          )}
          {term.length >= 2 && isFetching && (
            <p className="text-[11px] text-muted-foreground italic px-1 py-1">Searching…</p>
          )}
          {term.length >= 2 && !isFetching && results.length === 0 && (
            <p className="text-[11px] text-muted-foreground italic px-1 py-1">No matches.</p>
          )}
          {results.map((p) => (
            <button
              key={p.id}
              onClick={() => link(p)}
              disabled={!!linkingId}
              className="w-full text-left rounded px-2 py-1 hover:bg-muted text-sm flex items-center justify-between gap-2"
            >
              <span className="truncate min-w-0">
                {p.full_name || p.primary_email || 'Unnamed'}
                {p.primary_email && <span className="text-[11px] text-muted-foreground ml-1">· {p.primary_email}</span>}
              </span>
              {linkingId === p.id && <Loader2 className="h-3 w-3 animate-spin shrink-0" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
