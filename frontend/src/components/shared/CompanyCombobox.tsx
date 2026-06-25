import { useState } from 'react';
import { Check, ChevronsUpDown, Building2, Plus, Loader2 } from 'lucide-react';
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
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateCompanyScope } from '@/lib/invalidate';
import { toast } from 'sonner';

interface Company {
  id: string;
  name: string;
}

interface CompanyComboboxProps {
  companies: Company[];
  value: string;           // company_id or ''
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** When true, typing a name with no match offers a "Create" item that
   *  inserts a companies row and selects it. */
  allowCreate?: boolean;
}

export function CompanyCombobox({
  companies,
  value,
  onChange,
  placeholder = 'Select company...',
  className,
  allowCreate = false,
}: CompanyComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();

  const selected = companies.find((c) => c.id === value);

  const query = search.trim();
  // Only offer create when there's a non-empty query that doesn't already
  // exactly match an existing company name (case-insensitive).
  const hasExact = query
    ? companies.some((c) => c.name.toLowerCase() === query.toLowerCase())
    : false;
  const showCreate = allowCreate && !!query && !hasExact;

  const createCompany = async () => {
    const name = query;
    if (!name) return;
    setCreating(true);
    try {
      const { data, error } = await supabase
        .from('companies')
        .insert({ name })
        .select('id, name')
        .single();
      if (error) {
        // Unique violation — the company already exists. Look it up by name
        // and select that instead of erroring.
        if ((error as any).code === '23505') {
          const { data: existing } = await supabase
            .from('companies')
            .select('id')
            .ilike('name', name)
            .limit(1)
            .maybeSingle();
          if (existing?.id) {
            onChange(existing.id);
            invalidateCompanyScope(queryClient);
            setOpen(false);
            setSearch('');
            return;
          }
        }
        throw error;
      }
      invalidateCompanyScope(queryClient);
      onChange(data.id);
      toast.success(`"${data.name}" created`);
      setOpen(false);
      setSearch('');
    } catch (err: any) {
      toast.error(err.message || 'Failed to create company');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch(''); }}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            'w-full justify-between font-normal bg-background border-input hover:bg-accent/10',
            !selected && 'text-muted-foreground',
            className
          )}
        >
          <span className="flex items-center gap-2 truncate">
            {selected ? (
              <>
                <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{selected.name}</span>
              </>
            ) : (
              placeholder
            )}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        align="start"
      >
        <Command>
          <CommandInput
            placeholder="Search companies..."
            className="h-9"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {!showCreate && <CommandEmpty>No company found.</CommandEmpty>}
            {showCreate && (
              <CommandGroup>
                <CommandItem
                  value={`__create__${query}`}
                  onSelect={createCompany}
                  disabled={creating}
                >
                  {creating ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="mr-2 h-4 w-4" />
                  )}
                  Create &quot;{query}&quot;
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup>
              {/* Clear selection option */}
              <CommandItem
                value="__none__"
                onSelect={() => {
                  onChange('');
                  setOpen(false);
                  setSearch('');
                }}
              >
                <Check
                  className={cn(
                    'mr-2 h-4 w-4',
                    !value ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <span className="text-muted-foreground italic">No company</span>
              </CommandItem>
              {companies.map((company) => (
                <CommandItem
                  key={company.id}
                  value={company.name}          // search matches on name
                  onSelect={() => {
                    onChange(company.id);
                    setOpen(false);
                    setSearch('');
                  }}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4',
                      value === company.id ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {company.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
