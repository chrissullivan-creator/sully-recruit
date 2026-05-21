import { useState, useEffect, useRef } from 'react';
import { Check, ChevronsUpDown, MapPin, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

export interface LocationOption {
  id: string;
  name: string;
}

interface LocationComboboxProps {
  value: LocationOption | null;
  onChange: (value: LocationOption | null) => void;
  onSearch: (query: string) => Promise<LocationOption[]>;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export function LocationCombobox({
  value,
  onChange,
  onSearch,
  placeholder = 'Location (city or region)',
  className,
  disabled,
}: LocationComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LocationOption[]>([]);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  // Debounced async search. seq guard ignores out-of-order responses
  // when the user types fast — only the latest query's results land.
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      return;
    }
    const mySeq = ++seq.current;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const items = await onSearch(trimmed);
        if (seq.current === mySeq) setResults(items);
      } catch {
        if (seq.current === mySeq) setResults([]);
      } finally {
        if (seq.current === mySeq) setLoading(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [query, open, onSearch]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn('relative flex items-center', className)}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className={cn(
              'w-full justify-between font-normal bg-background border-input hover:bg-accent/10',
              !value && 'text-muted-foreground',
            )}
          >
            <span className="flex items-center gap-2 truncate">
              <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{value ? value.name : placeholder}</span>
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        {value && !disabled && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onChange(null); setQuery(''); }}
            className="absolute right-9 text-muted-foreground hover:text-foreground"
            aria-label="Clear location"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search LinkedIn locations…"
            value={query}
            onValueChange={setQuery}
            className="h-9"
          />
          <CommandList>
            {loading && (
              <div className="py-6 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Searching…
              </div>
            )}
            {!loading && query.trim().length >= 2 && results.length === 0 && (
              <CommandEmpty>No locations found.</CommandEmpty>
            )}
            {!loading && query.trim().length < 2 && (
              <div className="py-6 text-center text-xs text-muted-foreground">
                Type at least 2 characters
              </div>
            )}
            {results.length > 0 && (
              <CommandGroup>
                {results.map((loc) => (
                  <CommandItem
                    key={loc.id}
                    value={loc.id}
                    onSelect={() => {
                      onChange(loc);
                      setOpen(false);
                      setQuery('');
                    }}
                  >
                    <Check
                      className={cn(
                        'mr-2 h-4 w-4',
                        value?.id === loc.id ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    {loc.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
