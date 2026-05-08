import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Tag } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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

// Resolve the canonical single role from whatever the row has stored —
// roles[] is the source of truth, but fall back to legacy `type` if
// roles[] is empty for older rows. Defaults to 'candidate' as last resort.
function resolveRole(
  roles: string[] | null | undefined,
  currentType: 'candidate' | 'client' | null | undefined,
): PersonRole {
  const fromRoles = (roles ?? []).find((r) => r === 'candidate' || r === 'client') as PersonRole | undefined;
  if (fromRoles) return fromRoles;
  if (currentType === 'candidate' || currentType === 'client') return currentType;
  return 'candidate';
}

export function PersonRolesMenu({ personId, roles, currentType, variant = 'outline', size = 'sm' }: Props) {
  const queryClient = useQueryClient();
  const [updating, setUpdating] = useState(false);
  const current = resolveRole(roles, currentType);

  const setRole = async (role: PersonRole) => {
    if (role === current) return;
    setUpdating(true);
    const { error } = await supabase
      .from('people')
      .update({ roles: [role], type: role } as any)
      .eq('id', personId);
    setUpdating(false);

    if (error) {
      toast.error(`Could not update role: ${error.message}`);
      return;
    }
    invalidatePersonScope(queryClient);
    toast.success(`Marked as ${role}`);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size={size} disabled={updating} title="Change role">
          <Tag className="h-3.5 w-3.5 mr-1" />
          {size === 'icon' ? null : (current === 'candidate' ? 'Candidate' : 'Client')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Role</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={current} onValueChange={(v) => setRole(v as PersonRole)}>
          <DropdownMenuRadioItem value="candidate">Candidate</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="client">Client</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
