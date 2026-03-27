import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { TaskSidebar } from './TaskSidebar';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: string;
  entityId: string;
  entityName: string;
}

export function TaskSlidePanel({ open, onOpenChange, entityType, entityId, entityName }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[400px] sm:w-[440px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="text-base">Tasks — {entityName}</SheetTitle>
        </SheetHeader>
        <div className="mt-4">
          <TaskSidebar entityType={entityType} entityId={entityId} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
