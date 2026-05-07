import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { invalidatePersonScope, invalidateCommsScope } from '@/lib/invalidate';
import {
  Loader2, UserCheck, Users, UserPlus, Check, Building,
  ChevronsUpDown, Link as LinkIcon, ArrowLeft, Plus,
  Mail, Linkedin, MessageSquare,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = 'pick_type' | 'searching' | 'matches' | 'enriching' | 'form';
type PersonType = 'candidate' | 'contact';

interface PersonMatch {
  id: string;
  type: PersonType;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  email?: string;
  phone?: string;
  linkedin_url?: string;
  current_title?: string;
  current_company?: string;
  title?: string;
  company_name?: string;
}

interface FormData {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  linkedin_url: string;
  title: string;
  company: string;
  company_id: string;
  location: string;
  notes: string;
  current_salary: string;
  desired_salary: string;
  status: string;
}

const EMPTY_FORM: FormData = {
  first_name: '', last_name: '', email: '', phone: '',
  linkedin_url: '', title: '', company: '', company_id: '',
  location: '', notes: '', current_salary: '', desired_salary: '',
  status: 'new',
};

export interface AddPersonWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threadId: string;
  channel: string;
  prefill: { name: string; email: string; phone: string; linkedinUrl: string };
  rawBody?: string;
  externalConversationId?: string | null;
  integrationAccountId?: string | null;
  onPersonLinked?: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AddPersonWizard({
  open,
  onOpenChange,
  threadId,
  channel,
  prefill,
  rawBody,
  externalConversationId,
  integrationAccountId,
  onPersonLinked,
}: AddPersonWizardProps) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>('pick_type');
  const [personType, setPersonType] = useState<PersonType | null>(null);
  const [matches, setMatches] = useState<PersonMatch[]>([]);
  const [form, setForm] = useState<FormData>({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [linking, setLinking] = useState(false);
  const [companyOpen, setCompanyOpen] = useState(false);
  const enrichedRef = useRef(false);

  // Fetch companies for autocomplete
  const { data: companies = [] } = useQuery({
    queryKey: ['companies_autocomplete'],
    queryFn: async () => {
      const { data } = await supabase.from('companies').select('id, name').order('name');
      return data || [];
    },
    staleTime: 5 * 60 * 1000,
  });

  // Auto-resolve company_id from company name after enrichment
  useEffect(() => {
    if (!form.company || form.company_id) return;
    const match = (companies as any[]).find(
      (c) => c.name?.toLowerCase() === form.company.toLowerCase()
    );
    if (match) {
      setForm(prev => ({ ...prev, company_id: match.id }));
    }
  }, [form.company, form.company_id, companies]);

  // Get auth token for API calls
  const getToken = async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token || '';
  };

  // Reset state when dialog opens. Previously this re-ran on every
  // prefill prop change, which fires every time the parent (Inbox)
  // re-renders with newly loaded messages — that wiped the form
  // state mid-wizard (and reset the step back to "pick_type"). Now
  // we only reset on the open=false→true transition.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;

    const nameParts = (prefill.name || '').trim().split(/\s+/).filter(Boolean);
    setStep('pick_type');
    setPersonType(null);
    setMatches([]);
    enrichedRef.current = false;
    // LinkedIn inbound senders carry a Unipile URN/provider_id (e.g. ACoAAA...,
    // urn:li:fsd_profile:...) in sender_address, NOT a real linkedin.com URL.
    // Only seed the linkedin_url field if it actually looks like one — otherwise
    // we wait for /api/lookup-linkedin to resolve a real URL via Unipile.
    const seedLinkedInUrl = /linkedin\.com\/in\//i.test(prefill.linkedinUrl ?? '')
      ? prefill.linkedinUrl
      : '';
    setForm({
      ...EMPTY_FORM,
      first_name: nameParts[0] || '',
      last_name: nameParts.slice(1).join(' ') || '',
      email: prefill.email || '',
      phone: prefill.phone || '',
      linkedin_url: seedLinkedInUrl,
    });
  }, [open, prefill.name, prefill.email, prefill.phone, prefill.linkedinUrl]);

  // ── Step 2: Search for duplicates ──────────────────────────────────────────

  const searchExisting = useCallback(async (type: PersonType) => {
    setStep('searching');
    try {
      const token = await getToken();
      const res = await fetch('/api/search-person', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type,
          name: prefill.name || '',
          email: prefill.email || '',
          phone: prefill.phone || '',
          linkedin_url: prefill.linkedinUrl || '',
        }),
      });
      const data = await res.json();

      if (data.matches?.length > 0) {
        setMatches(data.matches);
        setStep('matches');
      } else {
        await enrichFromSource(type);
      }
    } catch (err) {
      console.error('Search failed:', err);
      await enrichFromSource(type);
    }
  }, [prefill]);

  // ── Step 3b: Enrich from thread source ─────────────────────────────────────
  //
  // Hold the wizard on the "enriching" step until the form fields are
  // actually populated (or every retrieval source has been exhausted).
  // Without this guard the spinner clears the moment the network call
  // returns even if the response was empty — the recruiter then sees a
  // blank form and assumes nothing was retrieved. We keep the loader up
  // through both the email-signature parse AND any LinkedIn lookup so
  // the form only renders when there's something to show.

  const enrichFromSource = useCallback(async (type: PersonType) => {
    if (enrichedRef.current) {
      setStep('form');
      return;
    }
    enrichedRef.current = true;
    setStep('enriching');

    let populated = false;

    try {
      const token = await getToken();

      if (channel === 'email' && rawBody) {
        // Parse email signature via Claude. Pass the sender name/address as
        // hints so Claude prefers the header identity over any random names
        // mentioned in a quoted reply chain.
        const res = await fetch('/api/parse-email-signature', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            body: rawBody,
            sender_name: prefill.name || undefined,
            sender_address: prefill.email || undefined,
          }),
        });
        if (res.ok) {
          const parsed = await res.json();
          const hasFields = !!(parsed.first_name || parsed.last_name || parsed.email
            || parsed.phone || parsed.title || parsed.company_name || parsed.location
            || parsed.linkedin_url);
          if (hasFields) {
            populated = true;
            setForm(prev => ({
              ...prev,
              first_name: parsed.first_name || prev.first_name,
              last_name: parsed.last_name || prev.last_name,
              email: prev.email || parsed.email || '',
              phone: parsed.phone || prev.phone,
              title: parsed.title || prev.title,
              company: parsed.company_name || prev.company,
              location: parsed.location || prev.location,
              linkedin_url: parsed.linkedin_url || prev.linkedin_url,
            }));
          }
        }
      } else if (channel === 'linkedin' || channel === 'linkedin_recruiter') {
        // Resolve via Unipile chat attendees + user profile.
        populated = await resolveLinkedInProfile(token);
      }
      // SMS — no enrichment, form is already seeded with phone
    } catch (err) {
      console.error('Enrichment failed:', err);
    }

    // If nothing came back from the source, the form will show whatever
    // came in via prefill (sender name → first/last). That's still
    // better than a blank form, and the loader has already given the
    // user feedback that we tried.
    void populated;
    setStep('form');
  }, [channel, rawBody, prefill]);

  // LinkedIn resolution — delegates to /api/lookup-linkedin, which reads the
  // Unipile API key from app_settings and handles both slug-based and
  // chat-attendee-based resolution server-side. Returns true when at
  // least one form field was populated from the response so the wizard
  // can decide whether to advance the loading state.
  const resolveLinkedInProfile = async (token: string): Promise<boolean> => {
    // Only pass linkedin_url if it actually looks like a URL (not a raw URN/provider_id,
    // which is what inbound LinkedIn messages from backfill commonly contain).
    const rawUrl = prefill.linkedinUrl || '';
    const looksLikeUrl = /linkedin\.com\/in\//.test(rawUrl);
    const body: Record<string, string> = {};
    if (looksLikeUrl) body.linkedin_url = rawUrl;
    if (externalConversationId) body.chat_id = externalConversationId;
    if (integrationAccountId) body.integration_account_id = integrationAccountId;

    // Nothing to resolve with — bail.
    if (!body.linkedin_url && !body.chat_id) return false;

    const res = await fetch('/api/lookup-linkedin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) return false;
    const profile = await res.json();
    const hasFields = !!(profile.first_name || profile.last_name || profile.email
      || profile.phone || profile.title || profile.company_name || profile.company
      || profile.location || profile.linkedin_url);
    if (!hasFields) return false;
    setForm(prev => ({
      ...prev,
      first_name: profile.first_name || prev.first_name,
      last_name: profile.last_name || prev.last_name,
      email: profile.email || prev.email,
      phone: profile.phone || prev.phone,
      title: profile.title || prev.title,
      company: profile.company_name || profile.company || prev.company,
      location: profile.location || prev.location,
      linkedin_url: profile.linkedin_url || prev.linkedin_url,
    }));
    return true;
  };

  // ── Connect to existing match ──────────────────────────────────────────────

  const handleConnect = async (match: PersonMatch) => {
    setLinking(true);
    try {
      const linkCol = match.type === 'candidate' ? 'candidate_id' : 'contact_id';
      const { error } = await supabase
        .from('conversations')
        .update({ [linkCol]: match.id })
        .eq('id', threadId);
      if (error) throw error;

      // Backfill messages
      await supabase
        .from('messages')
        .update({ [linkCol]: match.id })
        .eq('conversation_id', threadId)
        .is(linkCol, null);

      const name = match.full_name || `${match.first_name} ${match.last_name}`;
      toast.success(`Linked to ${name}`);
      invalidateQueries();
      onOpenChange(false);
      onPersonLinked?.();
    } catch (err: any) {
      toast.error('Failed to link: ' + (err.message || 'Unknown error'));
    } finally {
      setLinking(false);
    }
  };

  // ── Save new person ────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!personType || !form.first_name.trim() || !form.last_name.trim()) return;
    setSaving(true);

    try {
      // Safety-net: resolve company_id for contacts if user typed a matching company name
      let resolvedForm = form;
      if (!form.company_id && form.company && personType === 'contact') {
        const match = (companies as any[]).find(
          (c) => c.name?.toLowerCase() === form.company.trim().toLowerCase()
        );
        if (match) resolvedForm = { ...form, company_id: match.id };
      }

      const token = await getToken();
      const res = await fetch('/api/add-person', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type: personType,
          data: resolvedForm,
          conversation_id: threadId,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        const msg = err.error || 'Save failed';

        // Duplicate detected — re-search with enriched form data so user can link
        if (msg.includes('duplicate') || msg.includes('unique')) {
          const searchRes = await fetch('/api/search-person', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              type: personType,
              name: `${form.first_name} ${form.last_name}`,
              email: form.email || '',
              phone: form.phone || '',
              linkedin_url: form.linkedin_url || '',
            }),
          });
          const searchData = await searchRes.json();
          if (searchData.matches?.length > 0) {
            setMatches(searchData.matches);
            setStep('matches');
            toast.info('A matching record already exists. You can link to it below.');
            setSaving(false);
            return;
          }
        }

        throw new Error(msg);
      }

      const saved = await res.json();
      const label = personType === 'candidate' ? 'Candidate' : 'Client';
      toast.success(`${label} "${form.first_name} ${form.last_name}" created & linked`);
      invalidateQueries();
      onOpenChange(false);
      onPersonLinked?.();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const invalidateQueries = () => {
    invalidatePersonScope(queryClient);
    invalidateCommsScope(queryClient);
    queryClient.invalidateQueries({ queryKey: ['inbox_thread', threadId] });
  };

  // ── Type selection handler ─────────────────────────────────────────────────

  const handlePickType = (type: PersonType) => {
    setPersonType(type);
    searchExisting(type);
  };

  // ── Helpers ────────────────────────────────────────────────────────────────

  const update = (field: keyof FormData, value: string) =>
    setForm(prev => ({ ...prev, [field]: value }));

  const getMatchDisplay = (m: PersonMatch) => ({
    name: m.full_name || `${m.first_name || ''} ${m.last_name || ''}`.trim(),
    title: m.type === 'candidate' ? m.current_title : m.title,
    company: m.type === 'candidate' ? m.current_company : m.company_name,
  });

  const stepTitle = () => {
    switch (step) {
      case 'pick_type': return 'Add Person';
      case 'searching': return 'Searching...';
      case 'matches': return 'Possible Matches';
      case 'enriching': return 'Looking Up Details...';
      case 'form': return `New ${personType === 'candidate' ? 'Candidate' : 'Client'}`;
    }
  };

  const stepDescription = () => {
    switch (step) {
      case 'pick_type': return 'Is this person a candidate or a client?';
      case 'searching': return 'Checking for existing records...';
      case 'matches': return `Found ${matches.length} possible ${matches.length === 1 ? 'match' : 'matches'}`;
      case 'enriching':
        if (channel === 'email') return 'Parsing email signature...';
        if (channel?.startsWith('linkedin')) return 'Fetching LinkedIn profile...';
        return 'Loading...';
      case 'form': return 'Review and edit the details below.';
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v || step === 'pick_type') onOpenChange(v); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            {stepTitle()}
          </DialogTitle>
          <DialogDescription>{stepDescription()}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 -mx-6 px-6">
          {/* ── STEP: Pick Type ──────────────────────────────────────── */}
          {step === 'pick_type' && (
            <div className="flex gap-3 py-4">
              <button
                onClick={() => handlePickType('candidate')}
                className={cn(
                  'flex-1 flex flex-col items-center gap-2 rounded-lg border px-4 py-6 transition-colors',
                  'border-border hover:border-success/40 hover:bg-success/5',
                )}
              >
                <UserCheck className="h-8 w-8 text-success" />
                <span className="text-sm font-semibold text-foreground">Candidate</span>
                <span className="text-xs text-muted-foreground text-center">Job seeker, passive talent</span>
              </button>
              <button
                onClick={() => handlePickType('contact')}
                className={cn(
                  'flex-1 flex flex-col items-center gap-2 rounded-lg border px-4 py-6 transition-colors',
                  'border-border hover:border-info/40 hover:bg-info/5',
                )}
              >
                <Users className="h-8 w-8 text-info" />
                <span className="text-sm font-semibold text-foreground">Client</span>
                <span className="text-xs text-muted-foreground text-center">Hiring manager, BD lead, decision-maker</span>
              </button>
            </div>
          )}

          {/* ── STEP: Searching ──────────────────────────────────────── */}
          {step === 'searching' && (
            <div className="flex flex-col items-center py-12 gap-4">
              <Loader2 className="h-10 w-10 animate-spin text-accent" />
              <p className="text-sm text-muted-foreground">
                Checking for existing {personType === 'contact' ? 'clients' : 'candidates'}...
              </p>
            </div>
          )}

          {/* ── STEP: Matches ────────────────────────────────────────── */}
          {step === 'matches' && (
            <div className="py-4 space-y-3">
              {matches.map((m) => {
                const d = getMatchDisplay(m);
                return (
                  <div
                    key={`${m.type}:${m.id}`}
                    className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-3 py-3"
                  >
                    {m.type === 'candidate'
                      ? <UserCheck className="h-4 w-4 text-success shrink-0" />
                      : <Users className="h-4 w-4 text-info shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-medium text-foreground truncate">{d.name}</p>
                        <Badge variant="outline" className="text-[9px] uppercase shrink-0 capitalize">
                          {m.type}
                        </Badge>
                      </div>
                      {(d.title || d.company) && (
                        <p className="text-xs text-muted-foreground truncate">
                          {[d.title, d.company].filter(Boolean).join(' @ ')}
                        </p>
                      )}
                      {m.email && (
                        <p className="text-[10px] text-muted-foreground truncate">{m.email}</p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1 shrink-0"
                      disabled={linking}
                      onClick={() => handleConnect(m)}
                    >
                      {linking ? <Loader2 className="h-3 w-3 animate-spin" /> : <LinkIcon className="h-3 w-3" />}
                      Connect
                    </Button>
                  </div>
                );
              })}

              <button
                onClick={() => enrichFromSource(personType!)}
                className="w-full rounded-lg border border-dashed border-border py-2.5 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
              >
                None of these — create new
              </button>
            </div>
          )}

          {/* ── STEP: Enriching ──────────────────────────────────────── */}
          {step === 'enriching' && (
            <div className="flex flex-col items-center py-12 gap-4">
              <Loader2 className="h-10 w-10 animate-spin text-accent" />
              <div className="space-y-2 text-center">
                {channel === 'email' && (
                  <p className="text-sm text-muted-foreground flex items-center gap-2 justify-center">
                    <Mail className="h-4 w-4" /> Parsing email signature...
                  </p>
                )}
                {channel?.startsWith('linkedin') && (
                  <p className="text-sm text-muted-foreground flex items-center gap-2 justify-center">
                    <Linkedin className="h-4 w-4" /> Fetching LinkedIn profile...
                  </p>
                )}
                {channel === 'sms' && (
                  <p className="text-sm text-muted-foreground flex items-center gap-2 justify-center">
                    <MessageSquare className="h-4 w-4" /> Loading...
                  </p>
                )}
              </div>
            </div>
          )}

          {/* ── STEP: Form ───────────────────────────────────────────── */}
          {step === 'form' && (
            <div className="py-2 space-y-4">
              {/* Type toggle */}
              <div className="flex gap-2">
                <button
                  onClick={() => { setPersonType('candidate'); setForm(f => ({ ...f, status: 'new' })); }}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
                    personType === 'candidate'
                      ? 'bg-success/10 text-success border-success/30'
                      : 'border-border text-muted-foreground hover:border-success/30',
                  )}
                >
                  <UserCheck className="h-4 w-4" />
                  Candidate
                </button>
                <button
                  onClick={() => setPersonType('contact')}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
                    personType === 'contact'
                      ? 'bg-info/10 text-info border-info/30'
                      : 'border-border text-muted-foreground hover:border-info/30',
                  )}
                >
                  <Users className="h-4 w-4" />
                  Client
                </button>
              </div>

              {/* Form fields */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">First Name <span className="text-[#D4AF37]">*</span></Label>
                  <Input value={form.first_name} onChange={(e) => update('first_name', e.target.value)} className="h-9" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Last Name <span className="text-[#D4AF37]">*</span></Label>
                  <Input value={form.last_name} onChange={(e) => update('last_name', e.target.value)} className="h-9" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Email</Label>
                  <Input type="email" value={form.email} onChange={(e) => update('email', e.target.value)} className="h-9" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Phone</Label>
                  <Input value={form.phone} onChange={(e) => update('phone', e.target.value)} className="h-9" />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">{personType === 'candidate' ? 'Current Title' : 'Job Title'}</Label>
                <Input value={form.title} onChange={(e) => update('title', e.target.value)} className="h-9" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">{personType === 'candidate' ? 'Current Company' : 'Company'}</Label>
                  <Popover open={companyOpen} onOpenChange={setCompanyOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={companyOpen}
                        className="h-9 w-full justify-between font-normal text-sm"
                      >
                        <span className={cn('truncate', !form.company && 'text-muted-foreground')}>
                          {form.company || 'Search companies...'}
                        </span>
                        <ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[240px] p-0" align="start">
                      <Command>
                        <CommandInput
                          placeholder="Type to search..."
                          value={form.company}
                          onValueChange={(v) => {
                            update('company', v);
                            update('company_id', '');
                          }}
                        />
                        <CommandList>
                          <CommandEmpty>
                            {form.company.trim() ? (
                              <button
                                className="w-full px-2 py-1.5 text-xs text-left text-muted-foreground hover:text-foreground"
                                onClick={() => {
                                  update('company_id', '');
                                  setCompanyOpen(false);
                                }}
                              >
                                Use "{form.company}" as new company
                              </button>
                            ) : (
                              <span className="text-xs text-muted-foreground">No companies found</span>
                            )}
                          </CommandEmpty>
                          <CommandGroup>
                            {(companies as any[])
                              .filter((c) => c.name?.toLowerCase().includes((form.company || '').toLowerCase()))
                              .slice(0, 8)
                              .map((c) => (
                                <CommandItem
                                  key={c.id}
                                  value={c.name}
                                  onSelect={() => {
                                    update('company', c.name);
                                    update('company_id', c.id);
                                    setCompanyOpen(false);
                                  }}
                                >
                                  <Building className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                                  {c.name}
                                  {form.company_id === c.id && <Check className="ml-auto h-3.5 w-3.5 text-success" />}
                                </CommandItem>
                              ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Location</Label>
                  <Input value={form.location} onChange={(e) => update('location', e.target.value)} placeholder="City, State" className="h-9" />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">LinkedIn URL</Label>
                <Input value={form.linkedin_url} onChange={(e) => update('linkedin_url', e.target.value)} placeholder="https://linkedin.com/in/..." className="h-9" />
              </div>

              {/* Candidate-specific fields */}
              {personType === 'candidate' && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Current Comp</Label>
                    <Input value={form.current_salary} onChange={(e) => update('current_salary', e.target.value)} placeholder="e.g. $150,000" className="h-9" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Target Comp</Label>
                    <Input value={form.desired_salary} onChange={(e) => update('desired_salary', e.target.value)} placeholder="e.g. $175,000" className="h-9" />
                  </div>
                </div>
              )}

              {/* Notes */}
              <div className="space-y-1.5">
                <Label className="text-xs">Notes</Label>
                <textarea
                  value={form.notes}
                  onChange={(e) => update('notes', e.target.value)}
                  rows={2}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y min-h-[60px]"
                />
              </div>
            </div>
          )}
        </ScrollArea>

        {/* Footer */}
        {step === 'form' && (
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => {
                setStep('pick_type');
                setMatches([]);
                enrichedRef.current = false;
              }}
              className="gap-1"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </Button>
            <Button
              variant="gold"
              onClick={handleSave}
              disabled={saving || !form.first_name.trim() || !form.last_name.trim()}
              className="gap-1.5"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create & Link
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
