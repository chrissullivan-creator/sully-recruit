import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useSequences, useCandidates, useContacts, useIntegrationAccounts } from '@/hooks/useData';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Mail, Linkedin, Users, Loader2, Search } from 'lucide-react';

interface EnrollInSequenceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidateIds: string[];
  candidateNames?: string[];
  preselectedSequenceId?: string;
}

export const EnrollInSequenceDialog = ({ open, onOpenChange, candidateIds, candidateNames = [], preselectedSequenceId }: EnrollInSequenceDialogProps) => {
  const [selectedSequenceId, setSelectedSequenceId] = useState<string>('');
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [enrolling, setEnrolling] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPeople, setSelectedPeople] = useState<string[]>([]);
  const { data: sequences = [], isLoading } = useSequences();
  const { data: candidates = [] } = useCandidates();
  const { data: contacts = [] } = useContacts();
  const { data: integrationAccounts = [] } = useIntegrationAccounts();
  const emailAccounts = (integrationAccounts as any[]).filter(a => a.provider === 'email');
  const queryClient = useQueryClient();

  const isPeoplePicker = !!preselectedSequenceId && candidateIds.length === 0;

  useEffect(() => {
    if (preselectedSequenceId) setSelectedSequenceId(preselectedSequenceId);
  }, [preselectedSequenceId, open]);

  useEffect(() => {
    if (!open) {
      setSearchQuery('');
      setSelectedPeople([]);
      setSelectedAccountId('');
      if (!preselectedSequenceId) setSelectedSequenceId('');
    } else {
      // Auto-select current user's own email account
      supabase.auth.getUser().then(({ data }) => {
        const userId = data.user?.id;
        if (!userId) return;
        const mine = emailAccounts.find((a: any) => a.owner_user_id === userId || a.user_id === userId);
        if (mine) setSelectedAccountId(mine.id);
        else if (emailAccounts.length === 1) setSelectedAccountId(emailAccounts[0].id);
      });
    }
  }, [open, preselectedSequenceId, emailAccounts.length]);

  const activeSequences = sequences.filter((s) => s.status === 'active');
  const selectedSequence = sequences.find((s) => s.id === selectedSequenceId);
  const steps = (selectedSequence?.sequence_steps as any[]) ?? [];

  // Build people list — data hooks already sort newest-first (created_at desc)
  const people = [
    ...candidates.map(c => ({
      id: c.id, type: 'candidate' as const,
      name: c.full_name || `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim(),
      detail: [c.current_title, c.current_company].filter(Boolean).join(' · ') || c.email || '',
      sortDate: c.created_at,
    })),
    ...contacts.map(c => ({
      id: c.id, type: 'contact' as const,
      name: (c as any).full_name || `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim(),
      detail: [(c as any).title, (c as any).companies?.name].filter(Boolean).join(' · ') || c.email || '',
      sortDate: c.created_at,
    })),
  ]
    .sort((a, b) => new Date(b.sortDate).getTime() - new Date(a.sortDate).getTime())
    .filter(p => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return p.name.toLowerCase().includes(q) || p.detail.toLowerCase().includes(q);
    });

  const togglePerson = (personId: string) => {
    setSelectedPeople(prev => prev.includes(personId) ? prev.filter(p => p !== personId) : [...prev, personId]);
  };

  const channelIcon = (channel: string) => {
    if (channel === 'linkedin') return <Linkedin className="h-3.5 w-3.5" />;
    return <Mail className="h-3.5 w-3.5" />;
  };

  const handleEnroll = async () => {
    if (!selectedSequenceId) return;
    if (!selectedAccountId) {
      toast.error('Please select a sender account before enrolling');
      return;
    }

    // Combine all IDs: from candidateIds or people picker
    let idsToEnroll: string[];
    if (isPeoplePicker) {
      idsToEnroll = selectedPeople;
    } else {
      idsToEnroll = candidateIds;
    }
    if (idsToEnroll.length === 0) return;

    setEnrolling(true);
    try {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const candidateIdSet = new Set(candidates.map(c => c.id));

      const enrollments = idsToEnroll.map((personId) => {
        const isCand = candidateIdSet.has(personId);
        return {
          sequence_id: selectedSequenceId,
          ...(isCand ? { candidate_id: personId } : { contact_id: personId }),
          status: 'active',
          current_step_order: 1,
          enrolled_by: userId,
          integration_account_id: selectedAccountId || null,
        };
      });

      const { error } = await supabase.from('sequence_enrollments').insert(enrollments);
      if (error) throw error;

      toast.success(`Enrolled ${idsToEnroll.length} ${idsToEnroll.length > 1 ? 'people' : 'person'} in sequence`);
      queryClient.invalidateQueries({ queryKey: ['sequences'] });
      queryClient.invalidateQueries({ queryKey: ['sequence_enrollments'] });
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to enroll');
    } finally {
      setEnrolling(false);
    }
  };

  const enrollCount = isPeoplePicker ? selectedPeople.length : candidateIds.length;
  const totalSelected = isPeoplePicker ? selectedPeople.length : candidateIds.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isPeoplePicker ? 'Add People to Sequence' : 'Enroll in Sequence'}</DialogTitle>
          <DialogDescription>
            {isPeoplePicker
              ? 'Search and select candidates or contacts to enroll.'
              : totalSelected === 1 && candidateNames[0]
                ? `Enroll ${candidateNames[0]} in an outreach sequence.`
                : `Enroll ${totalSelected} people in an outreach sequence.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {!isPeoplePicker && totalSelected > 1 && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Users className="h-4 w-4" />
              <span>{totalSelected} people selected</span>
            </div>
          )}

          {!preselectedSequenceId && (
            <div className="space-y-2">
              <Label>Select Sequence</Label>
              {isLoading ? (
                <p className="text-sm text-muted-foreground">Loading sequences...</p>
              ) : activeSequences.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active sequences available.</p>
              ) : (
                <Select value={selectedSequenceId} onValueChange={setSelectedSequenceId}>
                  <SelectTrigger><SelectValue placeholder="Choose a sequence..." /></SelectTrigger>
                  <SelectContent>
                    {activeSequences.map((seq) => (
                      <SelectItem key={seq.id} value={seq.id}>
                        <span className="flex items-center gap-2">
                          {channelIcon(seq.channel)}
                          {seq.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {/* Sender account picker — required */}
          {emailAccounts.length > 0 && (
            <div className="space-y-2">
              <Label>Send From <span className="text-destructive">*</span></Label>
              <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                <SelectTrigger className={!selectedAccountId ? 'border-destructive/50' : ''}>
                  <SelectValue placeholder="Choose sender account..." />
                </SelectTrigger>
                <SelectContent>
                  {emailAccounts.map((acct: any) => (
                    <SelectItem key={acct.id} value={acct.id}>
                      <span className="flex items-center gap-2">
                        <Mail className="h-3.5 w-3.5" />
                        {acct.account_label} — {acct.email_address}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {isPeoplePicker && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Search People</Label>
                {people.length > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const allIds = people.slice(0, 50).map(p => p.id);
                      const allSelected = allIds.every(id => selectedPeople.includes(id));
                      if (allSelected) {
                        setSelectedPeople(prev => prev.filter(id => !allIds.includes(id)));
                      } else {
                        setSelectedPeople(prev => [...new Set([...prev, ...allIds])]);
                      }
                    }}
                    className="text-xs h-7 px-2"
                  >
                    {people.slice(0, 50).every(p => selectedPeople.includes(p.id)) ? 'Deselect All' : 'Select All'}
                  </Button>
                )}
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search candidates or contacts..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">Select People</Label>
                {people.length > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const allIds = people.slice(0, 50).map(p => p.id);
                      const allSelected = allIds.every(id => selectedPeople.includes(id));
                      if (allSelected) {
                        setSelectedPeople(prev => prev.filter(id => !allIds.includes(id)));
                      } else {
                        setSelectedPeople(prev => [...new Set([...prev, ...allIds])]);
                      }
                    }}
                    className="text-xs h-7 px-2"
                  >
                    {people.slice(0, 50).every(p => selectedPeople.includes(p.id)) ? 'Deselect All' : 'Select All'}
                  </Button>
                )}
              </div>
              <ScrollArea className="h-48 rounded-md border border-border">
                <div className="p-2 space-y-1">
                  {people.slice(0, 50).map((person) => (
                    <label
                      key={`${person.type}-${person.id}`}
                      className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50 cursor-pointer"
                    >
                      <Checkbox
                        checked={selectedPeople.includes(person.id)}
                        onCheckedChange={() => togglePerson(person.id)}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground truncate">{person.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{person.detail}</p>
                      </div>
                      <Badge variant="secondary" className="text-[10px] capitalize">{person.type}</Badge>
                    </label>
                  ))}
                  {people.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-4">No results found</p>
                  )}
                </div>
              </ScrollArea>
              {selectedPeople.length > 0 && (
                <p className="text-xs text-muted-foreground">{selectedPeople.length} selected</p>
              )}
            </div>
          )}

          {!isPeoplePicker && selectedSequence && (
            <div className="rounded-lg border border-border bg-secondary/50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-foreground">{selectedSequence.name}</span>
                <Badge variant="secondary" className="text-xs capitalize">{selectedSequence.channel}</Badge>
              </div>
              {selectedSequence.description && (
                <p className="text-xs text-muted-foreground">{selectedSequence.description}</p>
              )}
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{steps.length} Steps</span>
                {steps.sort((a: any, b: any) => a.step_order - b.step_order).map((step: any) => (
                  <div key={step.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px]">{step.step_order}</span>
                    <span className="capitalize">{step.channel ?? selectedSequence.channel}</span>
                    {step.delay_days > 0 && <span className="text-muted-foreground/60">• wait {step.delay_days}d</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="gold" onClick={handleEnroll} disabled={!selectedSequenceId || enrollCount === 0 || enrolling}>
            {enrolling && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Enroll{enrollCount > 1 ? ` (${enrollCount})` : enrollCount === 1 ? '' : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
