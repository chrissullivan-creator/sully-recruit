import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useProfiles } from '@/hooks/useProfiles';
import { supabase } from '@/integrations/supabase/client';
import { PipelineColumn } from './PipelineColumn';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { Building, MapPin, Mail, Phone, Settings2, User, Briefcase, Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { CANONICAL_PIPELINE, stageToCanonical, type CanonicalStage } from '@/lib/pipeline';

interface CardField {
  key: string;
  label: string;
  default: boolean;
}

const CARD_FIELDS: CardField[] = [
  { key: 'job',      label: 'Job',          default: true  },
  { key: 'title',    label: 'Title',        default: true  },
  { key: 'company',  label: 'Company',      default: true  },
  { key: 'location', label: 'Location',     default: false },
  { key: 'email',    label: 'Email',        default: false },
  { key: 'phone',    label: 'Phone',        default: false },
  { key: 'owner',    label: 'Owner',        default: false },
  { key: 'updated',  label: 'Last Updated', default: false },
];

const STORAGE_KEY = 'sully-recruit-pipeline-card-fields';

function loadCardFields(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* ignore */ }
  return new Set(CARD_FIELDS.filter(f => f.default).map(f => f.key));
}

function saveCardFields(fields: Set<string>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...fields]));
}

// Per-(candidate, job) row joined with candidate + job display fields.
interface CandidateJobRow {
  id: string;
  pipeline_stage: string | null;
  updated_at: string | null;
  job: { id: string; title: string | null; company_name: string | null } | null;
  candidate: {
    id: string;
    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
    avatar_url: string | null;
    current_title: string | null;
    current_company: string | null;
    location_text: string | null;
    email: string | null;
    phone: string | null;
    owner_user_id: string | null;
    updated_at: string | null;
  } | null;
}

function useCandidateJobsForFunnel() {
  return useQuery({
    queryKey: ['candidate_jobs_funnel'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('candidate_jobs')
        .select(
          'id, pipeline_stage, updated_at, ' +
          'job:jobs(id, title, company_name), ' +
          'candidate:candidates(id, full_name, first_name, last_name, avatar_url, current_title, current_company, location_text, email, phone, owner_user_id, updated_at)',
        )
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as CandidateJobRow[];
    },
  });
}

export function CandidatePipeline() {
  const navigate = useNavigate();
  const { data: rows = [], isLoading } = useCandidateJobsForFunnel();
  const { data: profiles = [] } = useProfiles();
  const profileMap = Object.fromEntries(profiles.map(p => [p.id, p]));
  const [visibleFields, setVisibleFields] = useState<Set<string>>(loadCardFields);

  const toggleField = (key: string) => {
    const next = new Set(visibleFields);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setVisibleFields(next);
    saveCardFields(next);
  };

  const getRowsByStage = (stage: CanonicalStage): CandidateJobRow[] =>
    rows.filter((r) => stageToCanonical(r.pipeline_stage) === stage);

  return (
    <div>
      {/* Header note + card field settings */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-muted-foreground">
          Showing per-(candidate, job) rows by pipeline stage. Matches dashboard funnel.
        </p>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5">
              <Settings2 className="h-3.5 w-3.5" />
              Card Fields
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-52 p-3">
            <p className="text-xs font-medium text-muted-foreground mb-2">Visible fields on cards</p>
            <div className="space-y-2">
              {CARD_FIELDS.map((field) => (
                <label key={field.key} className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={visibleFields.has(field.key)}
                    onCheckedChange={() => toggleField(field.key)}
                  />
                  <span className="text-xs text-foreground">{field.label}</span>
                </label>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading pipeline...
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {CANONICAL_PIPELINE.map((stage) => {
            const stageRows = getRowsByStage(stage.key);
            return (
              <PipelineColumn
                key={stage.key}
                title={stage.label}
                count={stageRows.length}
                items={stageRows}
                stageColor={stage.color.split(' ')[0].replace('/15', '')}
                renderItem={(row) => {
                  const c = row.candidate;
                  if (!c) return null;
                  return (
                    <div
                      onClick={() => navigate(`/candidates/${c.id}`)}
                      className="group cursor-pointer rounded-lg border border-border bg-card p-3 transition-all duration-150 hover:border-accent/50 hover:shadow-md"
                    >
                      <div className="flex items-start gap-3">
                        {c.avatar_url ? (
                          <img src={c.avatar_url} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
                        ) : (
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-medium text-accent">
                            {(c.first_name?.[0] ?? '')}{(c.last_name?.[0] ?? '')}
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <h4 className="text-sm font-medium text-foreground group-hover:text-accent transition-colors truncate">
                            {c.full_name ?? (`${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || '—')}
                          </h4>
                          {visibleFields.has('job') && row.job && (
                            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                              <Briefcase className="h-3 w-3 shrink-0" />
                              <span className="truncate">{row.job.title ?? '—'}</span>
                            </p>
                          )}
                          {visibleFields.has('title') && c.current_title && (
                            <p className="text-xs text-muted-foreground truncate">{c.current_title}</p>
                          )}
                          {visibleFields.has('company') && c.current_company && (
                            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                              <Building className="h-3 w-3 shrink-0" />
                              <span className="truncate">{c.current_company}</span>
                            </p>
                          )}
                          {visibleFields.has('location') && c.location_text && (
                            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                              <MapPin className="h-3 w-3 shrink-0" />
                              <span className="truncate">{c.location_text}</span>
                            </p>
                          )}
                          {visibleFields.has('email') && c.email && (
                            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                              <Mail className="h-3 w-3 shrink-0" />
                              <span className="truncate">{c.email}</span>
                            </p>
                          )}
                          {visibleFields.has('phone') && c.phone && (
                            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                              <Phone className="h-3 w-3 shrink-0" />
                              <span className="truncate">{c.phone}</span>
                            </p>
                          )}
                          {visibleFields.has('owner') && c.owner_user_id && profileMap[c.owner_user_id] && (
                            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                              <User className="h-3 w-3 shrink-0" />
                              <span className="truncate">{profileMap[c.owner_user_id].full_name?.split(' ')[0]}</span>
                            </p>
                          )}
                          {visibleFields.has('updated') && row.updated_at && (
                            <p className="text-[10px] text-muted-foreground/70 mt-1">
                              {format(new Date(row.updated_at), 'MMM d')}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
