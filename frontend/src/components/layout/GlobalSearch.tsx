import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Search, Users2, Briefcase, Building2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SearchHit {
  type: 'person' | 'job' | 'company';
  id: string;
  primary: string;
  secondary?: string;
  href: string;
}

function useGlobalSearch(query: string) {
  return useQuery({
    queryKey: ['global_search', query],
    enabled: query.trim().length >= 2,
    staleTime: 30_000,
    queryFn: async () => {
      const q = `%${query.trim()}%`;
      // Three small queries in parallel — keep result counts low to stay snappy.
      const [people, jobs, companies] = await Promise.all([
        supabase
          .from('people')
          // Plain people.email retired — alias primary_email and search
          // both typed columns explicitly.
          .select('id, type, full_name, first_name, last_name, current_title, current_company, email:primary_email, title')
          .or(`full_name.ilike.${q},personal_email.ilike.${q},work_email.ilike.${q},current_title.ilike.${q},current_company.ilike.${q}`)
          .limit(8),
        supabase
          .from('jobs')
          .select('id, title, company_name, status')
          .or(`title.ilike.${q},company_name.ilike.${q}`)
          .limit(6),
        supabase
          .from('companies')
          .select('id, name, industry, company_type')
          .or(`name.ilike.${q},industry.ilike.${q}`)
          .limit(6),
      ]);

      const hits: SearchHit[] = [];

      for (const p of people.data ?? []) {
        const isClient = (p as any).type === 'client';
        const name = (p as any).full_name || `${(p as any).first_name ?? ''} ${(p as any).last_name ?? ''}`.trim();
        const title = (p as any).current_title || (p as any).title;
        const company = (p as any).current_company;
        hits.push({
          type: 'person',
          id: (p as any).id,
          primary: name || (p as any).email || 'Unnamed',
          secondary: [title, company].filter(Boolean).join(' · '),
          href: isClient ? `/contacts/${(p as any).id}` : `/candidates/${(p as any).id}`,
        });
      }
      for (const j of jobs.data ?? []) {
        hits.push({
          type: 'job',
          id: j.id,
          primary: j.title || 'Untitled job',
          secondary: [j.company_name, j.status].filter(Boolean).join(' · '),
          href: `/jobs/${j.id}`,
        });
      }
      for (const c of companies.data ?? []) {
        hits.push({
          type: 'company',
          id: c.id,
          primary: c.name || 'Unnamed',
          secondary: [c.industry, c.company_type].filter(Boolean).join(' · '),
          href: `/companies/${c.id}`,
        });
      }
      return hits;
    },
  });
}

export function GlobalSearch() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const wrapRef = useRef<HTMLDivElement>(null);

  const { data: hits = [], isFetching } = useGlobalSearch(query);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // Reset active when hits change
  useEffect(() => { setActive(0); }, [hits.length]);

  const grouped = useMemo(() => {
    const out: { type: SearchHit['type']; label: string; items: SearchHit[] }[] = [];
    const groups: SearchHit['type'][] = ['person', 'job', 'company'];
    for (const t of groups) {
      const items = hits.filter((h) => h.type === t);
      if (items.length === 0) continue;
      const label = t === 'person' ? 'People' : t === 'job' ? 'Jobs' : 'Companies';
      out.push({ type: t, label, items });
    }
    return out;
  }, [hits]);

  const flatList = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);

  const handleSelect = (hit: SearchHit) => {
    setOpen(false);
    setQuery('');
    navigate(hit.href);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (!open || flatList.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, flatList.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    if (e.key === 'Enter')     { e.preventDefault(); handleSelect(flatList[active]); }
    if (e.key === 'Escape')    { setOpen(false); }
  };

  const showResults = open && query.trim().length >= 2;

  return (
    <div ref={wrapRef} className="relative flex-1 max-w-md">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKey}
          placeholder="Search people, jobs, companies…"
          className="w-full h-9 pl-9 pr-9 rounded-lg border border-card-border bg-white text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald/40 focus:border-emerald"
        />
        {isFetching && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />
        )}
      </div>

      {showResults && (
        <div className="absolute top-full mt-1.5 left-0 right-0 rounded-lg border border-card-border bg-white shadow-lg overflow-hidden z-50 max-h-[60vh] overflow-y-auto">
          {flatList.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground text-center">
              {isFetching ? 'Searching…' : 'No matches.'}
            </p>
          ) : grouped.map((g, gi) => (
            <div key={g.type} className={cn(gi > 0 && 'border-t border-card-border')}>
              <p className="px-3 py-1.5 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground bg-page-bg/40">
                {g.label}
              </p>
              {g.items.map((hit) => {
                const flatIndex = flatList.indexOf(hit);
                const isActive = flatIndex === active;
                const Icon = hit.type === 'person' ? Users2 : hit.type === 'job' ? Briefcase : Building2;
                return (
                  <button
                    key={`${hit.type}:${hit.id}`}
                    onMouseEnter={() => setActive(flatIndex)}
                    onClick={() => handleSelect(hit)}
                    className={cn(
                      'w-full flex items-center gap-3 px-3 py-2 text-left transition-colors',
                      isActive ? 'bg-emerald-light/50' : 'hover:bg-emerald-light/30',
                    )}
                  >
                    <Icon className={cn(
                      'h-4 w-4 shrink-0',
                      isActive ? 'text-emerald-dark' : 'text-muted-foreground',
                    )} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-emerald-dark truncate">{hit.primary}</p>
                      {hit.secondary && (
                        <p className="text-[11px] text-muted-foreground truncate">{hit.secondary}</p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
