import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { FileText, Search, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TemplatePickerPopoverProps {
  onInsert: (template: { subject?: string; body: string }) => void;
  channel?: string;
}

interface MessageTemplate {
  id: string;
  name: string;
  subject: string | null;
  body: string;
  channel: string;
  category: string | null;
}

export function TemplatePickerPopover({ onInsert, channel }: TemplatePickerPopoverProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['message_templates', 'picker'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('message_templates')
        .select('id, name, subject, body, channel, category')
        .order('name', { ascending: true });
      if (error) throw error;
      return data as MessageTemplate[];
    },
    enabled: open,
  });

  const filtered = templates.filter((t) => {
    const matchesChannel = !channel || t.channel === 'all' || t.channel === channel;
    const matchesSearch = !search || t.name.toLowerCase().includes(search.toLowerCase());
    return matchesChannel && matchesSearch;
  });

  const handleSelect = (t: MessageTemplate) => {
    onInsert({
      subject: t.subject ?? undefined,
      body: t.body,
    });
    setOpen(false);
    setSearch('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <FileText className="h-3.5 w-3.5" />
          Templates
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        {/* Search */}
        <div className="p-2 border-b border-border">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search templates..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8 text-sm"
              autoFocus
            />
          </div>
        </div>

        {/* Template list */}
        <div className="max-h-64 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-6 text-center">
              <p className="text-xs text-muted-foreground">
                {search ? 'No templates found.' : 'No templates available.'}
              </p>
            </div>
          ) : (
            filtered.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => handleSelect(t)}
                className={cn(
                  'w-full text-left px-3 py-2.5 hover:bg-muted/60 transition-colors',
                  'border-b border-border last:border-b-0',
                )}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-medium text-foreground truncate">{t.name}</span>
                  <Badge variant="secondary" className="text-[10px] shrink-0 capitalize">
                    {t.channel}
                  </Badge>
                </div>
                {t.subject && (
                  <p className="text-xs text-muted-foreground truncate">
                    {t.subject}
                  </p>
                )}
                {t.category && (
                  <p className="text-[10px] text-muted-foreground/70 mt-0.5">{t.category}</p>
                )}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default TemplatePickerPopover;
