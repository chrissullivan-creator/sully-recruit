import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCandidates } from '@/hooks/useData';
import { useProfiles } from '@/hooks/useProfiles';
import { PipelineColumn, candidateStageColors } from './PipelineColumn';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { Building, MapPin, Mail, Phone, Settings2, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

const stages = [
  { key: 'new', label: 'Lead' },
  { key: 'reached_out', label: 'Reached Out' },
  { key: 'back_of_resume', label: 'Back of Resume' },
  { key: 'pitched', label: 'Pitch' },
  { key: 'send_out', label: 'Send Out' },
  { key: 'submitted', label: 'Submissions' },
  { key: 'interviewing', label: 'Interviewing' },
  { key: 'offer', label: 'Offer' },
  { key: 'placed', label: 'Placed' },
];

interface CardField {
  key: string;
  label: string;
  default: boolean;
}

const CARD_FIELDS: CardField[] = [
  { key: 'title', label: 'Job Title', default: true },
  { key: 'company', label: 'Company', default: true },
  { key: 'location', label: 'Location', default: false },
  { key: 'email', label: 'Email', default: false },
  { key: 'phone', label: 'Phone', default: false },
  { key: 'owner', label: 'Owner', default: false },
  { key: 'updated', label: 'Last Updated', default: false },
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

export function CandidatePipeline() {
  const navigate = useNavigate();
  const { data: candidates = [] } = useCandidates();
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

  const getCandidatesByStage = (stage: string) =>
    candidates.filter((c) => c.status === stage);

  return (
    <div>
      {/* Card settings */}
      <div className="flex justify-end mb-3">
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

      {/* Pipeline columns */}
      <div className="flex gap-4 overflow-x-auto pb-4">
        {stages.map((stage) => {
          const stageCandidates = getCandidatesByStage(stage.key);
          return (
            <PipelineColumn
              key={stage.key}
              title={stage.label}
              count={stageCandidates.length}
              items={stageCandidates}
              stageColor={candidateStageColors[stage.key as keyof typeof candidateStageColors] ?? 'bg-muted text-muted-foreground'}
              renderItem={(candidate) => (
                <div
                  onClick={() => navigate(`/candidates/${candidate.id}`)}
                  className="group cursor-pointer rounded-lg border border-border bg-card p-3 transition-all duration-150 hover:border-accent/50 hover:shadow-md"
                >
                  <div className="flex items-start gap-3">
                    {candidate.avatar_url ? (
                      <img src={candidate.avatar_url} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
                    ) : (
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-medium text-accent">
                        {(candidate.first_name?.[0] ?? '')}{(candidate.last_name?.[0] ?? '')}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <h4 className="text-sm font-medium text-foreground group-hover:text-accent transition-colors truncate">
                        {candidate.full_name ?? `${candidate.first_name ?? ''} ${candidate.last_name ?? ''}`}
                      </h4>
                      {visibleFields.has('title') && (
                        <p className="text-xs text-muted-foreground truncate">{candidate.current_title ?? '-'}</p>
                      )}
                      {visibleFields.has('company') && candidate.current_company && (
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                          <Building className="h-3 w-3 shrink-0" />
                          <span className="truncate">{candidate.current_company}</span>
                        </p>
                      )}
                      {visibleFields.has('location') && (candidate as any).location_text && (
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                          <MapPin className="h-3 w-3 shrink-0" />
                          <span className="truncate">{(candidate as any).location_text}</span>
                        </p>
                      )}
                      {visibleFields.has('email') && candidate.email && (
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                          <Mail className="h-3 w-3 shrink-0" />
                          <span className="truncate">{candidate.email}</span>
                        </p>
                      )}
                      {visibleFields.has('phone') && (candidate as any).phone && (
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                          <Phone className="h-3 w-3 shrink-0" />
                          <span className="truncate">{(candidate as any).phone}</span>
                        </p>
                      )}
                      {visibleFields.has('owner') && (candidate as any).owner_user_id && profileMap[(candidate as any).owner_user_id] && (
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                          <User className="h-3 w-3 shrink-0" />
                          <span className="truncate">{profileMap[(candidate as any).owner_user_id].full_name?.split(' ')[0]}</span>
                        </p>
                      )}
                      {visibleFields.has('updated') && (candidate as any).updated_at && (
                        <p className="text-[10px] text-muted-foreground/70 mt-1">
                          {format(new Date((candidate as any).updated_at), 'MMM d')}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            />
          );
        })}
      </div>
    </div>
  );
}
