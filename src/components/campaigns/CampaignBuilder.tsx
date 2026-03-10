import { useState, useEffect } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { Plus, Loader2, Martini, ShieldAlert } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { CampaignStepItem } from './CampaignStepItem';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { useIntegrationAccounts } from '@/hooks/useData';
import { toast } from 'sonner';
import type { CampaignStep, ChannelType } from '@/types';

const channelOptions: { value: string; label: string }[] = [
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'email', label: 'Email' },
  { value: 'multi', label: 'Multi-channel' },
];

interface CampaignBuilderProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editSequenceId?: string | null;
}

const generateId = () => `step-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

const channelToStepType = (channel: ChannelType): string => {
  const map: Record<ChannelType, string> = {
    linkedin_recruiter: 'linkedin_inmail',
    sales_nav: 'linkedin_inmail',
    linkedin_message: 'linkedin_message',
    linkedin_connection: 'linkedin_connection',
    email: 'email',
    sms: 'sms',
    phone: 'call',
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

export const CampaignBuilder = ({ open, onOpenChange, editSequenceId }: CampaignBuilderProps) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [channel, setChannel] = useState('linkedin');
  const [stopOnReply, setStopOnReply] = useState(true);
  const [steps, setSteps] = useState<CampaignStep[]>([]);
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const queryClient = useQueryClient();
  const { data: accounts = [] } = useIntegrationAccounts();

  const isEditMode = !!editSequenceId;

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Load existing sequence for edit mode
  useEffect(() => {
    if (!editSequenceId || !open) return;

    const loadSequence = async () => {
      setLoadingEdit(true);
      try {
        const { data: seq, error: seqError } = await supabase
          .from('sequences')
          .select('*, sequence_steps(*)')
          .eq('id', editSequenceId)
          .single();

        if (seqError) throw seqError;

        setName(seq.name);
        setDescription(seq.description || '');
        setChannel(seq.channel);
        setStopOnReply(seq.stop_on_reply ?? true);

        const dbSteps = ((seq.sequence_steps as any[]) ?? [])
          .sort((a: any, b: any) => a.step_order - b.step_order);

        const loadedSteps: CampaignStep[] = dbSteps.map((s: any) => {
          const ch = dbChannelToChannel(s.step_type, s.channel);
          const isEmail = ch === 'email';

          return {
            id: s.id,
            order: s.step_order,
            channel: ch,
            subject: s.subject || undefined,
            content: s.body || '',
            delayDays: s.delay_days ?? 0,
            delayHours: s.delay_hours ?? 0,
            sendWindowStart: s.send_window_start ?? 6,
            sendWindowEnd: s.send_window_end ?? 23,
            waitForConnection: s.wait_for_connection ?? false,
            minHoursAfterConnection: s.min_hours_after_connection ?? 4,
            isReply: s.is_reply ?? false,
            useSignature: s.use_signature ?? isEmail,
            accountId: s.account_id || undefined,
          };
        });

        setSteps(loadedSteps);
      } catch (err: any) {
        console.error('Failed to load sequence:', err);
        toast.error('Failed to load sequence');
      } finally {
        setLoadingEdit(false);
      }
    };

    loadSequence();
  }, [editSequenceId, open]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setSteps((items) => {
        const oldIndex = items.findIndex((item) => item.id === active.id);
        const newIndex = items.findIndex((item) => item.id === over.id);
        const newItems = arrayMove(items, oldIndex, newIndex);
        return newItems.map((item, index) => ({ ...item, order: index + 1 }));
      });
    }
  };

  const addStep = () => {
    const prevEmailStep = [...steps].reverse().find(s => s.channel === 'email');
    const isFollowUpEmail = !!prevEmailStep;

    const newStep: CampaignStep = {
      id: generateId(),
      order: steps.length + 1,
      channel: 'email',
      content: '',
      delayDays: steps.length === 0 ? 0 : 2,
      delayHours: 0,
      sendWindowStart: 6,
      sendWindowEnd: 23,
      waitForConnection: false,
      minHoursAfterConnection: 4,
      isReply: isFollowUpEmail,
      useSignature: true,
    };
    setSteps([...steps, newStep]);
  };

  const updateStep = (id: string, updates: Partial<CampaignStep>) => {
    setSteps(steps.map((step) =>
      step.id === id ? { ...step, ...updates } : step
    ));
  };

  const deleteStep = (id: string) => {
    setSteps(
      steps
        .filter((step) => step.id !== id)
        .map((step, index) => ({ ...step, order: index + 1 }))
    );
  };

  const handleAiSuggest = async () => {
    if (!name.trim()) {
      toast.error('Enter a campaign name first so AI can generate relevant steps.');
      return;
    }

    setSuggesting(true);
    try {
      const { data, error } = await supabase.functions.invoke('suggest-campaign-steps', {
        body: {
          campaignName: name,
          campaignChannel: channel,
          campaignDescription: description,
        },
      });

      if (error) throw error;

      if (data?.error) {
        toast.error(data.error);
        return;
      }

      let seenFirstEmail = false;
      const aiSteps: CampaignStep[] = (data?.steps ?? []).map((s: any, i: number) => {
        const ch = (s.channel ?? 'email') as ChannelType;
        const isEmail = ch === 'email';
        const isReply = isEmail && seenFirstEmail && !s.subject;
        if (isEmail) seenFirstEmail = true;

        return {
          id: generateId(),
          order: i + 1,
          channel: ch,
          subject: s.subject ?? undefined,
          content: s.content ?? '',
          delayDays: s.delayDays ?? (i === 0 ? 0 : 2),
          delayHours: 0,
          sendWindowStart: 6,
          sendWindowEnd: 23,
          waitForConnection: false,
          minHoursAfterConnection: 4,
          isReply,
          useSignature: isEmail,
        };
      });

      if (aiSteps.length === 0) {
        toast.error('AI returned no steps. Try a more descriptive campaign name.');
        return;
      }

      setSteps(aiSteps);
      toast.success(`AI generated ${aiSteps.length} steps`);
    } catch (err: any) {
      console.error('AI suggest error:', err);
      toast.error(err.message || 'Failed to generate steps');
    } finally {
      setSuggesting(false);
    }
  };

  const buildStepRows = (sequenceId: string) =>
    steps.map((step) => ({
      sequence_id: sequenceId,
      step_order: step.order,
      step_type: channelToStepType(step.channel),
      channel: channelToDbChannel(step.channel),
      delay_days: step.delayDays,
      delay_hours: step.delayHours,
      send_window_start: step.sendWindowStart,
      send_window_end: step.sendWindowEnd,
      wait_for_connection: step.waitForConnection,
      min_hours_after_connection: step.minHoursAfterConnection,
      subject: step.subject || null,
      body: step.content || null,
      account_id: step.accountId || null,
      is_reply: step.isReply ?? false,
      use_signature: step.useSignature ?? false,
    } as any));

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);

    try {
      if (isEditMode) {
        // Update existing sequence
        const { error: seqError } = await supabase
          .from('sequences')
          .update({
            name: name.trim(),
            description: description.trim() || null,
            channel,
            stop_on_reply: stopOnReply,
          } as any)
          .eq('id', editSequenceId);

        if (seqError) throw seqError;

        // Delete old steps and re-insert
        const { error: delError } = await supabase
          .from('sequence_steps')
          .delete()
          .eq('sequence_id', editSequenceId);

        if (delError) throw delError;

        if (steps.length > 0) {
          const { error: stepsError } = await supabase
            .from('sequence_steps')
            .insert(buildStepRows(editSequenceId));

          if (stepsError) throw stepsError;
        }

        toast.success('Sequence updated successfully');
      } else {
        // Create new sequence
        const userId = (await supabase.auth.getUser()).data.user?.id;
        const { data: seq, error: seqError } = await supabase
          .from('sequences')
          .insert({
            name: name.trim(),
            description: description.trim() || null,
            channel,
            status: 'draft',
            stop_on_reply: stopOnReply,
            created_by: userId,
          } as any)
          .select('id')
          .single();

        if (seqError) throw seqError;

        if (steps.length > 0) {
          const { error: stepsError } = await supabase
            .from('sequence_steps')
            .insert(buildStepRows(seq.id));

          if (stepsError) throw stepsError;
        }

        toast.success('Sequence created successfully');
      }

      queryClient.invalidateQueries({ queryKey: ['sequences'] });
      resetAndClose();
    } catch (err: any) {
      console.error('Error saving sequence:', err);
      toast.error(err.message || 'Failed to save sequence');
    } finally {
      setSaving(false);
    }
  };

  const resetAndClose = () => {
    setName('');
    setDescription('');
    setChannel('linkedin');
    setStopOnReply(true);
    setSteps([]);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={resetAndClose}>
      <DialogContent className="max-w-3xl h-[90vh] flex flex-col overflow-hidden p-0">
        <DialogHeader className="px-6 pt-6 pb-0 shrink-0">
          <DialogTitle className="text-xl">
            {isEditMode ? 'Edit Sequence' : 'Create New Sequence'}
          </DialogTitle>
          <DialogDescription>
            {isEditMode
              ? 'Modify your sequence steps, timing, and settings.'
              : 'Build your multi-channel outreach sequence. Use AI to auto-generate steps or add them manually.'}
          </DialogDescription>
        </DialogHeader>

        {loadingEdit ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-muted-foreground">Loading sequence...</span>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="campaign-name">Campaign Name</Label>
                <Input
                  id="campaign-name"
                  placeholder="e.g., Q1 Engineering Leaders Outreach"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="campaign-channel">Primary Channel</Label>
                <Select value={channel} onValueChange={setChannel}>
                  <SelectTrigger id="campaign-channel">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {channelOptions.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="campaign-desc">Description (optional)</Label>
              <Input
                id="campaign-desc"
                placeholder="Brief description of this campaign..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            {/* Stop on Reply toggle */}
            <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-muted-foreground" />
                <div>
                  <Label className="text-sm font-medium">Stop sequence on any reply</Label>
                  <p className="text-xs text-muted-foreground">Automatically stop if the candidate responds on any channel (email, LinkedIn, SMS, etc.)</p>
                </div>
              </div>
              <Switch checked={stopOnReply} onCheckedChange={setStopOnReply} />
            </div>

            {/* Steps */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-foreground">
                  Sequence Steps ({steps.length})
                </h3>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleAiSuggest}
                    disabled={suggesting || !name.trim()}
                  >
                    {suggesting ? (
                      <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Generating...</>
                    ) : (
                      <><Martini className="h-4 w-4 mr-1" /> Ask Joe</>
                    )}
                  </Button>
                  <Button variant="gold-outline" size="sm" onClick={addStep}>
                    <Plus className="h-4 w-4 mr-1" />
                    Add Step
                  </Button>
                </div>
              </div>

              {steps.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center mb-4">
                    <Martini className="h-8 w-8 text-muted-foreground" />
                  </div>
                  <p className="text-muted-foreground mb-2">No steps yet</p>
                  <p className="text-sm text-muted-foreground mb-4">
                    Click "AI Suggest" to auto-generate a sequence, or add steps manually.
                  </p>
                </div>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={steps.map((s) => s.id)}
                    strategy={verticalListSortingStrategy}
                  >
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
            </div>
          </div>
        )}

        <DialogFooter className="px-6 py-4 border-t border-border shrink-0 gap-2">
          <Button variant="outline" onClick={resetAndClose}>
            Cancel
          </Button>
          <Button variant="gold" onClick={handleSave} disabled={!name.trim() || saving || loadingEdit}>
            {saving
              ? (isEditMode ? 'Updating...' : 'Creating...')
              : (isEditMode ? 'Update Sequence' : 'Create Sequence')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
