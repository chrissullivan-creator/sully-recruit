import { useParams, useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { EnrollInSequenceDialog } from '@/components/candidates/EnrollInSequenceDialog';
import { TaskSidebar } from '@/components/tasks/TaskSidebar';
import { useCandidate, useNotes, useCandidateConversations, useJobs } from '@/hooks/useData';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useState, useEffect } from 'react';
import {
  ArrowLeft, Mail, Phone, Linkedin, Building, MapPin, Calendar,
  Edit, MoreHorizontal, Briefcase, MessageSquare, History, User, Play, Target, FileText, Martini,
} from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

const JOB_STATUSES = [
  { value: 'new',          label: 'New',          color: 'bg-slate-500/15 text-slate-400' },
  { value: 'reached_out',  label: 'Reached Out',  color: 'bg-blue-500/15 text-blue-400' },
  { value: 'pitched',      label: 'Pitched',      color: 'bg-indigo-500/15 text-indigo-400' },
  { value: 'send_out',     label: 'Send Out',     color: 'bg-yellow-500/15 text-yellow-400' },
  { value: 'submitted',    label: 'Submitted',    color: 'bg-purple-500/15 text-purple-400' },
  { value: 'interviewing', label: 'Interviewing', color: 'bg-orange-500/15 text-orange-400' },
  { value: 'offer',        label: 'Offer',        color: 'bg-emerald-500/15 text-emerald-400' },
  { value: 'placed',       label: 'Placed',       color: 'bg-green-500/15 text-green-400' },
  { value: 'rejected',     label: 'Rejected',     color: 'bg-red-500/15 text-red-400' },
  { value: 'withdrew',     label: 'Withdrew',     color: 'bg-muted text-muted-foreground' },
];

const CandidateDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: candidate, isLoading } = useCandidate(id);
  const { data: jobs = [] } = useJobs();
  const openJobs = (jobs as any[]).filter(j => j.status === 'open' || j.status === 'warm' || j.status === 'hot');
  const { data: notes = [] } = useNotes(id, 'candidate');
  const { data: conversations = [] } = useCandidateConversations(id);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [saving, setSaving] = useState(false);
  const [jobTitle, setJobTitle] = useState<string | null>(null);
  const [updatingJobStatus, setUpdatingJobStatus] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  // Calculate these early so they're available in useEffect dependencies
  const initials = `${candidate?.first_name?.[0] ?? ''}${candidate?.last_name?.[0] ?? ''}`;
  const fullName = candidate?.full_name ?? `${candidate?.first_name ?? ''} ${candidate?.last_name ?? ''}`;

  // Fetch job title when candidate has a job_id
  useEffect(() => {
    if (!candidate?.job_id) { setJobTitle(null); return; }
    supabase.from('jobs').select('title').eq('id', candidate.job_id).maybeSingle()
      .then(({ data }) => setJobTitle(data?.title ?? null));
  }, [candidate?.job_id]);

  // Generate candidate summary on load
  // TODO: Deploy the generate-candidate-summary Supabase Edge Function
  // Uncomment below once deployed at: supabase/functions/generate-candidate-summary/index.ts
  /*
  useEffect(() => {
    if (!candidate) return;

    const generateSummary = async () => {
      setSummaryLoading(true);
      try {
        const { data, error } = await supabase.functions.invoke('generate-candidate-summary', {
          body: {
            candidateName: fullName,
            communications: conversations || [],
            notes: notes || [],
            jobs: candidate.job_id ? [{ title: candidate.current_title, company: candidate.current_company, job_status: candidate.job_status }] : [],
            currentTitle: candidate.current_title,
            currentCompany: candidate.current_company,
            location: candidate.location,
          },
        });

        if (error) {
          setSummary(null);
        } else if (data?.summary) {
          setSummary(data.summary);
        }
      } catch (err) {
        setSummary(null);
      } finally {
        setSummaryLoading(false);
      }
    };

    generateSummary();
  }, [candidate, notes, conversations, fullName]);
  */

  const updateJobStatus = async (newStatus: string) => {
    if (!id) return;
    setUpdatingJobStatus(true);
    await supabase.from('candidates').update({ job_status: newStatus }).eq('id', id);
    queryClient.invalidateQueries({ queryKey: ['candidate', id] });
    setUpdatingJobStatus(false);
  };

  if (isLoading) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center h-full">
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </MainLayout>
    );
  }

  if (!candidate) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center h-full">
          <p className="text-muted-foreground">Candidate not found.</p>
        </div>
      </MainLayout>
    );
  }

  const handleSaveNote = async () => {
    if (!noteText.trim() || !id) return;
    setSaving(true);
    const { error } = await supabase.from('notes').insert({
      entity_id: id,
      entity_type: 'candidate',
      note: noteText.trim(),
    });
    if (error) {
      toast.error('Failed to save note');
    } else {
      toast.success('Note saved');
      setNoteText('');
      queryClient.invalidateQueries({ queryKey: ['notes', 'candidate', id] });
    }
    setSaving(false);
  };

  return (
    <MainLayout>
      {/* Top bar */}
      <div className="flex items-center gap-3 px-8 py-4 border-b border-border">
        <Button variant="ghost" size="icon" onClick={() => navigate('/candidates')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-foreground">{fullName}</h1>
          <p className="text-sm text-muted-foreground">
            {candidate.current_title ?? ''}{candidate.current_title && candidate.current_company ? ' at ' : ''}{candidate.current_company ?? ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="gold" size="sm" onClick={() => setEnrollOpen(true)}>
            <Play className="h-3.5 w-3.5" />
            Enroll in Sequence
          </Button>
          <Button variant="gold-outline" size="sm">
            <Edit className="h-3.5 w-3.5" />
            Edit
          </Button>
          <Button variant="ghost" size="icon">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Profile section */}
      <div className="px-8 py-6 border-b border-border space-y-6">
        <div className="flex gap-6">
          {/* Picture and basic info */}
          <div className="flex flex-col items-center">
            <div className="flex h-24 w-24 items-center justify-center rounded-full bg-accent/10 text-2xl font-semibold text-accent mb-3">
              {initials}
            </div>
            <Badge variant="secondary" className="capitalize">{candidate.status}</Badge>
          </div>

          {/* Information grid */}
          <div className="flex-1 grid grid-cols-3 gap-6">
            <div className="space-y-3">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Contact</h3>
              <div className="space-y-2">
                {candidate.email && (
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                    <a href={`mailto:${candidate.email}`} className="hover:text-accent truncate">{candidate.email}</a>
                  </div>
                )}
                {candidate.phone && (
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>{candidate.phone}</span>
                  </div>
                )}
                {candidate.linkedin_url && (
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    <Linkedin className="h-3.5 w-3.5 text-muted-foreground" />
                    <a href={candidate.linkedin_url} target="_blank" rel="noreferrer" className="hover:text-accent truncate">LinkedIn</a>
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-3">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Current Role</h3>
              <div className="space-y-2">
                {candidate.current_title && (
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    <Briefcase className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>{candidate.current_title}</span>
                  </div>
                )}
                {candidate.current_company && (
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    <Building className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>{candidate.current_company}</span>
                  </div>
                )}
                {candidate.location && (
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>{candidate.location}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-3">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Details</h3>
              <div className="space-y-2 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <Calendar className="h-3.5 w-3.5" />
                  Added {format(new Date(candidate.created_at), 'MMM d, yyyy')}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs section */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <Tabs defaultValue="communications" className="flex-1 flex flex-col overflow-hidden">
          <div className="px-8 pt-4">
            <TabsList className="bg-secondary">
              <TabsTrigger value="jobs" className="gap-1.5">
                <Briefcase className="h-3.5 w-3.5" />
                Jobs
              </TabsTrigger>
              <TabsTrigger value="sequences" className="gap-1.5">
                <Target className="h-3.5 w-3.5" />
                Sequences
              </TabsTrigger>
              <TabsTrigger value="resume" className="gap-1.5">
                <FileText className="h-3.5 w-3.5" />
                Resume
              </TabsTrigger>
              <TabsTrigger value="what_joe_says" className="gap-1.5">
                <Martini className="h-3.5 w-3.5" />
                What Joe Says
              </TabsTrigger>
              <TabsTrigger value="communications" className="gap-1.5">
                <MessageSquare className="h-3.5 w-3.5" />
                Communications
              </TabsTrigger>
              <TabsTrigger value="notes" className="gap-1.5">
                <User className="h-3.5 w-3.5" />
                Notes
              </TabsTrigger>
            </TabsList>
          </div>

          <ScrollArea className="flex-1">
            <TabsContent value="jobs" className="px-8 py-4 mt-0">
              <div className="space-y-6">
                <div className="space-y-3">
                  <h3 className="text-sm font-medium text-foreground">Active Job</h3>
                  <div className="space-y-2">
                    <Select
                      value={candidate.job_id ?? 'none'}
                      onValueChange={async (val) => {
                        const newJobId = val === 'none' ? null : val;
                        await supabase.from('candidates').update({
                          job_id: newJobId,
                          job_status: newJobId ? 'new' : null,
                        }).eq('id', id!);
                        queryClient.invalidateQueries({ queryKey: ['candidate', id] });
                        queryClient.invalidateQueries({ queryKey: ['candidates'] });
                        toast.success(newJobId ? 'Job assigned' : 'Job removed');
                      }}
                    >
                      <SelectTrigger className="h-9 text-sm w-full max-w-sm">
                        <SelectValue placeholder="Assign a job…" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">— None —</SelectItem>
                        {openJobs.map((j: any) => (
                          <SelectItem key={j.id} value={j.id}>
                            {j.title}{j.companies?.name ? ` — ${j.companies.name}` : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {candidate.job_id && (
                      <Select
                        value={candidate.job_status ?? ''}
                        onValueChange={updateJobStatus}
                        disabled={updatingJobStatus}
                      >
                        <SelectTrigger className="h-9 text-sm w-full max-w-sm">
                          <SelectValue placeholder="Set status…" />
                        </SelectTrigger>
                        <SelectContent>
                          {JOB_STATUSES.map(s => (
                            <SelectItem key={s.value} value={s.value}>
                              <span className={cn('px-1.5 py-0.5 rounded text-xs font-medium', s.color)}>
                                {s.label}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="sequences" className="px-8 py-4 mt-0">
              <div className="space-y-4">
                {/* Placeholder for enrolled sequences */}
                <p className="text-sm text-muted-foreground">No sequences enrolled.</p>
              </div>
            </TabsContent>

            <TabsContent value="resume" className="px-8 py-4 mt-0">
              <p className="text-sm text-muted-foreground">Resume will appear here.</p>
            </TabsContent>

            <TabsContent value="what_joe_says" className="px-8 py-4 mt-0">
              <div className="space-y-4">
                {summaryLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <p className="text-sm text-muted-foreground">Joe is analyzing this candidate...</p>
                  </div>
                ) : summary ? (
                  <div className="rounded-lg border border-border bg-secondary/30 p-6">
                    <div className="flex items-start gap-3">
                      <Martini className="h-5 w-5 text-accent shrink-0 mt-1" />
                      <div>
                        <h3 className="text-sm font-semibold text-foreground mb-3">What Joe Says</h3>
                        <p className="text-sm text-foreground leading-relaxed">{summary}</p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-center py-8">
                    <p className="text-sm text-muted-foreground">Joe hasn't shared his thoughts on this candidate yet.</p>
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="communications" className="px-8 py-4 mt-0">
              <div className="flex items-center gap-2 mb-6">
                <Button variant="outline" size="sm"><Mail className="h-3.5 w-3.5" /> Email</Button>
                <Button variant="outline" size="sm"><Phone className="h-3.5 w-3.5" /> Call</Button>
                <Button variant="outline" size="sm"><Linkedin className="h-3.5 w-3.5" /> LinkedIn</Button>
                <Button variant="outline" size="sm"><MessageSquare className="h-3.5 w-3.5" /> SMS</Button>
              </div>
              {conversations.length === 0 ? (
                <p className="text-sm text-muted-foreground">No communications yet.</p>
              ) : (
                <div className="space-y-4">
                  {conversations.map((conv: any) => (
                    <div key={conv.id} className="rounded-lg border border-border p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium text-foreground capitalize">{conv.channel}</span>
                        <span className="text-xs text-muted-foreground">
                          {conv.last_message_at ? format(new Date(conv.last_message_at), 'MMM d, yyyy') : ''}
                        </span>
                      </div>
                      {conv.subject && <p className="text-sm text-foreground mb-1">{conv.subject}</p>}
                      {conv.last_message_preview && <p className="text-xs text-muted-foreground">{conv.last_message_preview}</p>}
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="notes" className="px-8 py-4 mt-0">
              <div className="space-y-4">
                <textarea
                  placeholder="Add a note..."
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  className="w-full h-28 rounded-lg border border-input bg-background text-foreground p-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                />
                <Button variant="gold" size="sm" onClick={handleSaveNote} disabled={saving || !noteText.trim()}>
                  Save Note
                </Button>
                {notes.length > 0 ? (
                  <div className="space-y-3">
                    {notes.map((n: any) => (
                      <div key={n.id} className="rounded-md border border-border bg-secondary/50 p-4">
                        <p className="text-sm text-foreground">{n.note}</p>
                        <p className="text-xs text-muted-foreground mt-2">
                          {format(new Date(n.created_at), 'MMM d, yyyy h:mm a')}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No notes yet.</p>
                )}
              </div>
            </TabsContent>
          </ScrollArea>
        </Tabs>
      </div>

      <EnrollInSequenceDialog
        open={enrollOpen}
        onOpenChange={setEnrollOpen}
        candidateIds={id ? [id] : []}
        candidateNames={[fullName]}
      />
    </MainLayout>
  );
};

export default CandidateDetail;
