import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { UserRound, Briefcase, X as XIcon, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { formatSmartTimestamp, formatAbsoluteTimestamp } from '@/lib/format-time';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface UnclassifiedPerson {
  id: string;
  full_name: string | null;
  primary_email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  auto_added_at: string | null;
  auto_added_source: string | null;
}

const SOURCE_LABEL: Record<string, string> = {
  outbound_email: 'Email send',
  outbound_linkedin: 'LinkedIn send',
  outbound_recruiter: 'Recruiter send',
  outbound_sms: 'SMS send',
  group_thread: 'Group thread',
};

/**
 * Replaces the regular thread-list pane when the user selects the
 * "Needs classification" sidebar view. Shows people who were
 * auto-added from outbound sends and haven't yet been classified
 * candidate vs client. One-click Candidate / Client / Remove.
 */
export function NeedsClassificationList() {
  const queryClient = useQueryClient();
  const { data: people = [], isLoading } = useQuery({
    queryKey: ['inbox_needs_classification'],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('people')
        .select('id, full_name, primary_email, phone, linkedin_url, auto_added_at, auto_added_source')
        .eq('needs_classification', true)
        .order('auto_added_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as UnclassifiedPerson[];
    },
  });

  const setType = async (id: string, type: 'candidate' | 'client') => {
    const { error } = await supabase
      .from('people')
      .update({ type, needs_classification: false } as any)
      .eq('id', id);
    if (error) {
      toast.error(`Couldn't classify: ${error.message}`);
      return;
    }
    toast.success(`Marked as ${type}`);
    queryClient.invalidateQueries({ queryKey: ['inbox_needs_classification'] });
  };

  const remove = async (id: string) => {
    const { error } = await supabase
      .from('people')
      .delete()
      .eq('id', id);
    if (error) {
      toast.error(`Couldn't remove: ${error.message}`);
      return;
    }
    toast.success('Removed from CRM');
    queryClient.invalidateQueries({ queryKey: ['inbox_needs_classification'] });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (people.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground select-none px-6 text-center">
        <UserRound className="h-10 w-10 mb-3 opacity-25" />
        <p className="text-sm font-medium mb-1">Nothing to classify</p>
        <p className="text-xs opacity-70">
          People auto-added from your outbound sends will appear here for quick Candidate / Client tagging.
        </p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border/60">
      {people.map((p) => {
        const identifier = p.primary_email || p.phone || p.linkedin_url || '—';
        const sourceLabel = p.auto_added_source ? SOURCE_LABEL[p.auto_added_source] ?? p.auto_added_source : 'Unknown';
        return (
          <div key={p.id} className="px-3 py-3">
            <div className="flex items-start justify-between gap-2 mb-1">
              <Link
                to={`/candidates/${p.id}`}
                className="text-sm font-semibold text-foreground hover:text-accent transition-colors truncate"
              >
                {p.full_name || 'Unnamed'}
              </Link>
              {p.auto_added_at && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 cursor-default">
                      {formatSmartTimestamp(p.auto_added_at)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="text-xs">
                    {formatAbsoluteTimestamp(p.auto_added_at)}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            <p className="text-xs text-muted-foreground truncate mb-1">{identifier}</p>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-2">
              Added from {sourceLabel}
            </p>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1"
                onClick={() => setType(p.id, 'candidate')}
                title="Mark as candidate"
              >
                <UserRound className="h-3 w-3" />
                Candidate
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1"
                onClick={() => setType(p.id, 'client')}
                title="Mark as client"
              >
                <Briefcase className="h-3 w-3" />
                Client
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs gap-1 text-muted-foreground hover:text-destructive ml-auto"
                onClick={() => remove(p.id)}
                title="Remove from CRM"
              >
                <XIcon className="h-3 w-3" />
                Remove
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
