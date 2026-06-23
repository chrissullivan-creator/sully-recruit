import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';

/**
 * useInboxScope — single source of truth for per-user communication scoping,
 * shared by the inbox (threads + live "Other" tab) and the Calls panel.
 *
 * Every recruiter sees ONLY their own communications by default ("mine").
 * Admins (profiles.is_admin) get a "Team" scope with an optional per-member
 * filter. Scoping is enforced in the query layer — RLS stays permissive so
 * backend jobs, Joe, and dashboards keep working.
 *
 * Two derived selectors cover the two storage shapes:
 *   - scopedAccountIds   → filter conversations/threads by integration_account_id
 *                          (the reliably-populated key; owner_id is sparse).
 *   - scopedOwnerUserId  → filter call_logs by owner_id (null = no filter/all).
 *
 * State (scope + member) is mirrored into the URL (?scope=team&member=<userId>)
 * so a refresh keeps the view and links are shareable.
 */

// Fallback admins if a profiles row is missing is_admin for some reason.
const ADMIN_EMAILS = [
  'chris.sullivan@emeraldrecruit.com',
  'emeraldrecruit@theemeraldrecruitinggroup.com',
];

export type InboxScope = 'mine' | 'team';

export interface InboxTeamMember {
  userId: string;
  label: string;
  accountIds: string[];
}

export interface InboxScopeState {
  ready: boolean;
  userId: string;
  isAdmin: boolean;
  /** This user's own active integration-account IDs. */
  myAccountIds: string[];
  /** All active accounts grouped by owner (admins only; [] otherwise). */
  teamMembers: InboxTeamMember[];
  /** Every active integration-account ID (admins only; [] otherwise). */
  allActiveAccountIds: string[];

  scope: InboxScope;
  setScope: (scope: InboxScope) => void;
  /** Selected team member's user id, or 'all'. Only meaningful when scope==='team'. */
  memberFilter: string;
  setMemberFilter: (memberUserId: string) => void;

  /**
   * Account IDs to filter threads/conversations by, given the current scope.
   * `null` means "no filter" (admin Team / All — shows everything, including
   * threads with a null integration_account_id). `[]` means nothing in scope.
   */
  scopedAccountIds: string[] | null;
  /** Owner user id to filter call_logs by, or null for "no filter" (admin team/all). */
  scopedOwnerUserId: string | null;
}

export function useInboxScope(): InboxScopeState {
  const [searchParams, setSearchParams] = useSearchParams();

  const { data: currentUser } = useQuery({
    queryKey: ['current_user'],
    queryFn: async () => {
      const { data } = await supabase.auth.getUser();
      return data.user;
    },
  });
  const userId = currentUser?.id || '';
  const userEmail = currentUser?.email?.toLowerCase() || '';

  // Admin flag from profiles.is_admin, with an email allow-list fallback.
  const { data: profileIsAdmin } = useQuery({
    queryKey: ['profile_is_admin', userId],
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data } = await supabase
        .from('profiles' as any)
        .select('is_admin')
        .eq('id', userId)
        .maybeSingle();
      return Boolean((data as any)?.is_admin);
    },
  });
  const isAdmin = (profileIsAdmin ?? false) || ADMIN_EMAILS.includes(userEmail);

  // This user's own active integration accounts.
  const { data: myAccountIds = [], isFetched: myFetched } = useQuery({
    queryKey: ['my_integration_accounts', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('integration_accounts')
        .select('id')
        .or(`owner_user_id.eq.${userId},user_id.eq.${userId}`);
      if (error) throw error;
      return (data || []).map((a: any) => a.id as string);
    },
  });

  // Admins: all active accounts, grouped by owner for the per-member filter.
  const { data: teamMembers = [], isFetched: teamFetched } = useQuery({
    queryKey: ['team_members_inbox'],
    enabled: isAdmin,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('integration_accounts')
        .select('id, email_address, account_label, owner_user_id')
        .eq('is_active', true);
      if (error) throw error;

      const ownerIds = [...new Set((data || []).map((a: any) => a.owner_user_id).filter(Boolean))];
      const profileMap: Record<string, string> = {};
      if (ownerIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', ownerIds);
        for (const p of profiles || []) {
          if ((p as any).full_name) profileMap[(p as any).id] = (p as any).full_name;
        }
      }

      const byOwner: Record<string, InboxTeamMember> = {};
      for (const acct of (data || []) as any[]) {
        // Group strictly by owner_user_id so the key is a real user id (used to
        // scope call_logs.owner_id). Accounts without an owner are skipped from
        // the per-member list but still counted in allActiveAccountIds below.
        if (!acct.owner_user_id) continue;
        const key = acct.owner_user_id as string;
        if (!byOwner[key]) {
          byOwner[key] = {
            userId: key,
            label: profileMap[key] || acct.account_label || acct.email_address || 'Unknown',
            accountIds: [],
          };
        }
        byOwner[key].accountIds.push(acct.id);
      }
      return Object.values(byOwner);
    },
  });

  const allActiveAccountIds = useMemo(
    () => teamMembers.flatMap((m) => m.accountIds),
    [teamMembers],
  );

  // ---- URL-synced scope state ----
  const rawScope = searchParams.get('scope');
  const scope: InboxScope = isAdmin && rawScope === 'team' ? 'team' : 'mine';
  const memberFilter = (isAdmin && scope === 'team' && searchParams.get('member')) || 'all';

  const setScope = useCallback(
    (next: InboxScope) => {
      if (!isAdmin) return; // non-admins are always 'mine'
      const params = new URLSearchParams(searchParams);
      if (next === 'team') {
        params.set('scope', 'team');
      } else {
        params.delete('scope');
        params.delete('member');
      }
      setSearchParams(params, { replace: true });
    },
    [isAdmin, searchParams, setSearchParams],
  );

  const setMemberFilter = useCallback(
    (memberUserId: string) => {
      if (!isAdmin) return;
      const params = new URLSearchParams(searchParams);
      params.set('scope', 'team');
      if (!memberUserId || memberUserId === 'all') params.delete('member');
      else params.set('member', memberUserId);
      setSearchParams(params, { replace: true });
    },
    [isAdmin, searchParams, setSearchParams],
  );

  // ---- Derived selectors ----
  const scopedAccountIds = useMemo<string[] | null>(() => {
    if (scope === 'team') {
      // Whole team → no filter at all, so admins still see threads that have
      // no integration_account_id (legacy rows). A specific member → their
      // accounts only.
      if (memberFilter === 'all') return null;
      return teamMembers.find((m) => m.userId === memberFilter)?.accountIds ?? [];
    }
    return myAccountIds;
  }, [scope, memberFilter, teamMembers, myAccountIds]);

  const scopedOwnerUserId = useMemo(() => {
    if (scope === 'team') {
      if (memberFilter === 'all') return null; // no filter — whole team
      return memberFilter;
    }
    return userId || null;
  }, [scope, memberFilter, userId]);

  const ready = !!userId && myFetched && (!isAdmin || teamFetched);

  return {
    ready,
    userId,
    isAdmin,
    myAccountIds,
    teamMembers,
    allActiveAccountIds,
    scope,
    setScope,
    memberFilter,
    setMemberFilter,
    scopedAccountIds,
    scopedOwnerUserId,
  };
}
