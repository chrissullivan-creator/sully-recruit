import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ChevronDown } from 'lucide-react';

interface Props<T> {
  items: T[];
  renderItem: (item: T) => React.ReactNode;
  emptyText?: string;
  limit?: number;
}

export function RelatedItems<T>({ items, renderItem, emptyText = 'None', limit = 10 }: Props<T>) {
  const [showAll, setShowAll] = useState(false);
  const displayed = showAll ? items : items.slice(0, limit);

  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyText}</p>;
  }

  return (
    <div className="space-y-1">
      {displayed.map(renderItem)}
      {items.length > limit && !showAll && (
        <Button variant="ghost" size="sm" className="w-full text-xs h-7" onClick={() => setShowAll(true)}>
          <ChevronDown className="h-3 w-3 mr-1" />
          Show {items.length - limit} more
        </Button>
      )}
    </div>
  );
}
