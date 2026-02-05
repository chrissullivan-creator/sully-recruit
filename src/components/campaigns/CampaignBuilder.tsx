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
 import { Plus, Wand2 } from 'lucide-react';
 import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
 import { Button } from '@/components/ui/button';
 import { Input } from '@/components/ui/input';
 import { Label } from '@/components/ui/label';
 import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
 import { ScrollArea } from '@/components/ui/scroll-area';
 import { CampaignStepItem } from './CampaignStepItem';
 import type { Campaign, CampaignStep, CampaignType, CampaignStatus } from '@/types';
 
 const campaignTypes: { value: CampaignType; label: string }[] = [
   { value: 'candidate_outreach', label: 'Candidate Outreach' },
   { value: 'account_based', label: 'Account Based' },
   { value: 'opportunity_based', label: 'Opportunity Based' },
   { value: 'check_in', label: 'Check-in' },
 ];
 
 interface CampaignBuilderProps {
   open: boolean;
   onOpenChange: (open: boolean) => void;
   campaign?: Campaign;
   onSave: (campaign: Omit<Campaign, 'id' | 'createdAt' | 'updatedAt' | 'enrolledCount' | 'responseRate'>) => void;
 }
 
 const generateId = () => `step-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
 
 export const CampaignBuilder = ({ open, onOpenChange, campaign, onSave }: CampaignBuilderProps) => {
   const [name, setName] = useState(campaign?.name || '');
   const [type, setType] = useState<CampaignType>(campaign?.type || 'candidate_outreach');
   const [status, setStatus] = useState<CampaignStatus>(campaign?.status || 'draft');
   const [steps, setSteps] = useState<CampaignStep[]>(
     campaign?.steps || []
   );
 
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
         // Update order property
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
 
   const handleSave = () => {
     if (!name.trim()) return;
     
     onSave({
       name,
       type,
       status,
       steps,
     });
     onOpenChange(false);
   };
 
   const handleClose = () => {
     onOpenChange(false);
     // Reset form if creating new
     if (!campaign) {
       setName('');
       setType('candidate_outreach');
       setStatus('draft');
       setSteps([]);
     }
   };
 
   return (
     <Dialog open={open} onOpenChange={handleClose}>
       <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
         <DialogHeader>
           <DialogTitle className="text-xl">
             {campaign ? 'Edit Campaign' : 'Create New Campaign'}
           </DialogTitle>
           <DialogDescription>
             Build your multi-channel outreach sequence. Drag steps to reorder.
           </DialogDescription>
         </DialogHeader>
 
         <div className="flex-1 overflow-hidden flex flex-col gap-6 py-4">
           {/* Campaign Details */}
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
               <Label htmlFor="campaign-type">Campaign Type</Label>
               <Select value={type} onValueChange={(value: CampaignType) => setType(value)}>
                 <SelectTrigger id="campaign-type">
                   <SelectValue />
                 </SelectTrigger>
                 <SelectContent>
                   {campaignTypes.map((t) => (
                     <SelectItem key={t.value} value={t.value}>
                       {t.label}
                     </SelectItem>
                   ))}
                 </SelectContent>
               </Select>
             </div>
           </div>
 
           {/* Steps Section */}
           <div className="flex-1 flex flex-col min-h-0">
             <div className="flex items-center justify-between mb-3">
               <h3 className="text-sm font-semibold text-foreground">
                 Sequence Steps ({steps.length})
               </h3>
               <div className="flex items-center gap-2">
                 <Button variant="ghost" size="sm" disabled>
                   <Wand2 className="h-4 w-4 mr-1" />
                   AI Suggest
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
                     <Plus className="h-8 w-8 text-muted-foreground" />
                   </div>
                   <p className="text-muted-foreground mb-2">No steps yet</p>
                   <p className="text-sm text-muted-foreground">
                     Click "Add Step" to start building your sequence
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
           <Button variant="outline" onClick={handleClose}>
             Cancel
           </Button>
           <Button variant="gold" onClick={handleSave} disabled={!name.trim()}>
             {campaign ? 'Save Changes' : 'Create Campaign'}
           </Button>
         </DialogFooter>
       </DialogContent>
     </Dialog>
   );
 };