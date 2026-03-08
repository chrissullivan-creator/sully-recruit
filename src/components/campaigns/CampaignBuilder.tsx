import { useState } from 'react';
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
import { Plus, Wand2, Loader2, Martini } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CampaignStepItem } from './CampaignStepItem';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
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

export const CampaignBuilder = ({ open, onOpenChange }: CampaignBuilderProps) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [channel, setChannel] = useState('linkedin');
  const [steps, setSteps] = useState<CampaignStep[]>([]);
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const queryClient = useQueryClient();

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

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

      const aiSteps: CampaignStep[] = (data?.steps ?? []).map((s: any, i: number) => ({
        id: generateId(),
        order: i + 1,
        channel: (s.channel ?? 'email') as ChannelType,
        subject: s.subject ?? undefined,
        content: s.content ?? '',
        delayDays: s.delayDays ?? (i === 0 ? 0 : 2),
      }));

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

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);

    try {
      const { data: seq, error: seqError } = await supabase
        .from('sequences')
        .insert({
          name: name.trim(),
          description: description.trim() || null,
          channel,
          status: 'draft',
        })
        .select('id')
        .single();

      if (seqError) throw seqError;

      if (steps.length > 0) {
        const stepRows = steps.map((step) => ({
          sequence_id: seq.id,
          step_order: step.order,
          step_type: channelToStepType(step.channel),
          channel: channelToDbChannel(step.channel),
          delay_days: step.delayDays,
          subject: step.subject || null,
          body: step.content || null,
        }));

        const { error: stepsError } = await supabase
          .from('sequence_steps')
          .insert(stepRows);

        if (stepsError) throw stepsError;
      }

      toast.success('Campaign created successfully');
      queryClient.invalidateQueries({ queryKey: ['sequences'] });
      resetAndClose();
    } catch (err: any) {
      console.error('Error creating campaign:', err);
      toast.error(err.message || 'Failed to create campaign');
    } finally {
      setSaving(false);
    }
  };

  const resetAndClose = () => {
    setName('');
    setDescription('');
    setChannel('linkedin');
    setSteps([]);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={resetAndClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-xl">Create New Sequence</DialogTitle>
          <DialogDescription>
            Build your multi-channel outreach sequence. Use AI to auto-generate steps or add them manually.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-hidden flex flex-col gap-6 py-4">
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

          <div className="flex-1 flex flex-col min-h-0">
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

            <ScrollArea className="flex-1 pr-4">
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
                          onUpdate={updateStep}
                          onDelete={deleteStep}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </ScrollArea>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={resetAndClose}>
            Cancel
          </Button>
          <Button variant="gold" onClick={handleSave} disabled={!name.trim() || saving}>
            {saving ? 'Creating...' : 'Create Sequence'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
