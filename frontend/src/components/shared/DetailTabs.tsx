import { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export interface DetailTab {
  id: string;
  label: ReactNode;
  /** Optional count rendered as a small pill after the label. */
  count?: number;
  content: ReactNode;
}

interface DetailTabsProps {
  tabs: DetailTab[];
  defaultTab?: string;
  /** Controlled value (optional). */
  value?: string;
  onValueChange?: (id: string) => void;
  className?: string;
}

/**
 * DetailTabs — the standard tab strip + panels for every entity detail page
 * (Candidate / Contact / Company / Job). Thin wrapper over shadcn Tabs so all
 * detail pages share one tab style: a scrollable underline strip on the sage
 * canvas with white panels below.
 */
export function DetailTabs({ tabs, defaultTab, value, onValueChange, className }: DetailTabsProps) {
  return (
    <Tabs
      defaultValue={defaultTab ?? tabs[0]?.id}
      value={value}
      onValueChange={onValueChange}
      className={cn('w-full', className)}
    >
      <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-none border-b border-card-border bg-transparent p-0">
        {tabs.map((t) => (
          <TabsTrigger
            key={t.id}
            value={t.id}
            className={cn(
              'relative rounded-none border-b-2 border-transparent bg-transparent px-3 py-2.5 text-sm font-medium text-muted-foreground shadow-none',
              'data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:shadow-none',
              'hover:text-foreground',
            )}
          >
            {t.label}
            {t.count !== undefined && (
              <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[11px] font-semibold tabular-nums text-muted-foreground">
                {t.count}
              </span>
            )}
          </TabsTrigger>
        ))}
      </TabsList>

      {tabs.map((t) => (
        <TabsContent key={t.id} value={t.id} className="mt-5 focus-visible:outline-none">
          {t.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
