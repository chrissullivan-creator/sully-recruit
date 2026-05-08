import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Tag } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { invalidatePersonScope } from '@/lib/invalidate';
import { toast } from 'sonner';

type PersonRole = 'candidate' | 'client';

interface Props {
  personId: string;
  roles: string[] | null | undefined;
  currentType: 'candidate' | 'client' | null | undefined;
  /** "outline" matches the candidate detail row; "ghost" matches contact detail. */
  variant?: 'outline' | 'ghost';
  size?: 'sm' | 'icon';
}

export function PersonRolesMenu({ personId, roles, currentType, variant = 'outline', size = 'sm' }: Props) {
  const queryClient = useQueryClient();
  const [updating, setUpdating] = useState(false);
  const current = new Set<PersonRole>(
    (roles ?? []).filter((r): r is PersonRole => r === 'candidate' || r === 'client'),
  );
  // Fall back to `type` for older rows whose roles[] never got backfilled.
  if (current.size === 0 && (currentType === 'candidate' || currentType === 'client')) {
    current.add(currentType);
  }

  const toggle = async (role: PersonRole, checked: boolean) => {
    const next = new Set(current);
    if (checked) next.add(role);
    else next.delete(role);

    if (next.size === 0) {
      toast.error('A person must have at least one role. Delete them instead if neither applies.');
      return;
    }

    const nextRoles = Array.from(next);
    // Keep `type` in sync — contacts view filters on it. If the
    // primary type was just removed, flip it to the remaining role.
    const nextType: PersonRole = next.has(currentType as PersonRole)
      ? (currentType as PersonRole)
      : nextRoles[0];

    setUpdating(true);
    const { error } = await supabase
      .from('people')
      .update({ roles: nextRoles, type: nextType } as any)
      .eq('id', personId);
    setUpdating(false);

    if (error) {
      toast.error(`Could not update roles: ${error.message}`);
      return;
    }
    invalidatePersonScope(queryClient);
    toast.success(checked ? `Added ${role} role` : `Removed ${role} role`);
  };

  const summary = current.size === 2
    ? 'Candidate + Client'
    : current.has('candidate')
    ? 'Candidate'
    : current.has('client')
    ? 'Client'
    : 'No role';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size={size} disabled={updating} title="Manage roles">
          <Tag className="h-3.5 w-3.5 mr-1" />
          {size === 'icon' ? null : summary}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Roles</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={current.has('candidate')}
          onCheckedChange={(c) => toggle('candidate', !!c)}
        >
          Candidate
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={current.has('client')}
          onCheckedChange={(c) => toggle('client', !!c)}
        >
          Client
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
