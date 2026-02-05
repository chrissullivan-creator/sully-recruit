 import { useSortable } from '@dnd-kit/sortable';
 import { CSS } from '@dnd-kit/utilities';
 import { GripVertical, Mail, MessageSquare, Phone, Linkedin, Users, Trash2, Clock } from 'lucide-react';
 import { Button } from '@/components/ui/button';
 import { Input } from '@/components/ui/input';
 import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
 import { Textarea } from '@/components/ui/textarea';
 import { cn } from '@/lib/utils';
 import type { CampaignStep, ChannelType } from '@/types';
 
 const channelOptions: { value: ChannelType; label: string; icon: React.ReactNode }[] = [
   { value: 'linkedin_recruiter', label: 'LinkedIn Recruiter InMail', icon: <Linkedin className="h-4 w-4" /> },
   { value: 'sales_nav', label: 'Sales Nav InMail', icon: <Linkedin className="h-4 w-4" /> },
   { value: 'linkedin_message', label: 'LinkedIn Message', icon: <MessageSquare className="h-4 w-4" /> },
   { value: 'linkedin_connection', label: 'Connection Request', icon: <Users className="h-4 w-4" /> },
   { value: 'email', label: 'Email', icon: <Mail className="h-4 w-4" /> },
   { value: 'sms', label: 'SMS', icon: <MessageSquare className="h-4 w-4" /> },
   { value: 'phone', label: 'Phone Call', icon: <Phone className="h-4 w-4" /> },
 ];
 
 interface CampaignStepItemProps {
   step: CampaignStep;
   index: number;
   onUpdate: (id: string, updates: Partial<CampaignStep>) => void;
   onDelete: (id: string) => void;
 }
 
 export const CampaignStepItem = ({ step, index, onUpdate, onDelete }: CampaignStepItemProps) => {
   const {
     attributes,
     listeners,
     setNodeRef,
     transform,
     transition,
     isDragging,
   } = useSortable({ id: step.id });
 
   const style = {
     transform: CSS.Transform.toString(transform),
     transition,
   };
 
   const channelInfo = channelOptions.find(c => c.value === step.channel);
 
   return (
     <div
       ref={setNodeRef}
       style={style}
       className={cn(
         'rounded-lg border border-border bg-card p-4 transition-all',
         isDragging && 'opacity-50 shadow-lg ring-2 ring-accent'
       )}
     >
       <div className="flex items-start gap-3">
         {/* Drag Handle */}
         <button
           {...attributes}
           {...listeners}
           className="mt-1 cursor-grab touch-none p-1 text-muted-foreground hover:text-foreground active:cursor-grabbing"
         >
           <GripVertical className="h-5 w-5" />
         </button>
 
         {/* Step Number */}
         <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground text-sm font-semibold">
           {index + 1}
         </div>
 
         {/* Step Content */}
         <div className="flex-1 space-y-3">
           <div className="flex items-center gap-3">
             {/* Channel Select */}
             <Select
               value={step.channel}
               onValueChange={(value: ChannelType) => onUpdate(step.id, { channel: value })}
             >
               <SelectTrigger className="w-[220px]">
                 <SelectValue>
                   <div className="flex items-center gap-2">
                     {channelInfo?.icon}
                     <span>{channelInfo?.label}</span>
                   </div>
                 </SelectValue>
               </SelectTrigger>
               <SelectContent>
                 {channelOptions.map((option) => (
                   <SelectItem key={option.value} value={option.value}>
                     <div className="flex items-center gap-2">
                       {option.icon}
                       <span>{option.label}</span>
                     </div>
                   </SelectItem>
                 ))}
               </SelectContent>
             </Select>
 
             {/* Delay */}
             <div className="flex items-center gap-2">
               <Clock className="h-4 w-4 text-muted-foreground" />
               <Input
                 type="number"
                 min={0}
                 value={step.delayDays}
                 onChange={(e) => onUpdate(step.id, { delayDays: parseInt(e.target.value) || 0 })}
                 className="w-20"
               />
               <span className="text-sm text-muted-foreground">days wait</span>
             </div>
 
             {/* Delete Button */}
             <Button
               variant="ghost"
               size="icon"
               onClick={() => onDelete(step.id)}
               className="ml-auto text-muted-foreground hover:text-destructive"
             >
               <Trash2 className="h-4 w-4" />
             </Button>
           </div>
 
           {/* Subject (for email) */}
           {(step.channel === 'email') && (
             <Input
               placeholder="Email subject line..."
               value={step.subject || ''}
               onChange={(e) => onUpdate(step.id, { subject: e.target.value })}
             />
           )}
 
           {/* Content */}
           <Textarea
             placeholder={
               step.channel === 'phone'
                 ? 'Call script or talking points...'
                 : 'Message content...'
             }
             value={step.content}
             onChange={(e) => onUpdate(step.id, { content: e.target.value })}
             className="min-h-[80px] resize-none"
           />
         </div>
       </div>
     </div>
   );
 };