import { useParams, useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CommunicationTimeline } from '@/components/candidates/CommunicationTimeline';
import { ActivityHistory } from '@/components/candidates/ActivityHistory';
import { mockCandidates, mockCommunications, mockActivities, mockJobs } from '@/data/mockData';
import {
  ArrowLeft, Mail, Phone, Linkedin, Building, MapPin, Calendar,
  Edit, MoreHorizontal, Tag, Briefcase, MessageSquare, History, User,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import type { CandidateStage } from '@/types';

const stageLabels: Record<CandidateStage, string> = {
  back_of_resume: 'Back of Resume',
  pitch: 'Pitch',
  send_out: 'Send Out',
  submitted: 'Submitted',
  interview: 'Interview',
  first_round: '1st Round',
  second_round: '2nd Round',
  third_plus_round: '3+ Rounds',
  offer: 'Offer',
  accepted: 'Accepted',
  declined: 'Declined',
  counter_offer: 'Counter Offer',
  disqualified: 'Disqualified',
};

const stageColors: Record<CandidateStage, string> = {
  back_of_resume: 'bg-muted text-muted-foreground',
  pitch: 'stage-warm',
  send_out: 'stage-warm',
  submitted: 'stage-interview',
  interview: 'stage-interview',
  first_round: 'stage-interview',
  second_round: 'stage-interview',
  third_plus_round: 'stage-interview',
  offer: 'stage-offer',
  accepted: 'bg-success/10 text-success border-success/20',
  declined: 'bg-destructive/10 text-destructive border-destructive/20',
  counter_offer: 'bg-warning/10 text-warning border-warning/20',
  disqualified: 'bg-muted text-muted-foreground',
};

const stageOrder: CandidateStage[] = [
  'back_of_resume', 'pitch', 'send_out', 'submitted', 'interview',
  'first_round', 'second_round', 'third_plus_round', 'offer', 'accepted',
];

const CandidateDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const candidate = mockCandidates.find((c) => c.id === id);
  if (!candidate) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center h-full">
          <p className="text-muted-foreground">Candidate not found.</p>
        </div>
      </MainLayout>
    );
  }

  const communications = mockCommunications.filter(
    (c) => c.recordId === candidate.id && c.recordType === 'candidate'
  );
  const activities = mockActivities.filter(
    (a) => a.recordId === candidate.id && a.recordType === 'candidate'
  );
  const taggedJob = candidate.taggedJobId
    ? mockJobs.find((j) => j.id === candidate.taggedJobId)
    : null;

  const currentStageIdx = stageOrder.indexOf(candidate.stage);

  return (
    <MainLayout>
      {/* Top bar */}
      <div className="flex items-center gap-3 px-8 py-4 border-b border-border">
        <Button variant="ghost" size="icon" onClick={() => navigate('/candidates')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-foreground">
            {candidate.firstName} {candidate.lastName}
          </h1>
          <p className="text-sm text-muted-foreground">{candidate.currentTitle} at {candidate.currentCompany}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="gold-outline" size="sm">
            <Edit className="h-3.5 w-3.5" />
            Edit
          </Button>
          <Button variant="ghost" size="icon">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar — Profile info */}
        <aside className="w-80 shrink-0 border-r border-border overflow-y-auto">
          <div className="p-6 space-y-6">
            {/* Avatar + stage */}
            <div className="flex flex-col items-center text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-accent/10 text-lg font-semibold text-accent mb-3">
                {candidate.firstName[0]}{candidate.lastName[0]}
              </div>
              <span className={cn('stage-badge', stageColors[candidate.stage])}>
                {stageLabels[candidate.stage]}
              </span>
            </div>

            {/* Contact info */}
            <div className="space-y-3">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Contact</h3>
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-foreground">
                  <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                  <a href={`mailto:${candidate.email}`} className="hover:text-accent truncate">{candidate.email}</a>
                </div>
                {candidate.phone && (
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>{candidate.phone}</span>
                  </div>
                )}
                {candidate.linkedinUrl && (
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    <Linkedin className="h-3.5 w-3.5 text-muted-foreground" />
                    <a href={candidate.linkedinUrl} target="_blank" rel="noreferrer" className="hover:text-accent truncate">LinkedIn</a>
                  </div>
                )}
              </div>
            </div>

            {/* Work */}
            <div className="space-y-3">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Current Role</h3>
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-foreground">
                  <Briefcase className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>{candidate.currentTitle}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-foreground">
                  <Building className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>{candidate.currentCompany}</span>
                </div>
              </div>
            </div>

            {/* Tagged job */}
            {taggedJob && (
              <div className="space-y-3">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Tagged Job</h3>
                <div className="rounded-md border border-border bg-secondary/50 p-3">
                  <p className="text-sm font-medium text-foreground">{taggedJob.title}</p>
                  <p className="text-xs text-muted-foreground">{taggedJob.company} · {taggedJob.location}</p>
                  {taggedJob.salary && <p className="text-xs text-accent mt-1">{taggedJob.salary}</p>}
                </div>
              </div>
            )}

            {/* Skills */}
            <div className="space-y-3">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Skills</h3>
              <div className="flex flex-wrap gap-1.5">
                {candidate.skills.map((skill) => (
                  <Badge key={skill} variant="secondary" className="text-xs">{skill}</Badge>
                ))}
              </div>
            </div>

            {/* Meta */}
            <div className="space-y-3">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Details</h3>
              <div className="space-y-2 text-sm">
                {candidate.source && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Tag className="h-3.5 w-3.5" /> Source: {candidate.source}
                  </div>
                )}
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Calendar className="h-3.5 w-3.5" /> Added {format(candidate.createdAt, 'MMM d, yyyy')}
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Calendar className="h-3.5 w-3.5" /> Updated {format(candidate.updatedAt, 'MMM d, yyyy')}
                </div>
              </div>
            </div>
          </div>
        </aside>

        {/* Main content — stage progress + tabs */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Stage progress bar */}
          <div className="px-8 py-4 border-b border-border">
            <div className="flex items-center gap-1">
              {stageOrder.map((stage, idx) => {
                const isActive = stage === candidate.stage;
                const isPast = idx < currentStageIdx;
                return (
                  <div key={stage} className="flex items-center flex-1">
                    <div
                      className={cn(
                        'h-2 flex-1 rounded-full transition-colors',
                        isPast && 'bg-accent',
                        isActive && 'bg-accent',
                        !isPast && !isActive && 'bg-border',
                      )}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between mt-1.5">
              <span className="text-[10px] text-muted-foreground">Resume</span>
              <span className="text-[10px] text-muted-foreground">Accepted</span>
            </div>
          </div>

          {/* Tabs */}
          <Tabs defaultValue="communications" className="flex-1 flex flex-col overflow-hidden">
            <div className="px-8 pt-4">
              <TabsList className="bg-secondary">
                <TabsTrigger value="communications" className="gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5" />
                  Communications
                </TabsTrigger>
                <TabsTrigger value="activity" className="gap-1.5">
                  <History className="h-3.5 w-3.5" />
                  Activity
                </TabsTrigger>
                <TabsTrigger value="notes" className="gap-1.5">
                  <User className="h-3.5 w-3.5" />
                  Notes
                </TabsTrigger>
              </TabsList>
            </div>

            <ScrollArea className="flex-1">
              <TabsContent value="communications" className="px-8 py-4 mt-0">
                {/* Quick actions */}
                <div className="flex items-center gap-2 mb-6">
                  <Button variant="outline" size="sm"><Mail className="h-3.5 w-3.5" /> Email</Button>
                  <Button variant="outline" size="sm"><Phone className="h-3.5 w-3.5" /> Call</Button>
                  <Button variant="outline" size="sm"><Linkedin className="h-3.5 w-3.5" /> LinkedIn</Button>
                  <Button variant="outline" size="sm"><MessageSquare className="h-3.5 w-3.5" /> SMS</Button>
                </div>
                <CommunicationTimeline communications={communications} />
              </TabsContent>

              <TabsContent value="activity" className="px-8 py-4 mt-0">
                <ActivityHistory activities={activities} />
              </TabsContent>

              <TabsContent value="notes" className="px-8 py-4 mt-0">
                <div className="space-y-4">
                  <textarea
                    placeholder="Add a note..."
                    className="w-full h-28 rounded-lg border border-input bg-background text-foreground p-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                  />
                  <Button variant="gold" size="sm">Save Note</Button>
                  {candidate.notes ? (
                    <div className="rounded-md border border-border bg-secondary/50 p-4">
                      <p className="text-sm text-foreground">{candidate.notes}</p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No notes yet.</p>
                  )}
                </div>
              </TabsContent>
            </ScrollArea>
          </Tabs>
        </div>
      </div>
    </MainLayout>
  );
};

export default CandidateDetail;
