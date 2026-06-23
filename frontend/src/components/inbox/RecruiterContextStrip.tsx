import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatSmartTimestamp } from '@/lib/format-time';
import { CompanyLink } from '@/components/shared/EntityLinks';

interface PersonRow {
  id: string;
  full_name: string | null;
  current_title: string | null;
  current_company: string | null;
  company_id: string | null;
  status: string | null;
  avatar_url: string | null;
  last_contacted_at: string | null;
  last_responded_at: string | null;
}

interface RecruiterContextStripProps {
  personId: string;
  role: 'candidate' | 'contact';
}

const STATUS_LABEL: Record<string, string> = {
  new: 'New',
  reached_out: 'Reached out',
  engaged: 'Engaged',
};

/**
 * Thin context bar that appears above the reading pane when a thread is
 * linked to a candidate or client. Shows who they are, their role, and
 * the freshest activity timestamp — the recruiter-specific bit Outlook
 * doesn't have.
 */
export function RecruiterContextStrip({ personId, role }: RecruiterContextStripProps) {
  const { data: person } = useQuery({
    queryKey: ['inbox_context_person', personId],
    enabled: !!personId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('people')
        .select('id, full_name, current_title, current_company, company_id, status, avatar_url, last_contacted_at, last_responded_at')
        .eq('id', personId)
        .maybeSingle();
      if (error) throw error;
      return data as PersonRow | null;
    },
  });

  if (!person) return null;

  const targetHref = role === 'candidate' ? `/candidates/${person.id}` : `/contacts/${person.id}`;
  const initials = (person.full_name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

  const lastActivityTs = pickLatest(person.last_responded_at, person.last_contacted_at);
  const lastActivityLabel = person.last_responded_at && person.last_responded_at === lastActivityTs
    ? 'replied'
    : 'reached out';

  return (
    <div className="px-6 py-2 bg-muted/30 border-b border-border/60 flex items-center gap-3">
      {person.avatar_url ? (
        <img
          src={person.avatar_url}
          alt=""
          className="h-7 w-7 rounded-full object-cover shrink-0"
        />
      ) : (
        <div className="h-7 w-7 rounded-full bg-accent/15 text-accent flex items-center justify-center text-[10px] font-semibold shrink-0">
          {initials || '?'}
        </div>
      )}
      <div className="flex-1 min-w-0 flex items-center gap-2 text-xs">
        <Link
          to={targetHref}
          className="font-medium text-foreground hover:text-accent transition-colors truncate"
        >
          {person.full_name || 'Unnamed'}
        </Link>
        {(person.current_title || person.current_company) && (
          <span className="text-muted-foreground truncate flex items-center gap-1">
            <span aria-hidden>·</span>
            {person.current_title}
            {person.current_title && person.current_company && ' at '}
            {person.current_company && (
              <CompanyLink
                companyId={person.company_id}
                name={person.current_company}
                showLogo
                stopPropagation
                className="text-muted-foreground"
              />
            )}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-background border border-border text-muted-foreground">
          {role === 'candidate' ? 'Candidate' : 'Client'}
        </span>
        {person.status && STATUS_LABEL[person.status] && (
          <span className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-accent/10 text-accent">
            {STATUS_LABEL[person.status]}
          </span>
        )}
        {lastActivityTs && (
          <span className="text-[11px] text-muted-foreground">
            {lastActivityLabel} {formatSmartTimestamp(lastActivityTs)}
          </span>
        )}
      </div>
    </div>
  );
}

function pickLatest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() > new Date(b).getTime() ? a : b;
}
