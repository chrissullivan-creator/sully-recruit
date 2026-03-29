import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CampaignStepItem } from '@/components/campaigns/CampaignStepItem';
import { EnrollInSequenceDialog } from '@/components/candidates/EnrollInSequenceDialog';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { useIntegrationAccounts, useCandidates, useContacts, useJobs } from '@/hooks/useData';
import { useProfiles } from '@/hooks/useProfiles';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ArrowLeft, Play, Pause, Plus, Save, Users, UserPlus, Mail, Linkedin, MessageSquare,
  Phone, BarChart3, Loader2, Martini, ShieldAlert, Trash2, Clock, CheckCircle, XCircle, Copy,
  MoreHorizontal, Eye, PauseCircle,
} from 'lucide-react';
import { SequenceAnalytics } from '@/components/campaigns/SequenceAnalytics';
import type { CampaignStep, ChannelType } from '@/types';

const statusColors: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  active: 'bg-success/10 text-success border-success/20',
  paused: 'bg-warning/10 text-warning border-warning/20',
  completed: 'bg-info/10 text-info border-info/20',
};

const channelToStepType = (channel: ChannelType): string => {
  const map: Record<ChannelType, string> = {
    linkedin_recruiter: 'linkedin_inmail', sales_nav: 'linkedin_inmail',
    linkedin_message: 'linkedin_message', linkedin_connection: 'linkedin_connection',
    email: 'email', sms: 'sms', phone: 'call',
  };
  return map[channel] || channel;
};

const channelToDbChannel = (channel: ChannelType): string => {
  if (channel.startsWith('linkedin') || channel === 'sales_nav') return 'linkedin';
  return channel;
};

const dbChannelToChannel = (stepType: string, channel: string | null): ChannelType => {
  if (stepType === 'linkedin_inmail') return 'linkedin_recruiter';
  if (stepType === 'linkedin_message') return 'linkedin_message';
  if (stepType === 'linkedin_connection') return 'linkedin_connection';
  if (channel === 'sms' || stepType === 'sms') return 'sms';
  if (channel === 'phone' || stepType === 'call') return 'phone';
  return 'email';
};

const generateId = () => `step-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

const channelOptions = [
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'email', label: 'Email' },
  { value: 'multi', label: 'Multi-channel' },
];

const SequenceDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: accounts = [] } = useIntegrationAccounts();
  const { data: allCandidates = [] } = useCandidates();
  const { data: allContacts = [] } = useContacts();
  const { data: jobs = [] } = useJobs();
  const { data: profiles = [] } = useProfiles();
  const profileMap = Object.fromEntries(profiles.map(p => [p.id, p]));

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [sequence, setSequence] = useState<any>(null);
  const [enrollments, setEnrollments] = useState<any[]>([]);
  const [executions, setExecutions] = useState<any[]>([]);
  // Editable state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [channel, setChannel] = useState('linkedin');
  const [stopOnReply, setStopOnReply] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);
  const [steps, setSteps] = useState<CampaignStep[]>([]);

  // Enroll dialog
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollType, setEnrollType] = useState<'candidate' | 'contact'>('candidate');

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    if (!id) return;
    loadSequence();
  }, [id]);

  const loadSequence = async () => {
    setLoading(true);
    try {
      const [seqRes, enrollRes] = await Promise.all([
        supabase.from('sequences').select('*, sequence_steps(*)').eq('id', id!).single(),
        supabase.from('sequence_enrollments').select('*, candidates!left(first_name, last_name, full_name, email, current_title, current_company, owner_id), contacts!left(first_name, last_name, full_name, email, title, company_name)').eq('sequence_id', id!).order('enrolled_at', { ascending: false }),
      ]);

      // Fetch executions separately — avoid .in() with hundreds of IDs
      const enrollmentIds = (enrollRes.data ?? []).map((e: any) => e.id);
      let execRes = { data: [] as any[], error: null as any };
      if (enrollmentIds.length > 0) {
        // Batch into chunks of 50 to avoid URL length limits
        const chunks: string[][] = [];
        for (let i = 0; i < enrollmentIds.length; i += 50) {
          chunks.push(enrollmentIds.slice(i, i + 50));
        }
        const allExecs: any[] = [];
        for (const chunk of chunks) {
          const { data, error } = await supabase
            .from('sequence_step_executions')
            .select('*')
            .in('enrollment_id', chunk);
          if (error) { execRes.error = error; break; }
          allExecs.push(...(data ?? []));
        }
        execRes.data = allExecs;
      }

      if (seqRes.error) throw seqRes.error;
      const seq = seqRes.data;
      setSequence(seq);
      setName(seq.name);
      setDescription(seq.description || '');
      setChannel(seq.channel);
      setStopOnReply(seq.stop_on_reply ?? true);
      setJobId(seq.job_id ?? null);

      const dbSteps = ((seq.sequence_steps as any[]) ?? []).sort((a: any, b: any) => a.step_order - b.step_order);
      const loadedSteps: CampaignStep[] = dbSteps.map((s: any) => {
        const ch = dbChannelToChannel(s.step_type, s.channel);
        const isEmail = ch === 'email';
        return {
          id: s.id, order: s.step_order, channel: ch,
          subject: s.subject || undefined, content: s.body || '',
          delayDays: s.delay_days ?? 0, delayHours: s.delay_hours ?? 0,
          sendWindowStart: s.send_window_start ?? 6, sendWindowEnd: s.send_window_end ?? 23,
          waitForConnection: s.wait_for_connection ?? false, minHoursAfterConnection: s.min_hours_after_connection ?? 4,
          isReply: s.is_reply ?? false, useSignature: s.use_signature ?? isEmail,
          accountId: s.account_id || undefined,
          attachments: s.attachments ?? [],
        };
      });
      setSteps(loadedSteps);
      setEnrollments(enrollRes.data ?? []);
      setExecutions(execRes.data ?? []);
    } catch (err: any) {
      toast.error('Failed to load sequence');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim() || !id) return;
    setSaving(true);
    try {
      const { error: seqError } = await supabase.from('sequences').update({
        name: name.trim(), description: description.trim() || null, channel, stop_on_reply: stopOnReply, job_id: jobId,
      } as any).eq('id', id);
      if (seqError) throw seqError;

      // Get existing step IDs to preserve them (keeps execution history linked)
      const { data: existingSteps } = await supabase.from('sequence_steps').select('id').eq('sequence_id', id);
      const existingIds = new Set((existingSteps ?? []).map((s: any) => s.id));

      // Separate steps into updates (have existing DB id) vs new inserts
      const stepsToUpdate: any[] = [];
      const stepsToInsert: any[] = [];
      const keepIds = new Set<string>();

      for (const step of steps) {
        const row = {
          sequence_id: id, step_order: step.order,
          step_type: channelToStepType(step.channel), channel: channelToDbChannel(step.channel),
          delay_days: step.delayDays, delay_hours: step.delayHours,
          send_window_start: step.sendWindowStart, send_window_end: step.sendWindowEnd,
          wait_for_connection: step.waitForConnection, min_hours_after_connection: step.minHoursAfterConnection,
          subject: step.subject || null, body: step.content || null,
          account_id: step.accountId || null,
          is_reply: step.isReply ?? false,
          use_signature: step.useSignature ?? false,
        } as any;

        if (existingIds.has(step.id)) {
          // Existing step — update in place to preserve ID for execution history
          stepsToUpdate.push({ id: step.id, ...row });
          keepIds.add(step.id);
        } else {
          // New step — insert
          stepsToInsert.push(row);
        }
      }

      // Delete steps that were removed
      const deleteIds = [...existingIds].filter(eid => !keepIds.has(eid));
      if (deleteIds.length > 0) {
        await supabase.from('sequence_steps').delete().in('id', deleteIds);
      }

      // Update existing steps
      for (const step of stepsToUpdate) {
        const { id: stepId, ...updates } = step;
        await supabase.from('sequence_steps').update(updates).eq('id', stepId);
      }

      // Insert new steps
      if (stepsToInsert.length > 0) {
        const { error: stepsError } = await supabase.from('sequence_steps').insert(stepsToInsert);
        if (stepsError) throw stepsError;
      }

      queryClient.invalidateQueries({ queryKey: ['sequences'] });
      toast.success('Sequence saved');
      loadSequence();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async () => {
    if (!sequence) return;
    const newStatus = sequence.status === 'active' ? 'paused' : 'active';
    try {
      const { error } = await supabase.from('sequences').update({ status: newStatus } as any).eq('id', id!);
      if (error) throw error;
      setSequence({ ...sequence, status: newStatus });
      queryClient.invalidateQueries({ queryKey: ['sequences'] });
      toast.success(`Sequence ${newStatus === 'active' ? 'activated' : 'paused'}`);
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const removeEnrollment = async (enrollmentId: string) => {
    try {
      const { error } = await supabase.from('sequence_enrollments').delete().eq('id', enrollmentId);
      if (error) throw error;
      setEnrollments(prev => prev.filter(e => e.id !== enrollmentId));
      toast.success('Enrollment removed');
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const handleDuplicate = async () => {
    if (!sequence || !id) return;
    setDuplicating(true);
    try {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const { data: newSeq, error: seqError } = await supabase.from('sequences').insert({
        name: `${name.trim()} (Copy)`,
        description: description.trim() || null,
        channel, stop_on_reply: stopOnReply, job_id: jobId,
        status: 'draft', created_by: userId,
      } as any).select('id').single();
      if (seqError) throw seqError;

      if (steps.length > 0) {
        const rows = steps.map((step) => ({
          sequence_id: newSeq.id, step_order: step.order,
          step_type: channelToStepType(step.channel), channel: channelToDbChannel(step.channel),
          delay_days: step.delayDays, delay_hours: step.delayHours,
          send_window_start: step.sendWindowStart, send_window_end: step.sendWindowEnd,
          wait_for_connection: step.waitForConnection, min_hours_after_connection: step.minHoursAfterConnection,
          subject: step.subject || null, body: step.content || null,
          account_id: step.accountId || null,
          is_reply: step.isReply ?? false, use_signature: step.useSignature ?? false,
        } as any));
        const { error: stepsError } = await supabase.from('sequence_steps').insert(rows);
        if (stepsError) throw stepsError;
      }

      queryClient.invalidateQueries({ queryKey: ['sequences'] });
      toast.success('Sequence duplicated');
      navigate(`/campaigns/${newSeq.id}`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to duplicate');
    } finally {
      setDuplicating(false);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setSteps((items) => {
        const oldIndex = items.findIndex((item) => item.id === active.id);
        const newIndex = items.findIndex((item) => item.id === over.id);
        return arrayMove(items, oldIndex, newIndex).map((item, i) => ({ ...item, order: i + 1 }));
      });
    }
  };

  const addStep = (channel: ChannelType = 'email') => {
    if (channel === 'linkedin_message') {
      const hasConnectionBefore = steps.some(s => s.channel === 'linkedin_connection');
      if (!hasConnectionBefore) {
        toast.error('Add a Connection Request step first — LinkedIn messages require an active connection.');
        return;
      }
    }
    const prevEmailStep = [...steps].reverse().find(s => s.channel === 'email');
    const newStep: CampaignStep = {
      id: generateId(), order: steps.length + 1, channel, content: '',
      delayDays: steps.length === 0 ? 0 : 2, delayHours: 0,
      sendWindowStart: 6, sendWindowEnd: 23, waitForConnection: false,
      minHoursAfterConnection: 4, isReply: channel === 'email' ? !!prevEmailStep : false,
      useSignature: channel === 'email',
    };
    setSteps([...steps, newStep]);
  };

  const updateStep = (stepId: string, updates: Partial<CampaignStep>) => {
    setSteps(steps.map((s) => s.id === stepId ? { ...s, ...updates } : s));
  };

  const deleteStep = (stepId: string) => {
    setSteps(steps.filter(s => s.id !== stepId).map((s, i) => ({ ...s, order: i + 1 })));
  };

  // Stats
  const activeEnrollments = enrollments.filter(e => e.status === 'active').length;
  const completedEnrollments = enrollments.filter(e => e.status === 'completed').length;
  const stoppedEnrollments = enrollments.filter(e => e.status === 'stopped').length;

  if (loading) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center h-full">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </MainLayout>
    );
  }

  if (!sequence) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center h-full">
          <p className="text-muted-foreground">Sequence not found.</p>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      {/* Top bar */}
      <div className="flex items-center gap-3 px-8 py-4 border-b border-border">
        <Button variant="ghost" size="icon" onClick={() => navigate('/campaigns')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-semibold text-foreground truncate">{sequence.name}</h1>
          <p className="text-sm text-muted-foreground">
            {sequence.channel} • {steps.length} steps • {enrollments.length} enrolled
            {jobId && jobs.find((j: any) => j.id === jobId) && <> • <span className="text-gold font-medium">{jobs.find((j: any) => j.id === jobId)?.title}</span></>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleDuplicate} disabled={duplicating}>
            {duplicating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />}
            Duplicate
          </Button>
          <Button variant="ghost" size="sm" onClick={toggleStatus}>
            {sequence.status === 'active' ? <Pause className="h-3.5 w-3.5 text-warning" /> : <Play className="h-3.5 w-3.5 text-success" />}
            {sequence.status === 'active' ? 'Pause' : 'Activate'}
          </Button>
          <Badge className={cn('capitalize border', statusColors[sequence.status])}>{sequence.status}</Badge>
          <Button variant="gold" size="sm" onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <Tabs defaultValue="general" className="h-full flex flex-col">
          <div className="px-8 pt-4">
            <TabsList className="bg-secondary">
              <TabsTrigger value="general" className="gap-1.5"><BarChart3 className="h-3.5 w-3.5" />General</TabsTrigger>
              <TabsTrigger value="steps" className="gap-1.5"><Mail className="h-3.5 w-3.5" />Steps</TabsTrigger>
              <TabsTrigger value="enrollees" className="gap-1.5"><Users className="h-3.5 w-3.5" />Enrollees</TabsTrigger>
            </TabsList>
          </div>

          <ScrollArea className="flex-1">
            {/* General / Stats */}
            <TabsContent value="general" className="px-8 py-6 mt-0 space-y-6">
              {/* Analytics */}
              <SequenceAnalytics
                steps={steps.map(s => ({ id: s.id, order: s.order, channel: s.channel }))}
                enrollments={enrollments.map(e => ({ id: e.id, status: e.status, current_step_order: e.current_step_order }))}
                executions={executions}
              />

              {/* Edit settings */}
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-foreground">Sequence Settings</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Name</Label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>Tagged Job</Label>
                    <Select value={jobId ?? 'none'} onValueChange={(v) => setJobId(v === 'none' ? null : v)}>
                      <SelectTrigger><SelectValue placeholder="No job tagged" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No job tagged</SelectItem>
                        {jobs.map((j: any) => (
                          <SelectItem key={j.id} value={j.id}>{j.title}{j.company_name ? ` — ${j.company_name}` : ''}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Description</Label>
                  <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Brief description..." />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-3">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <Label className="text-sm font-medium">Stop on reply</Label>
                      <p className="text-xs text-muted-foreground">Auto-stop if candidate responds</p>
                    </div>
                  </div>
                  <Switch checked={stopOnReply} onCheckedChange={setStopOnReply} />
                </div>
              </div>
            </TabsContent>

            {/* Steps */}
            <TabsContent value="steps" className="px-8 py-6 mt-0">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-foreground">Sequence Steps ({steps.length})</h3>
                <Button variant="gold-outline" size="sm" onClick={addStep}>
                  <Plus className="h-4 w-4 mr-1" /> Add Step
                </Button>
              </div>

              {steps.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <Martini className="h-10 w-10 text-muted-foreground mb-3" />
                  <p className="text-muted-foreground mb-1">No steps yet</p>
                  <p className="text-sm text-muted-foreground">Add steps to build your outreach sequence.</p>
                </div>
              ) : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={steps.map(s => s.id)} strategy={verticalListSortingStrategy}>
                    <div className="space-y-3">
                      {steps.map((step, index) => (
                        <CampaignStepItem
                          key={step.id}
                          step={step}
                          index={index}
                          allSteps={steps}
                          accounts={accounts}
                          onUpdate={updateStep}
                          onDelete={deleteStep}
                          jobTitle={jobId ? (jobs.find((j: any) => j.id === jobId)?.title ?? undefined) : undefined}
                          jobCompany={jobId ? (jobs.find((j: any) => j.id === jobId)?.company_name ?? undefined) : undefined}
                          sequenceName={name}
                          sequenceDescription={description || undefined}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </TabsContent>

            {/* Enrollees */}
            <TabsContent value="enrollees" className="px-8 py-6 mt-0">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-foreground">Enrolled ({enrollments.length})</h3>
                <div className="flex gap-2">
                  {enrollments.some(e => e.status === 'active') && (
                    <Button variant="outline" size="sm" onClick={async () => {
                      const activeIds = enrollments.filter(e => e.status === 'active').map(e => e.id);
                      for (const eid of activeIds) {
                        await supabase.from('sequence_enrollments').update({ status: 'paused', paused_at: new Date().toISOString() } as any).eq('id', eid);
                      }
                      loadSequence();
                      toast.success(`Paused ${activeIds.length} enrollments`);
                    }}>
                      <PauseCircle className="h-4 w-4 mr-1" /> Pause All
                    </Button>
                  )}
                  {enrollments.some(e => e.status === 'paused') && (
                    <Button variant="outline" size="sm" onClick={async () => {
                      const pausedIds = enrollments.filter(e => e.status === 'paused').map(e => e.id);
                      for (const eid of pausedIds) {
                        await supabase.from('sequence_enrollments').update({ status: 'active', paused_at: null } as any).eq('id', eid);
                      }
                      loadSequence();
                      toast.success(`Resumed ${pausedIds.length} enrollments`);
                    }}>
                      <Play className="h-4 w-4 mr-1" /> Resume All
                    </Button>
                  )}
                  <Button variant="gold-outline" size="sm" onClick={() => { setEnrollType('candidate'); setEnrollOpen(true); }}>
                    <UserPlus className="h-4 w-4 mr-1" /> Add Candidates
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => { setEnrollType('contact'); setEnrollOpen(true); }}>
                    <UserPlus className="h-4 w-4 mr-1" /> Add Contacts
                  </Button>
                </div>
              </div>

              {/* Summary stats */}
              {enrollments.length > 0 && (() => {
                const replied = enrollments.filter(e => executions.some(x => x.enrollment_id === e.id && (x.status === 'replied' || x.status === 'clicked'))).length;
                const opened = enrollments.filter(e => executions.some(x => x.enrollment_id === e.id && (x.status === 'opened'))).length;
                const bounced = enrollments.filter(e => executions.some(x => x.enrollment_id === e.id && (x.status === 'bounced' || x.status === 'failed'))).length;
                const noResponse = enrollments.length - replied - bounced;
                return (
                  <p className="text-xs text-muted-foreground mb-4">
                    {enrollments.length} enrolled
                    {replied > 0 && <> · <span className="text-[#2A5C42] font-medium">{replied} replied</span></>}
                    {opened > 0 && <> · <span className="text-[#C9A84C] font-medium">{opened} opened</span></>}
                    {bounced > 0 && <> · <span className="text-[#DC2626] font-medium">{bounced} bounced</span></>}
                    {noResponse > 0 && <> · {noResponse} no response</>}
                  </p>
                );
              })()}

              {enrollments.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <Users className="h-10 w-10 text-muted-foreground mb-3" />
                  <p className="text-muted-foreground mb-1">No enrollees yet</p>
                  <p className="text-sm text-muted-foreground">Add candidates or contacts to start the sequence.</p>
                </div>
              ) : (
                <div className="rounded-lg border border-border overflow-hidden">
                  <table className="w-full">
                    <thead className="bg-secondary">
                      <tr>
                        <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Name</th>
                        <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Company</th>
                        <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Last Step</th>
                        <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Last Sent</th>
                        <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Next Step</th>
                        <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
                        <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Result</th>
                        <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Connection</th>
                        <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Sentiment</th>
                        <th className="w-10 px-4 py-2.5"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {enrollments.map((enrollment) => {
                        const person = enrollment.candidates || enrollment.contacts;
                        const personName = person?.full_name || `${person?.first_name ?? ''} ${person?.last_name ?? ''}`.trim() || 'Unknown';
                        const company = enrollment.candidates?.current_company || (enrollment.contacts as any)?.company_name || '';
                        const isCand = !!enrollment.candidate_id;
                        const profileUrl = isCand ? `/candidates/${enrollment.candidate_id}` : null;

                        // Build a map from step ID → step info for resolving execution metadata
                        const stepById = Object.fromEntries(steps.map(s => [s.id, s]));

                        // Find executions for this enrollment
                        const enrollExecs = executions
                          .filter(x => x.enrollment_id === enrollment.id)
                          .sort((a: any, b: any) => (b.executed_at ?? '').localeCompare(a.executed_at ?? ''));
                        const lastExec = enrollExecs[0];

                        // Resolve step metadata from the steps array (executions don't carry step_order/channel)
                        const lastExecStep = lastExec ? stepById[lastExec.sequence_step_id] : null;
                        const lastStepOrder = lastExecStep?.order ?? null;
                        const lastStepChannel = lastExecStep?.channel ?? null;
                        const lastSentAt = lastExec?.executed_at ? format(new Date(lastExec.executed_at), 'MMM d') : '—';

                        // Last result — use status field (tracking fields may not exist on execution rows)
                        const execStatus = lastExec?.status ?? null;
                        const lastResult = execStatus === 'bounced' || execStatus === 'failed' ? 'bounced'
                          : execStatus === 'replied' || execStatus === 'clicked' ? 'replied'
                          : execStatus === 'opened' ? 'opened'
                          : execStatus === 'sent' || execStatus === 'delivered' ? 'sent'
                          : execStatus;

                        // Next step — edge function logic: next = current_step_order + 1
                        // current_step_order=0 means hasn't started, next is step 1
                        // current_step_order=N means step N was last executed, next is N+1
                        const currentOrder = enrollment.current_step_order ?? 0;
                        const nextStepOrder = currentOrder + 1;
                        const nextStep = steps.find(s => s.order === nextStepOrder);
                        const nextAt = enrollment.next_step_at ? format(new Date(enrollment.next_step_at), 'MMM d, h:mm a') : null;

                        const channelLabel = (ch: string | null) => {
                          if (!ch) return '';
                          if (ch === 'linkedin' || ch.startsWith('linkedin')) return 'LinkedIn';
                          if (ch === 'email') return 'Email';
                          if (ch === 'sms') return 'SMS';
                          if (ch === 'phone') return 'Call';
                          return ch;
                        };

                        return (
                          <tr key={enrollment.id} className="hover:bg-muted/30 transition-colors">
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-2">
                                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[10px] font-medium text-accent">
                                  {(person?.first_name?.[0] ?? '')}{(person?.last_name?.[0] ?? '')}
                                </div>
                                <div className="min-w-0">
                                  <p className="text-sm font-medium text-foreground truncate">{personName}</p>
                                  {person?.email && <p className="text-[10px] text-muted-foreground truncate">{person.email}</p>}
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-2.5 text-xs text-muted-foreground truncate max-w-[140px]">{company || '—'}</td>
                            <td className="px-4 py-2.5 text-xs text-muted-foreground">
                              {lastStepOrder ? `Step ${lastStepOrder} — ${channelLabel(lastStepChannel)}` : '—'}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-muted-foreground">{lastSentAt}</td>
                            <td className="px-4 py-2.5 text-xs text-muted-foreground">
                              {enrollment.status === 'active' && nextStep
                                ? <>{`Step ${nextStep.order} — ${channelLabel(nextStep.channel)}`}{nextAt && <span className="text-muted-foreground/60 ml-1">{nextAt}</span>}</>
                                : '—'}
                            </td>
                            <td className="px-4 py-2.5">
                              {enrollment.status === 'active' && <span className="text-xs text-[#2A5C42] font-medium">● Active</span>}
                              {(enrollment.status === 'completed' || enrollment.status === 'finished') && <span className="text-xs text-muted-foreground font-medium">✓ Finished</span>}
                              {enrollment.status === 'paused' && <span className="text-xs text-[#C9A84C] font-medium">⏸ Paused</span>}
                              {enrollment.status === 'stopped' && <span className="text-xs text-[#DC2626] font-medium">✕ Stopped</span>}
                            </td>
                            <td className="px-4 py-2.5">
                              {lastResult === 'replied' && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ color: '#2A5C42', background: '#EAF2EC' }}>Replied ✓</span>}
                              {lastResult === 'opened' && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ color: '#C9A84C', background: '#FBF4E3' }}>Opened</span>}
                              {lastResult === 'bounced' && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ color: '#DC2626', background: '#FEF2F2' }}>Bounced</span>}
                              {lastResult === 'sent' && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ color: '#6B7280', background: '#F3F4F6' }}>Sent</span>}
                              {!lastResult && <span className="text-xs text-muted-foreground">—</span>}
                            </td>
                            <td className="px-4 py-2.5">
                              {(() => {
                                const connStatus = (enrollment as any).linkedin_connection_status;
                                if (connStatus === 'requested' || connStatus === 'pending')
                                  return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ color: '#C9A84C', background: '#FBF4E3' }}>⏳ Awaiting</span>;
                                if (connStatus === 'accepted')
                                  return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ color: '#2A5C42', background: '#EAF2EC' }}>✓ Connected</span>;
                                return <span className="text-xs text-muted-foreground">—</span>;
                              })()}
                            </td>
                            <td className="px-4 py-2.5">
                              {(() => {
                                const sentiment = (enrollment as any).reply_sentiment;
                                if (!sentiment) return <span className="text-xs text-muted-foreground">—</span>;
                                const cfgMap: Record<string, { label: string; color: string; bg: string }> = {
                                  interested:     { label: 'Interested',     color: '#2A5C42', bg: '#EAF2EC' },
                                  positive:       { label: 'Positive',       color: '#16a34a', bg: '#f0fdf4' },
                                  maybe:          { label: 'Maybe',          color: '#C9A84C', bg: '#FBF4E3' },
                                  neutral:        { label: 'Neutral',        color: '#6B7280', bg: '#F3F4F6' },
                                  negative:       { label: 'Negative',       color: '#ea580c', bg: '#fff7ed' },
                                  not_interested: { label: 'Not Interested', color: '#DC2626', bg: '#FEF2F2' },
                                  do_not_contact: { label: 'DNC',            color: '#7f1d1d', bg: '#fef2f2' },
                                };
                                const cfg = cfgMap[sentiment] ?? { label: sentiment.replace(/_/g, ' '), color: '#6B7280', bg: '#F3F4F6' };
                                return (
                                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded capitalize" style={{ color: cfg.color, background: cfg.bg }} title={(enrollment as any).reply_sentiment_note || undefined}>
                                    {cfg.label}
                                  </span>
                                );
                              })()}
                            </td>
                            <td className="px-4 py-2.5">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" className="h-7 w-7"><MoreHorizontal className="h-3.5 w-3.5" /></Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  {profileUrl && (
                                    <DropdownMenuItem onClick={() => navigate(profileUrl)}>
                                      <Eye className="h-3.5 w-3.5 mr-2" /> View Profile
                                    </DropdownMenuItem>
                                  )}
                                  {enrollment.status === 'active' && (
                                    <DropdownMenuItem onClick={async () => {
                                      await supabase.from('sequence_enrollments').update({ status: 'paused', paused_at: new Date().toISOString() }).eq('id', enrollment.id);
                                      loadSequence();
                                      toast.success('Enrollment paused');
                                    }}>
                                      <PauseCircle className="h-3.5 w-3.5 mr-2" /> Pause
                                    </DropdownMenuItem>
                                  )}
                                  {enrollment.status === 'paused' && (
                                    <DropdownMenuItem onClick={async () => {
                                      await supabase.from('sequence_enrollments').update({ status: 'active', paused_at: null }).eq('id', enrollment.id);
                                      loadSequence();
                                      toast.success('Enrollment resumed');
                                    }}>
                                      <Play className="h-3.5 w-3.5 mr-2" /> Resume
                                    </DropdownMenuItem>
                                  )}
                                  <DropdownMenuItem className="text-destructive" onClick={() => removeEnrollment(enrollment.id)}>
                                    <Trash2 className="h-3.5 w-3.5 mr-2" /> Remove
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </TabsContent>
          </ScrollArea>
        </Tabs>
      </div>

      {/* Enroll Dialog – reuse existing dialog for candidates */}
      <EnrollInSequenceDialog
        open={enrollOpen}
        onOpenChange={(open) => {
          setEnrollOpen(open);
          if (!open) loadSequence(); // Refresh enrollments after closing
        }}
        candidateIds={[]}
        candidateNames={[]}
        preselectedSequenceId={id}
      />
    </MainLayout>
  );
};

export default SequenceDetail;
