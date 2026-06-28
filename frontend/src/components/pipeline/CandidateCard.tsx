import { Building, Tag } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CompanyLogo } from '@/components/shared/CompanyLogo';
import type { Candidate, CandidateStage } from '@/types';

interface CandidateCardProps {
  candidate: Candidate;
  onClick?: () => void;
}

const stageLabels: Partial<Record<CandidateStage, string>> = {
  back_of_resume: 'Resume',
  pitch: 'Pitch',
  send_out: 'Send Out',
  submitted: 'Submission',
  interview: 'Interview',
  first_round: '1st Round',
  second_round: '2nd Round',
  third_plus_round: '3+ Rounds',
  offer: 'Offer',
  accepted: 'Accepted',
  declined: 'Declined',
  counter_offer: 'Counter',
  disqualified: 'DQ',
};

export function CandidateCard({ candidate, onClick }: CandidateCardProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'group cursor-pointer rounded-2xl border border-card-border bg-card p-3 transition-all duration-200',
        'hover:border-accent/50 hover:shadow-md hover:-translate-y-0.5'
      )}
    >
      <div className="flex items-start gap-3">
        {candidate.avatarUrl ? (
          <img src={candidate.avatarUrl} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover ring-1 ring-card-border" />
        ) : (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-semibold text-accent">
            {candidate.firstName[0]}{candidate.lastName[0]}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-foreground group-hover:text-accent transition-colors truncate">
            {candidate.firstName} {candidate.lastName}
          </h4>
          <p className="text-xs text-muted-foreground truncate">{candidate.currentTitle}</p>
          <p className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5 truncate">
            {candidate.currentCompany ? (
              <CompanyLogo name={candidate.currentCompany} size="xs" />
            ) : (
              <Building className="h-3 w-3" />
            )}
            {candidate.currentCompany}
          </p>
        </div>
      </div>
      
      {candidate.skills.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {candidate.skills.slice(0, 3).map((skill) => (
            <span
              key={skill}
              className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
            >
              {skill}
            </span>
          ))}
          {candidate.skills.length > 3 && (
            <span className="text-[10px] text-muted-foreground">+{candidate.skills.length - 3}</span>
          )}
        </div>
      )}
    </div>
  );
}
