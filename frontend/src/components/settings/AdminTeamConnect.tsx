import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import {
  Copy, Linkedin, Mail, Loader2, CheckCircle2, AlertTriangle, Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface TeamMember {
  id: string;
  full_name: string | null;
  email: string | null;
}

interface AccountRow {
  id: string;
  account_type: string;
  email_address: string | null;
  account_label: string | null;
  unipile_account_id: string | null;
  is_active: boolean;
}

/**
 * Admin-only panel for managing Unipile connections on behalf of team
 * members. The hosted-auth flow is still 3-legged — the teammate must
 * complete the LinkedIn / Microsoft auth themselves — but the admin
 * generates the link, scopes it to the teammate's user_id, and copies
 * it for Slack / email.
 */
export function AdminTeamConnect() {
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [generatedFor, setGeneratedFor] = useState<string | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);
  const [contractName, setContractName] = useState('');

  // Team members — pull from profiles, joined with their owned accounts
  // so we can show coverage for everyone (including users with zero
  // connections yet).
  const { data: teamMembers = [], refetch: refetchMembers } = useQuery({
    queryKey: ['admin_team_members'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .order('full_name', { ascending: true });
      if (error) throw error;
      return (data ?? []) as TeamMember[];
    },
  });

  const { data: accounts = [], refetch: refetchAccounts } = useQuery({
    queryKey: ['admin_team_accounts', selectedUserId],
    enabled: !!selectedUserId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('integration_accounts')
        .select('id, account_type, email_address, account_label, unipile_account_id, is_active')
        .eq('owner_user_id', selectedUserId)
        .order('account_type', { ascending: true });
      if (error) throw error;
      return (data ?? []) as AccountRow[];
    },
  });

  const selectedMember = teamMembers.find((m) => m.id === selectedUserId);

  const generateLinkedinUrl = async (kind: 'recruiter' | 'classic') => {
    if (!selectedUserId || !selectedMember) {
      toast.error('Pick a teammate first');
      return;
    }
    setGenerating(kind);
    setGeneratedUrl(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/connect-linkedin', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          owner_user_id: selectedUserId,
          account_label: `${selectedMember.full_name || selectedMember.email} (${kind})`,
          contract_name: contractName.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.body || `API ${res.status}`);
      setGeneratedUrl(data.url);
      setGeneratedFor(selectedMember.full_name || selectedMember.email || 'teammate');
      toast.success('Hosted Auth link generated — send it to the teammate.');
    } catch (err: any) {
      toast.error(err.message || 'Failed to start LinkedIn auth');
    } finally {
      setGenerating(null);
    }
  };

  const copy = async (s: string) => {
    try {
      await navigator.clipboard.writeText(s);
      toast.success('Link copied');
    } catch {
      toast.error("Couldn't copy — select the link and copy manually");
    }
  };

  if (teamMembers.length === 0) return null;

  return (
    <Card className="p-5 space-y-5">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Users className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-semibold">Connect Unipile accounts for a teammate</h3>
        </div>
        <p className="text-xs text-muted-foreground">
          Generate a Unipile Hosted Auth link scoped to any teammate's user ID. Send the link via
          Slack or email — when they open it and authenticate, the account is saved under their
          <code className="text-[10px] mx-1 px-1 py-0.5 rounded bg-muted">owner_user_id</code>,
          not yours.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2 space-y-1.5">
          <Label className="text-xs">Teammate</Label>
          <Select value={selectedUserId} onValueChange={setSelectedUserId}>
            <SelectTrigger>
              <SelectValue placeholder="Pick a team member..." />
            </SelectTrigger>
            <SelectContent>
              {teamMembers.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.full_name || m.email || m.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Recruiter contract (optional)</Label>
          <Input
            placeholder="e.g. Emerald Recruiter"
            value={contractName}
            onChange={(e) => setContractName(e.target.value)}
          />
        </div>
      </div>

      {selectedMember && (
        <div className="border-t border-border/60 pt-4 space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {selectedMember.full_name || selectedMember.email}'s connected accounts
          </h4>
          {accounts.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No Unipile accounts connected yet.</p>
          ) : (
            <div className="space-y-1.5">
              {accounts.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-2 px-3 py-2 rounded border border-border/60 text-xs"
                >
                  <span className="font-medium text-foreground min-w-0 truncate flex-1">
                    {a.account_label || a.email_address || a.account_type}
                  </span>
                  <span className="text-muted-foreground text-[10px] uppercase tracking-wide">
                    {a.account_type}
                  </span>
                  <span
                    className={cn(
                      'text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded',
                      a.is_active ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {a.is_active ? 'active' : 'inactive'}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => generateLinkedinUrl('recruiter')}
              disabled={generating !== null}
            >
              {generating === 'recruiter' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : (
                <Linkedin className="h-3.5 w-3.5 mr-1.5" />
              )}
              LinkedIn Recruiter
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => generateLinkedinUrl('classic')}
              disabled={generating !== null}
            >
              {generating === 'classic' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : (
                <Linkedin className="h-3.5 w-3.5 mr-1.5" />
              )}
              LinkedIn (classic)
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled
              title="Microsoft / Outlook OAuth requires the teammate to be signed into Sully. They can connect from their own Settings page."
            >
              <Mail className="h-3.5 w-3.5 mr-1.5" />
              Outlook (teammate must self-connect)
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { refetchMembers(); refetchAccounts(); }}
              className="text-xs ml-auto"
            >
              Refresh
            </Button>
          </div>

          {generatedUrl && (
            <div className="rounded-lg border border-accent/40 bg-accent/5 p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs text-accent">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span className="font-semibold">Hosted Auth link ready</span>
                <span className="text-muted-foreground">— send to {generatedFor}</span>
              </div>
              <div className="flex gap-1.5">
                <Input
                  readOnly
                  value={generatedUrl}
                  className="font-mono text-[11px]"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button variant="outline" size="sm" onClick={() => copy(generatedUrl)}>
                  <Copy className="h-3.5 w-3.5 mr-1.5" /> Copy
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground flex items-start gap-1">
                <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                Link expires in 10 minutes. The teammate must open it in a browser where they can sign
                into LinkedIn. The account is saved under their user ID once they finish.
              </p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
