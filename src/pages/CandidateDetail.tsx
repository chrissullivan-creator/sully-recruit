import { useParams, useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { EnrollInSequenceDialog } from '@/components/candidates/EnrollInSequenceDialog';
import { TaskSidebar } from '@/components/tasks/TaskSidebar';
import { useCandidate, useNotes, useCandidateConversations, useJobs } from '@/hooks/useData';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useState, useEffect } from 'react';
import {
  ArrowLeft, Mail, Phone, Linkedin, Building, MapPin,
  Edit, Briefcase, MessageSquare, History, User, Play,
  FileText, Sparkles, Loader2, Save, X, ExternalLink, RefreshCw,
  ChevronDown, ChevronUp,
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

function JoeSaysContent({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <div className="space-y-1">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={i} className="h-1" />;
        if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
          return <h4 key={i} className="text-sm font-semibold text-accent mt-4 first:mt-0">{trimmed.replace(/\*\*/g, '')}</h4>;
        }
        if (trimmed.startsWith('- ') || trimmed.startsWith('• ')) {
          return (
            <div key={i} className="flex items-start gap-2 text-sm text-foreground">
              <span className="text-accent mt-0.5 shrink-0">•</span>
              <span>{trimmed.replace(/^[-•]\s+/, '')}</span>
            </div>
          );
        }
        return <p key={i} className="text-sm text-foreground">{trimmed}</p>;
      })}
    </div>
  );
}

function EditField({ label, value, onChange, type = 'text', placeholder }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder ?? label} className="h-8 text-sm" />
    </div>
  );
}

const CandidateDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: candidate, isLoading } = useCandidate(id);
  const { data: jobs = [] } = useJobs();
  const openJobs = (jobs as any[]).filter(j => ['open','warm','hot'].includes(j.status));
  const { data: notes = [] } = useNotes(id, 'candidate');
  const { data: conversations = [] } = useCandidateConversations(id);

  const [enrollOpen, setEnrollOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [updatingJobStatus, setUpdatingJobStatus] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generatingJoe, setGeneratingJoe] = useState(false);
  const [editData, setEditData] = useState<Record<string, string>>({});
  const [showResume, setShowResume] = useState(false);

  const { data: latestResume } = useQuery({
    queryKey: ['latest_resume', id],
    enabled: !!id,
    queryFn: async () => {
      const { data } = await supabase.from('resumes').select('id, file_path, file_name, created_at')
        .eq('candidate_id', id!).order('created_at', { ascending: false }).limit(1).maybeSingle();
      return data;
    },
  });

  const { data: resumeSignedUrl } = useQuery({
    queryKey: ['resume_url', latestResume?.file_path],
    enabled: !!latestResume?.file_path,
    queryFn: async () => {
      const { data } = await supabase.storage.from('resumes').createSignedUrl(latestResume!.file_path, 3600);
      return data?.signedUrl ?? null;
    },
  });

  useEffect(() => {
    if (candidate && editMode) {
      setEditData({
        first_name: candidate.first_name ?? '',
        last_name: candidate.last_name ?? '',
        email: candidate.email ?? '',
        phone: candidate.phone ?? '',
        linkedin_url: candidate.linkedin_url ?? '',
        current_title: candidate.current_title ?? '',
        current_company: candidate.current_company ?? '',
        location_text: candidate.location_text ?? '',
        current_base_comp: (candidate as any).current_base_comp?.toString() ?? '',
        current_bonus_comp: (candidate as any).current_bonus_comp?.toString() ?? '',
        current_total_comp: (candidate as any).current_total_comp?.toString() ?? '',
        target_base_comp: (candidate as any).target_base_comp?.toString() ?? '',
        target_total_comp: (candidate as any).target_total_comp?.toString() ?? '',
        comp_notes: (candidate as any).comp_notes ?? '',
        reason_for_leaving: (candidate as any).reason_for_leaving ?? '',
        target_roles: (candidate as any).target_roles ?? '',
        target_locations: (candidate as any).target_locations ?? '',
        work_authorization: (candidate as any).work_authorization ?? '',
        relocation_preference: (candidate as any).relocation_preference ?? '',
        back_of_resume_notes: candidate.back_of_resume_notes ?? '',
      });
    }
  }, [candidate, editMode]);

  const updateJobStatus = async (newStatus: string) => {
    if (!id) return;
    setUpdatingJobStatus(true);
    await supabase.from('candidates').update({ job_status: newStatus }).eq('id', id);
    queryClient.invalidateQueries({ queryKey: ['candidate', id] });
    setUpdatingJobStatus(false);
  };

  const set = (field: string) => (v: string) => setEditData(prev => ({ ...prev, [field]: v }));

  const handleSave = async () => {
    if (!id) return;
    setSaving(true);
    const update: Record<string, any> = {};
    Object.entries(editData).forEach(([k, v]) => {
      if (['current_base_comp','current_bonus_comp','current_total_comp','target_base_comp','target_total_comp'].includes(k)) {
        update[k] = v ? parseFloat(v.replace(/,/g, '')) : null;
      } else {
        update[k] = v || null;
      }
    });
    update.full_name = `${editData.first_name ?? ''} ${editData.last_name ?? ''}`.trim();
    const { error } = await supabase.from('candidates').update(update).eq('id', id);
    if (error) { toast.error('Failed to save'); }
    else {
      toast.success('Saved');
      setEditMode(false);
      queryClient.invalidateQueries({ queryKey: ['candidate', id] });
      queryClient.invalidateQueries({ queryKey: ['candidates'] });
    }
    setSaving(false);
  };

  const generateJoeSays = async () => {
    if (!id) return;
    setGeneratingJoe(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-joe-says`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ candidate_id: id }),
        }
      );
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? 'Failed');
      toast.success('Joe Says updated');
      queryClient.invalidateQueries({ queryKey: ['candidate', id] });
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to generate');
    } finally {
      setGeneratingJoe(false);
    }
  };

  const handleSaveNote = async () => {
    if (!noteText.trim() || !id) return;
    setSavingNote(true);
    const { error } = await supabase.from('notes').insert({ entity_id: id, entity_type: 'candidate', note: noteText.trim() });
    if (error) { toast.error('Failed to save note'); }
    else { toast.success('Note saved'); setNoteText(''); queryClient.invalidateQueries({ queryKey: ['notes', 'candidate', id] }); }
    setSavingNote(false);
  };

  if (isLoading) return (
    <MainLayout><div className="flex items-center justify-center h-full"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div></MainLayout>
  );

  if (!candidate) return (
    <MainLayout><div className="flex items-center justify-center h-full"><p className="text-muted-foreground">Candidate not found.</p></div></MainLayout>
  );

  const initials = `${candidate.first_name?.[0] ?? ''}${candidate.last_name?.[0] ?? ''}`;
  const fullName = candidate.full_name ?? `${candidate.first_name ?? ''} ${candidate.last_name ?? ''}`;

  return (
    <MainLayout>
      <div className="flex items-center gap-3 px-8 py-4 border-b border-border">
        <Button variant="ghost" size="icon" onClick={() => navigate('/candidates')}><ArrowLeft className="h-4 w-4" /></Button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-foreground">{fullName}</h1>
          <p className="text-sm text-muted-foreground">
            {candidate.current_title ?? ''}{candidate.current_title && candidate.current_company ? ' at ' : ''}{candidate.current_company ?? ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="gold" size="sm" onClick={() => setEnrollOpen(true)}><Play className="h-3.5 w-3.5 mr-1" />Enroll in Sequence</Button>
          {editMode ? (
            <>
              <Button variant="gold" size="sm" onClick={handleSave} disabled={saving}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />}Save
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditMode(false)}><X className="h-3.5 w-3.5 mr-1" />Cancel</Button>
            </>
          ) : (
            <Button variant="gold-outline" size="sm" onClick={() => setEditMode(true)}><Edit className="h-3.5 w-3.5 mr-1" />Edit</Button>
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar */}
        <aside className="w-72 shrink-0 border-r border-border overflow-y-auto">
          <div className="p-5 space-y-5">
            <div className="flex flex-col items-center text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/10 text-lg font-semibold text-accent mb-2">{initials}</div>
              <Badge variant="secondary" className="capitalize text-xs">{candidate.status}</Badge>
            </div>

            {/* Contact */}
            <section className="space-y-2">
              <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Contact</h3>
              {editMode ? (
                <div className="space-y-2">
                  <EditField label="First Name" value={editData.first_name ?? ''} onChange={set('first_name')} />
                  <EditField label="Last Name" value={editData.last_name ?? ''} onChange={set('last_name')} />
                  <EditField label="Email" value={editData.email ?? ''} onChange={set('email')} type="email" />
                  <EditField label="Phone" value={editData.phone ?? ''} onChange={set('phone')} />
                  <EditField label="LinkedIn URL" value={editData.linkedin_url ?? ''} onChange={set('linkedin_url')} />
                </div>
              ) : (
                <div className="space-y-1.5">
                  {candidate.email && <div className="flex items-center gap-2 text-sm"><Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" /><a href={`mailto:${candidate.email}`} className="hover:text-accent truncate">{candidate.email}</a></div>}
                  {candidate.phone && <div className="flex items-center gap-2 text-sm"><Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" /><span>{candidate.phone}</span></div>}
                  {candidate.linkedin_url && <div className="flex items-center gap-2 text-sm"><Linkedin className="h-3.5 w-3.5 text-muted-foreground shrink-0" /><a href={candidate.linkedin_url} target="_blank" rel="noreferrer" className="hover:text-accent flex items-center gap-1">LinkedIn <ExternalLink className="h-3 w-3" /></a></div>}
                </div>
              )}
            </section>

            {/* Current Role */}
            <section className="space-y-2">
              <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Current Role</h3>
              {editMode ? (
                <div className="space-y-2">
                  <EditField label="Title" value={editData.current_title ?? ''} onChange={set('current_title')} />
                  <EditField label="Company" value={editData.current_company ?? ''} onChange={set('current_company')} />
                  <EditField label="Location" value={editData.location_text ?? ''} onChange={set('location_text')} />
                  <EditField label="Work Auth" value={editData.work_authorization ?? ''} onChange={set('work_authorization')} />
                  <EditField label="Relocation" value={editData.relocation_preference ?? ''} onChange={set('relocation_preference')} />
                  <EditField label="Target Locations" value={editData.target_locations ?? ''} onChange={set('target_locations')} />
                  <EditField label="Target Roles" value={editData.target_roles ?? ''} onChange={set('target_roles')} />
                </div>
              ) : (
                <div className="space-y-1.5">
                  {candidate.current_title && <div className="flex items-center gap-2 text-sm"><Briefcase className="h-3.5 w-3.5 text-muted-foreground shrink-0" /><span>{candidate.current_title}</span></div>}
                  {candidate.current_company && <div className="flex items-center gap-2 text-sm"><Building className="h-3.5 w-3.5 text-muted-foreground shrink-0" /><span>{candidate.current_company}</span></div>}
                  {(candidate.location_text || (candidate as any).location) && <div className="flex items-center gap-2 text-sm"><MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" /><span>{candidate.location_text ?? (candidate as any).location}</span></div>}
                </div>
              )}
            </section>

            {/* Comp */}
            <section className="space-y-2">
              <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Compensation</h3>
              {editMode ? (
                <div className="space-y-2">
                  <EditField label="Current Base" value={editData.current_base_comp ?? ''} onChange={set('current_base_comp')} placeholder="200000" />
                  <EditField label="Current Bonus" value={editData.current_bonus_comp ?? ''} onChange={set('current_bonus_comp')} />
                  <EditField label="Current Total" value={editData.current_total_comp ?? ''} onChange={set('current_total_comp')} />
                  <EditField label="Target Base" value={editData.target_base_comp ?? ''} onChange={set('target_base_comp')} />
                  <EditField label="Target Total" value={editData.target_total_comp ?? ''} onChange={set('target_total_comp')} />
                  <div className="space-y-1"><Label className="text-xs text-muted-foreground">Comp Notes</Label><Textarea value={editData.comp_notes ?? ''} onChange={e => set('comp_notes')(e.target.value)} className="text-sm h-16 resize-none" /></div>
                  <div className="space-y-1"><Label className="text-xs text-muted-foreground">Reason for Leaving</Label><Textarea value={editData.reason_for_leaving ?? ''} onChange={e => set('reason_for_leaving')(e.target.value)} className="text-sm h-16 resize-none" /></div>
                </div>
              ) : (
                <div className="space-y-1 text-sm">
                  {(candidate as any).current_base_comp && <div className="flex justify-between"><span className="text-muted-foreground text-xs">Base</span><span className="font-medium">${Number((candidate as any).current_base_comp).toLocaleString()}</span></div>}
                  {(candidate as any).current_bonus_comp && <div className="flex justify-between"><span className="text-muted-foreground text-xs">Bonus</span><span>${Number((candidate as any).current_bonus_comp).toLocaleString()}</span></div>}
                  {(candidate as any).current_total_comp && <div className="flex justify-between border-t border-border pt-1"><span className="text-muted-foreground text-xs">Total</span><span className="font-semibold text-accent">${Number((candidate as any).current_total_comp).toLocaleString()}</span></div>}
                  {(candidate as any).target_total_comp && <div className="flex justify-between text-xs text-muted-foreground"><span>Target</span><span>${Number((candidate as any).target_total_comp).toLocaleString()}</span></div>}
                  {(candidate as any).reason_for_leaving && <p className="text-xs text-muted-foreground pt-1 border-t border-border"><span className="font-medium text-foreground">Leaving: </span>{(candidate as any).reason_for_leaving}</p>}
                  {!(candidate as any).current_base_comp && !(candidate as any).current_total_comp && <p className="text-xs text-muted-foreground">No comp data</p>}
                </div>
              )}
            </section>

            {/* Job Association */}
            <section className="space-y-2">
              <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Active Job</h3>
              <Select value={candidate.job_id ?? 'none'} onValueChange={async (val) => {
                const newJobId = val === 'none' ? null : val;
                await supabase.from('candidates').update({ job_id: newJobId, job_status: newJobId ? 'new' : null }).eq('id', id!);
                queryClient.invalidateQueries({ queryKey: ['candidate', id] });
                queryClient.invalidateQueries({ queryKey: ['candidates'] });
                toast.success(newJobId ? 'Job assigned' : 'Job removed');
              }}>
                <SelectTrigger className="h-7 text-xs w-full"><SelectValue placeholder="Assign a job…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— None —</SelectItem>
                  {openJobs.map((j: any) => <SelectItem key={j.id} value={j.id}>{j.title}{j.companies?.name ? ` — ${j.companies.name}` : ''}</SelectItem>)}
                </SelectContent>
              </Select>
              {candidate.job_id && (
                <Select value={candidate.job_status ?? ''} onValueChange={updateJobStatus} disabled={updatingJobStatus}>
                  <SelectTrigger className="h-7 text-xs w-full"><SelectValue placeholder="Set status…" /></SelectTrigger>
                  <SelectContent>
                    {JOB_STATUSES.map(s => <SelectItem key={s.value} value={s.value}><span className={cn('px-1.5 py-0.5 rounded text-xs font-medium', s.color)}>{s.label}</span></SelectItem>)}
                  </SelectContent>
                </Select>
              )}
            </section>

            {/* Resume */}
            {latestResume && (
              <section className="space-y-2">
                <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Latest Resume</h3>
                <div className="rounded-md border border-border bg-muted/20 p-2.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <FileText className="h-3.5 w-3.5 text-accent shrink-0" />
                    <span className="text-xs text-foreground truncate flex-1">{latestResume.file_name ?? 'Resume'}</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground">{format(new Date(latestResume.created_at), 'MMM d, yyyy')}</p>
                  <div className="flex gap-1.5">
                    <Button variant="outline" size="sm" className="flex-1 h-6 text-[10px]" onClick={() => setShowResume(!showResume)}>
                      {showResume ? <ChevronUp className="h-3 w-3 mr-1" /> : <ChevronDown className="h-3 w-3 mr-1" />}
                      {showResume ? 'Hide' : 'View'}
                    </Button>
                    {resumeSignedUrl && (
                      <Button variant="outline" size="sm" className="h-6 text-[10px]" asChild>
                        <a href={resumeSignedUrl} target="_blank" rel="noreferrer"><ExternalLink className="h-3 w-3" /></a>
                      </Button>
                    )}
                  </div>
                </div>
              </section>
            )}
          </div>
        </aside>

        {/* Main content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <Tabs defaultValue="joe-says" className="flex-1 flex flex-col overflow-hidden">
            <div className="px-6 pt-4 border-b border-border">
              <TabsList className="bg-secondary">
                <TabsTrigger value="joe-says" className="gap-1.5"><Sparkles className="h-3.5 w-3.5" />Joe Says</TabsTrigger>
                <TabsTrigger value="communications" className="gap-1.5"><MessageSquare className="h-3.5 w-3.5" />Communications</TabsTrigger>
                <TabsTrigger value="notes" className="gap-1.5"><User className="h-3.5 w-3.5" />Notes</TabsTrigger>
                <TabsTrigger value="activity" className="gap-1.5"><History className="h-3.5 w-3.5" />Activity</TabsTrigger>
              </TabsList>
            </div>

            <ScrollArea className="flex-1">
              {/* Joe Says */}
              <TabsContent value="joe-says" className="px-6 py-5 mt-0 space-y-4">
                {showResume && resumeSignedUrl && (
                  <div className="rounded-lg border border-border overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b border-border">
                      <span className="text-xs font-medium">{latestResume?.file_name ?? 'Resume'}</span>
                      <Button variant="ghost" size="sm" className="h-6" onClick={() => setShowResume(false)}><X className="h-3 w-3" /></Button>
                    </div>
                    <iframe src={resumeSignedUrl} className="w-full h-[500px]" title="Resume" />
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-accent" />
                    <h3 className="text-sm font-semibold text-foreground">Joe Says</h3>
                    {(candidate as any).joe_says_updated_at && (
                      <span className="text-[10px] text-muted-foreground">
                        Updated {format(new Date((candidate as any).joe_says_updated_at), 'MMM d, h:mm a')}
                      </span>
                    )}
                  </div>
                  <Button variant="gold-outline" size="sm" onClick={generateJoeSays} disabled={generatingJoe} className="h-7 text-xs">
                    {generatingJoe
                      ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Generating…</>
                      : <><RefreshCw className="h-3 w-3 mr-1" />{(candidate as any).joe_says ? 'Regenerate' : 'Generate'}</>
                    }
                  </Button>
                </div>

                {(candidate as any).joe_says ? (
                  <div className="rounded-lg border border-accent/20 bg-accent/5 p-4">
                    <JoeSaysContent content={(candidate as any).joe_says} />
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-border p-8 text-center space-y-3">
                    <Sparkles className="h-8 w-8 text-muted-foreground mx-auto" />
                    <p className="text-sm text-muted-foreground">No intelligence brief yet.</p>
                    <p className="text-xs text-muted-foreground max-w-xs mx-auto">Joe will analyze the resume, notes, communications, and sequence history to write a structured brief.</p>
                    <Button variant="gold" size="sm" onClick={generateJoeSays} disabled={generatingJoe}>
                      {generatingJoe ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Sparkles className="h-3.5 w-3.5 mr-1" />}
                      Generate Joe Says
                    </Button>
                  </div>
                )}

                <div className="space-y-2 pt-3 border-t border-border">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Back of Resume Notes</h4>
                  {editMode ? (
                    <Textarea value={editData.back_of_resume_notes ?? ''} onChange={e => set('back_of_resume_notes')(e.target.value)} className="text-sm min-h-[100px]" placeholder="Internal notes visible only to recruiters…" />
                  ) : candidate.back_of_resume_notes ? (
                    <p className="text-sm text-foreground whitespace-pre-wrap">{candidate.back_of_resume_notes}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">No back of resume notes. Click Edit to add.</p>
                  )}
                </div>
              </TabsContent>

              {/* Communications */}
              <TabsContent value="communications" className="px-6 py-5 mt-0">
                <div className="flex items-center gap-2 mb-5">
                  <Button variant="outline" size="sm"><Mail className="h-3.5 w-3.5 mr-1" />Email</Button>
                  <Button variant="outline" size="sm"><Phone className="h-3.5 w-3.5 mr-1" />Call</Button>
                  <Button variant="outline" size="sm"><Linkedin className="h-3.5 w-3.5 mr-1" />LinkedIn</Button>
                  <Button variant="outline" size="sm"><MessageSquare className="h-3.5 w-3.5 mr-1" />SMS</Button>
                </div>
                {(conversations as any[]).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No communications yet.</p>
                ) : (
                  <div className="space-y-3">
                    {(conversations as any[]).map((conv: any) => (
                      <div key={conv.id} className="rounded-lg border border-border p-4">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-medium capitalize">{conv.channel}</span>
                          <span className="text-xs text-muted-foreground">{conv.last_message_at ? format(new Date(conv.last_message_at), 'MMM d, yyyy') : ''}</span>
                        </div>
                        {conv.subject && <p className="text-sm mb-1">{conv.subject}</p>}
                        {conv.last_message_preview && <p className="text-xs text-muted-foreground">{conv.last_message_preview}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              {/* Notes */}
              <TabsContent value="notes" className="px-6 py-5 mt-0 space-y-4">
                <div className="space-y-2">
                  <Textarea placeholder="Add a note..." value={noteText} onChange={e => setNoteText(e.target.value)} className="h-24 resize-none text-sm" />
                  <Button variant="gold" size="sm" onClick={handleSaveNote} disabled={savingNote || !noteText.trim()}>
                    {savingNote && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}Save Note
                  </Button>
                </div>
                {(notes as any[]).length > 0 ? (
                  <div className="space-y-3">
                    {(notes as any[]).map((n: any) => (
                      <div key={n.id} className="rounded-md border border-border bg-secondary/50 p-4">
                        <p className="text-sm whitespace-pre-wrap">{n.note}</p>
                        <p className="text-xs text-muted-foreground mt-2">{format(new Date(n.created_at), 'MMM d, yyyy h:mm a')}</p>
                      </div>
                    ))}
                  </div>
                ) : <p className="text-sm text-muted-foreground">No notes yet.</p>}
              </TabsContent>

              {/* Activity */}
              <TabsContent value="activity" className="px-6 py-5 mt-0">
                <p className="text-sm text-muted-foreground">Activity history will appear here.</p>
              </TabsContent>
            </ScrollArea>
          </Tabs>
        </div>

        {id && (
          <div className="w-72 shrink-0 border-l border-border p-4 overflow-y-auto">
            <TaskSidebar entityType="candidate" entityId={id} />
          </div>
        )}
      </div>

      <EnrollInSequenceDialog open={enrollOpen} onOpenChange={setEnrollOpen} candidateIds={id ? [id] : []} candidateNames={[fullName]} />
    </MainLayout>
  );
};

export default CandidateDetail;
