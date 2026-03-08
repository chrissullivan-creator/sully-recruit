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
import { useIntegrationAccounts, useCandidates, useContacts } from '@/hooks/useSupabaseData';
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
  ArrowLeft, Play, Pause, Plus, Save, Users, UserPlus, Mail, Linkedin, MessageSquare,
  Phone, BarChart3, Loader2, Martini, ShieldAlert, Trash2, Clock, CheckCircle, XCircle,
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

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sequence, setSequence] = useState<any>(null);
  const [enrollments, setEnrollments] = useState<any[]>([]);

  // Editable state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [channel, setChannel] = useState('linkedin');
  const [stopOnReply, setStopOnReply] = useState(true);
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
        supabase.from('sequence_enrollments').select('*, candidates(first_name, last_name, full_name, email, current_title), contacts(first_name, last_name, full_name, email, title)').eq('sequence_id', id!).order('enrolled_at', { ascending: false }),
      ]);

      if (seqRes.error) throw seqRes.error;
      const seq = seqRes.data;
      setSequence(seq);
      setName(seq.name);
      setDescription(seq.description || '');
      setChannel(seq.channel);
      setStopOnReply(seq.stop_on_reply ?? true);

      const dbSteps = ((seq.sequence_steps as any[]) ?? []).sort((a: any, b: any) => a.step_order - b.step_order);
      let seenFirstEmail = false;
      const loadedSteps: CampaignStep[] = dbSteps.map((s: any) => {
        const ch = dbChannelToChannel(s.step_type, s.channel);
        const isEmail = ch === 'email';
        const isReply = isEmail && seenFirstEmail && !s.subject;
        if (isEmail) seenFirstEmail = true;
        return {
          id: s.id, order: s.step_order, channel: ch,
          subject: s.subject || undefined, content: s.body || '',
          delayDays: s.delay_days ?? 0, delayHours: s.delay_hours ?? 0,
          sendWindowStart: s.send_window_start ?? 6, sendWindowEnd: s.send_window_end ?? 23,
          waitForConnection: s.wait_for_connection ?? false, minHoursAfterConnection: s.min_hours_after_connection ?? 4,
          isReply, useSignature: isEmail,
          attachments: s.attachments ?? [],
        };
      });
      setSteps(loadedSteps);
      setEnrollments(enrollRes.data ?? []);
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
        name: name.trim(), description: description.trim() || null, channel, stop_on_reply: stopOnReply,
      } as any).eq('id', id);
      if (seqError) throw seqError;

      const { error: delError } = await supabase.from('sequence_steps').delete().eq('sequence_id', id);
      if (delError) throw delError;

      if (steps.length > 0) {
        const rows = steps.map((step) => ({
          sequence_id: id, step_order: step.order,
          step_type: channelToStepType(step.channel), channel: channelToDbChannel(step.channel),
          delay_days: step.delayDays, delay_hours: step.delayHours,
          send_window_start: step.sendWindowStart, send_window_end: step.sendWindowEnd,
          wait_for_connection: step.waitForConnection, min_hours_after_connection: step.minHoursAfterConnection,
          subject: step.subject || null, body: step.content || null,
        } as any));
        const { error: stepsError } = await supabase.from('sequence_steps').insert(rows);
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

  const addStep = () => {
    const prevEmailStep = [...steps].reverse().find(s => s.channel === 'email');
    const newStep: CampaignStep = {
      id: generateId(), order: steps.length + 1, channel: 'email', content: '',
      delayDays: steps.length === 0 ? 0 : 2, delayHours: 0,
      sendWindowStart: 6, sendWindowEnd: 23, waitForConnection: false,
      minHoursAfterConnection: 4, isReply: !!prevEmailStep, useSignature: true,
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
          <p className="text-sm text-muted-foreground">{sequence.channel} • {steps.length} steps • {enrollments.length} enrolled</p>
        </div>
        <div className="flex items-center gap-2">
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
              {/* Stats cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="rounded-lg border border-border bg-card p-4">
                  <p className="text-2xl font-bold text-foreground">{enrollments.length}</p>
                  <p className="text-xs text-muted-foreground">Total Enrolled</p>
                </div>
                <div className="rounded-lg border border-border bg-card p-4">
                  <p className="text-2xl font-bold text-success">{activeEnrollments}</p>
                  <p className="text-xs text-muted-foreground">Active</p>
                </div>
                <div className="rounded-lg border border-border bg-card p-4">
                  <p className="text-2xl font-bold text-info">{completedEnrollments}</p>
                  <p className="text-xs text-muted-foreground">Completed</p>
                </div>
                <div className="rounded-lg border border-border bg-card p-4">
                  <p className="text-2xl font-bold text-destructive">{stoppedEnrollments}</p>
                  <p className="text-xs text-muted-foreground">Stopped</p>
                </div>
              </div>

              {/* Edit settings */}
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-foreground">Sequence Settings</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Name</Label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>Primary Channel</Label>
                    <Select value={channel} onValueChange={setChannel}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {channelOptions.map((c) => (
                          <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
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
                  <Button variant="gold-outline" size="sm" onClick={() => { setEnrollType('candidate'); setEnrollOpen(true); }}>
                    <UserPlus className="h-4 w-4 mr-1" /> Add Candidates
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => { setEnrollType('contact'); setEnrollOpen(true); }}>
                    <UserPlus className="h-4 w-4 mr-1" /> Add Contacts
                  </Button>
                </div>
              </div>

              {enrollments.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <Users className="h-10 w-10 text-muted-foreground mb-3" />
                  <p className="text-muted-foreground mb-1">No enrollees yet</p>
                  <p className="text-sm text-muted-foreground">Add candidates or contacts to start the sequence.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {enrollments.map((enrollment) => {
                    const person = enrollment.candidates || enrollment.contacts;
                    const personName = person?.full_name || `${person?.first_name ?? ''} ${person?.last_name ?? ''}`.trim() || 'Unknown';
                    const statusIcon = enrollment.status === 'active'
                      ? <Clock className="h-3.5 w-3.5 text-warning" />
                      : enrollment.status === 'completed'
                        ? <CheckCircle className="h-3.5 w-3.5 text-success" />
                        : <XCircle className="h-3.5 w-3.5 text-destructive" />;
                    return (
                      <div key={enrollment.id} className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-medium text-accent">
                          {(person?.first_name?.[0] ?? '')}{(person?.last_name?.[0] ?? '')}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{personName}</p>
                          <p className="text-xs text-muted-foreground truncate">{person?.email || person?.title || ''}</p>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          {statusIcon}
                          <span className="capitalize">{enrollment.status}</span>
                          <span>Step {enrollment.current_step_order ?? 1}</span>
                        </div>
                        <span className="text-xs text-muted-foreground">{enrollment.enrolled_at ? format(new Date(enrollment.enrolled_at), 'MMM d') : ''}</span>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => removeEnrollment(enrollment.id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    );
                  })}
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
