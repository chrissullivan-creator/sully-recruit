import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatSmartTimestamp } from '@/lib/format-time';
import { CompanyLink } from '@/components/shared/EntityLinks';
import { Mail, Phone, Linkedin, ArrowUpRight } from 'lucide-react';

interface PersonRow {
  id: string;
  full_name: string | null;
  current_title: string | null;
  current_company: string | null;
  company_id: string | null;
  status: string | null;
  avatar_url: string | null;
  work_email: string | null;
  personal_email: string | null;
  phone: string | null;
  mobile_phone: string | null;
  linkedin_url: string | null;
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
 * Context bar above the reading pane when a thread is linked to a candidate or
 * client. With the side record panel collapsed this is the primary place the
 * recruiter sees who they are + how to reach them, so it surfaces the key
 * contact details (email / phone / LinkedIn) inline under the name rather than
 * truncating everything onto one cramped line.
 */
export function RecruiterContextStrip({ personId, role }: RecruiterContextStripProps) {
  const { data: person } = useQuery({
    queryKey: ['inbox_context_person', personId],
    enabled: !!personId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('people')
        .select(
          'id, full_name, current_title, current_company, company_id, status, avatar_url, work_email, personal_email, phone, mobile_phone, linkedin_url, last_contacted_at, last_responded_at',
        )
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

  const email = person.work_email || person.personal_email;
  const phone = person.phone || person.mobile_phone;
  const linkedin = person.linkedin_url;

  return (
    <div className="px-6 py-3 bg-muted/30 border-b border-border/60 flex items-start gap-3">
      {person.avatar_url ? (
        <img
          src={person.avatar_url}
          alt=""
          className="h-9 w-9 rounded-full object-cover shrink-0 mt-0.5"
        />
      ) : (
        <div className="h-9 w-9 rounded-full bg-accent/15 text-accent flex items-center justify-center text-xs font-semibold shrink-0 mt-0.5">
          {initials || '?'}
        </div>
      )}

      <div className="flex-1 min-w-0">
        {/* Line 1 — name + role/status badges + last activity */}
        <div className="flex items-center flex-wrap gap-x-2 gap-y-1">
          <Link
            to={targetHref}
            className="text-sm font-semibold text-foreground hover:text-accent transition-colors"
          >
            {person.full_name || 'Unnamed'}
          </Link>
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
              · {lastActivityLabel} {formatSmartTimestamp(lastActivityTs)}
            </span>
          )}
        </div>

        {/* Line 2 — title @ company */}
        {(person.current_title || person.current_company) && (
          <div className="mt-0.5 text-xs text-muted-foreground flex items-center gap-1 min-w-0">
            {person.current_title && <span className="truncate">{person.current_title}</span>}
            {person.current_title && person.current_company && <span aria-hidden>at</span>}
            {person.current_company && (
              <CompanyLink
                companyId={person.company_id}
                name={person.current_company}
                showLogo
                stopPropagation
                className="text-muted-foreground truncate"
              />
            )}
          </div>
        )}

        {/* Line 3 — contact details (the side panel's info, inline) */}
        {(email || phone || linkedin) && (
          <div className="mt-1.5 flex items-center flex-wrap gap-x-4 gap-y-1 text-xs">
            {email && (
              <a
                href={`mailto:${email}`}
                className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-accent transition-colors"
              >
                <Mail className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate max-w-[220px]">{email}</span>
              </a>
            )}
            {phone && (
              <a
                href={`tel:${phone}`}
                className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-accent transition-colors"
              >
                <Phone className="h-3.5 w-3.5 shrink-0" />
                <span>{phone}</span>
              </a>
            )}
            {linkedin && (
              <a
                href={linkedin}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-accent transition-colors"
              >
                <Linkedin className="h-3.5 w-3.5 shrink-0" />
                <span>LinkedIn</span>
              </a>
            )}
            <Link
              to={targetHref}
              className="inline-flex items-center gap-1 text-accent hover:underline font-medium"
            >
              View {role === 'candidate' ? 'candidate' : 'client'}
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
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
