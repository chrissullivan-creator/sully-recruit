import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { CompanyLogo, type CompanyLogoSize } from './CompanyLogo';

/**
 * Reusable, site-wide entity links. Anywhere a candidate, client contact,
 * company, or job is named, wrap it in one of these so the text is clickable
 * and routes to that entity's detail page.
 *
 * Design rules:
 *  - When we can resolve a target id, render a real <Link> (cmd/middle-click
 *    opens a new tab, unlike onClick+navigate).
 *  - When no id is resolvable, render plain text — never a dead link.
 *  - `stopPropagation` keeps a parent row's onClick from also firing when the
 *    link lives inside a clickable table row / card.
 */

// Emerald brand hover affordance, matched to the list-page convention
// (People.tsx etc.). Only applied when the element is an actual link.
const LINK_AFFORDANCE = 'hover:text-emerald hover:underline transition-colors cursor-pointer';

function stopIf(stop: boolean | undefined) {
  return stop ? (e: React.MouseEvent) => e.stopPropagation() : undefined;
}

/* ------------------------------------------------------------------ *
 * Company name normalization — mirrors the DB's normalize_company_name()
 * (migration-defined) so client-side name→id resolution matches the
 * server's people.company_id auto-linking.
 * ------------------------------------------------------------------ */
const COMPANY_SUFFIX_RE =
  /[\s,.]+(inc|incorporated|llc|l\.l\.c|lp|l\.p|llp|ltd|limited|corp|corporation|plc|co)\.?$/;

export function normalizeCompanyName(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = raw.trim().toLowerCase();
  s = s.replace(/^the\s+/, '');
  // The SQL strips the suffix twice (handles e.g. "Foo Co, Inc").
  s = s.replace(COMPANY_SUFFIX_RE, '');
  s = s.replace(COMPANY_SUFFIX_RE, '');
  s = s.replace(/[^a-z0-9]/g, '');
  return s;
}

export interface CompanyEntry {
  name: string | null;
  domain: string | null;
  logoUrl: string | null;
}
export interface CompanyIndex {
  /** normalized company name (and known aliases) → company id */
  nameToId: Map<string, string>;
  /** company id → display details (name / domain / logo) */
  byId: Map<string, CompanyEntry>;
}

/**
 * Lazily-loaded company lookup, cached for the session and shared across every
 * <CompanyLink>. Resolves both directions: a name string → id (when a surface
 * only has the name), and an id → display name/logo (when a surface only has
 * company_id, e.g. an auto-linked person whose company text column is blank).
 * Only fetched when `enabled` (i.e. at least one CompanyLink on the page needs
 * a lookup) — pages whose links carry both id and name never load it.
 */
export function useCompanyNameIndex(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['company_name_index'],
    enabled: opts?.enabled ?? true,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    queryFn: async (): Promise<CompanyIndex> => {
      const nameToId = new Map<string, string>();
      const byId = new Map<string, CompanyEntry>();

      // companies.name (paginate past PostgREST's 1000-row cap).
      const PAGE = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('companies')
          .select('id, name, domain, logo_url')
          .is('deleted_at', null)
          .range(from, from + PAGE - 1);
        if (error) throw error;
        for (const c of data ?? []) {
          const row = c as any;
          byId.set(row.id, { name: row.name, domain: row.domain ?? null, logoUrl: row.logo_url ?? null });
          const key = normalizeCompanyName(row.name);
          if (key && !nameToId.has(key)) nameToId.set(key, row.id);
        }
        if (!data || data.length < PAGE) break;
        from += PAGE;
      }

      // Known aliases ("Millennium" → Millennium Management). alias_normalized
      // is maintained by the DB, so we can key on it directly.
      const { data: aliases } = await supabase
        .from('company_aliases')
        .select('alias_normalized, company_id');
      for (const a of aliases ?? []) {
        const key = (a as any).alias_normalized as string | null;
        if (key && !nameToId.has(key)) nameToId.set(key, (a as any).company_id);
      }

      return { nameToId, byId };
    },
  });
}

/* ------------------------------------------------------------------ *
 * PersonLink — candidate (→ /candidates/:id) or client contact
 * (→ /contacts/:id). Routing is decided from `type` / `sourceTable` /
 * `roles`; defaults to the candidate page when ambiguous.
 * ------------------------------------------------------------------ */
export interface PersonLinkProps {
  id: string | null | undefined;
  name?: string | null;
  /** 'candidate' | 'client' (people.type) */
  type?: string | null;
  /** People-list shape: 'candidate' | 'contact' */
  sourceTable?: string | null;
  roles?: string[] | null;
  className?: string;
  stopPropagation?: boolean;
  title?: string;
  children?: React.ReactNode;
}

export function personHref(id: string, isClient: boolean): string {
  return isClient ? `/contacts/${id}` : `/candidates/${id}`;
}

export function PersonLink({
  id,
  name,
  type,
  sourceTable,
  roles,
  className,
  stopPropagation,
  title,
  children,
}: PersonLinkProps) {
  const label = children ?? name ?? 'Unknown';
  if (!id) return <span className={className} title={title}>{label}</span>;

  // Client when explicitly typed/sourced as client, or roles say client and
  // not also candidate (dual-role people default to the candidate page).
  const isClient =
    type === 'client' ||
    sourceTable === 'contact' ||
    (!!roles && roles.includes('client') && !roles.includes('candidate'));

  return (
    <Link
      to={personHref(id, isClient)}
      onClick={stopIf(stopPropagation)}
      title={title}
      className={cn(LINK_AFFORDANCE, className)}
    >
      {label}
    </Link>
  );
}

/* ------------------------------------------------------------------ *
 * JobLink — → /jobs/:id
 * ------------------------------------------------------------------ */
export interface JobLinkProps {
  id: string | null | undefined;
  title?: string | null;
  className?: string;
  stopPropagation?: boolean;
  children?: React.ReactNode;
}

export function JobLink({ id, title, className, stopPropagation, children }: JobLinkProps) {
  const label = children ?? title ?? 'Untitled job';
  if (!id) return <span className={className}>{label}</span>;
  return (
    <Link
      to={`/jobs/${id}`}
      onClick={stopIf(stopPropagation)}
      className={cn(LINK_AFFORDANCE, className)}
    >
      {label}
    </Link>
  );
}

/* ------------------------------------------------------------------ *
 * CompanyLink — → /companies/:id. Resolves the id from an explicit
 * `companyId`, else from the company-name index. Optionally renders the
 * company logo inline.
 * ------------------------------------------------------------------ */
export interface CompanyLinkProps {
  companyId?: string | null;
  name?: string | null;
  showLogo?: boolean;
  logoSize?: CompanyLogoSize;
  logoUrl?: string | null;
  domain?: string | null;
  className?: string;
  /** className for the logo element */
  logoClassName?: string;
  stopPropagation?: boolean;
  /** rendered when there is no company name at all */
  fallback?: React.ReactNode;
  children?: React.ReactNode;
}

export function CompanyLink({
  companyId,
  name,
  showLogo = false,
  logoSize = 'xs',
  logoUrl,
  domain,
  className,
  logoClassName,
  stopPropagation,
  fallback = '—',
  children,
}: CompanyLinkProps) {
  // Resolve a name when we only have an id, and an id when we only have a name —
  // either way the index lets the link work and show a label.
  const needsResolve = (!companyId && !!name) || (!!companyId && !name);
  const { data: index } = useCompanyNameIndex({ enabled: needsResolve });
  const resolvedId = companyId ?? (name ? index?.nameToId.get(normalizeCompanyName(name)) : undefined);
  const entry = resolvedId ? index?.byId.get(resolvedId) : undefined;

  const displayName = name ?? entry?.name ?? null;
  const displayDomain = domain ?? entry?.domain ?? null;
  const displayLogoUrl = logoUrl ?? entry?.logoUrl ?? null;

  // Nothing to show.
  if (!displayName && !children) {
    return <span className={className}>{fallback}</span>;
  }

  const logo = showLogo ? (
    <CompanyLogo name={displayName ?? ''} domain={displayDomain} logoUrl={displayLogoUrl} size={logoSize} className={logoClassName} />
  ) : null;

  const label = children ?? displayName;

  if (!resolvedId) {
    return (
      <span className={cn(showLogo && 'inline-flex items-center gap-2', className)}>
        {logo}
        {label}
      </span>
    );
  }

  return (
    <Link
      to={`/companies/${resolvedId}`}
      onClick={stopIf(stopPropagation)}
      className={cn(showLogo && 'inline-flex items-center gap-2', LINK_AFFORDANCE, className)}
    >
      {logo}
      {label}
    </Link>
  );
}
