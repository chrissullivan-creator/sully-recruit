import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import {
  Phone, PhoneIncoming, PhoneOutgoing, Search, Clock,
  FileText, Plus, UserCheck, User, Users, Loader2,
  CheckCircle2, AlertCircle, UserPlus, ListChecks, RefreshCw,
} from 'lucide-react';
import { CallDetailModal } from '@/components/shared/CallDetailModal';

interface CallLog {
  id: string;
  phone_number: string;
  direction: string;
  duration_seconds: number | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  notes: string | null;
  summary: string | null;
  audio_url: string | null;
  linked_entity_type: string | null;
  linked_entity_id: string | null;
  linked_entity_name: string | null;
  owner_id: string | null;
}

// ---- Log Call Dialog ----
function LogCallDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [phone, setPhone] = useState('');
  const [direction, setDirection] = useState<'outbound' | 'inbound'>('outbound');
  const [notes, setNotes] = useState('');
  const [duration, setDuration] = useState('');
  const [saving, setSaving] = useState(false);
  const [matching, setMatching] = useState(false);
  const [matchResult, setMatchResult] = useState<{
    matched: boolean; entity_type: string | null; entity_id: string | null; entity_name: string | null;
  } | null>(null);

  const handleLookup = async () => {
    if (!phone.trim()) return;
    setMatching(true);
    setMatchResult(null);
    try {
      // Normalize
      const normalized = phone.replace(/[^0-9+]/g, '');
      const [cRes, ctRes] = await Promise.all([
        supabase.from('candidates').select('id, full_name, phone').not('phone', 'is', null),
        supabase.from('contacts').select('id, full_name, phone').not('phone', 'is', null),
      ]);
      if (cRes.error) throw cRes.error;
      if (ctRes.error) throw ctRes.error;
      const normalize = (p: string) => p.replace(/[^0-9+]/g, '');
      const candidate = cRes.data?.find(r => r.phone && normalize(r.phone) === normalized);
      if (candidate) { setMatchResult({ matched: true, entity_type: 'candidate', entity_id: candidate.id, entity_name: candidate.full_name }); return; }
      const contact = ctRes.data?.find(r => r.phone && normalize(r.phone) === normalized);
      if (contact) { setMatchResult({ matched: true, entity_type: 'contact', entity_id: contact.id, entity_name: contact.full_name }); return; }
      setMatchResult({ matched: false, entity_type: null, entity_id: null, entity_name: null });
    } catch (err: any) {
      console.error('Phone lookup failed:', err);
      toast.error(err?.message || 'Phone lookup failed');
      setMatchResult(null);
    } finally {
      setMatching(false);
    }
  };

  const handleSave = async () => {
    if (!phone.trim() || !notes.trim()) { toast.error('Phone number and notes are required'); return; }
    setSaving(true);
    try {
      // Insert call log
      const { data: callData, error: callError } = await supabase.from('call_logs' as any).insert({
        phone_number: phone.trim(),
        direction,
        notes,
        status: 'completed',
        duration_seconds: duration ? parseInt(duration) : null,
        owner_id: user?.id,
        linked_entity_type: matchResult?.entity_type ?? null,
        linked_entity_id: matchResult?.entity_id ?? null,
        linked_entity_name: matchResult?.entity_name ?? null,
        ended_at: new Date().toISOString(),
      }).select('id').single();

      if (callError) throw callError;

      // Create note linked to entity
      let noteWarning = false;
      if (matchResult?.matched && matchResult.entity_id && matchResult.entity_type) {
        const { error: noteError } = await supabase.from('notes').insert({
          entity_id: matchResult.entity_id,
          entity_type: matchResult.entity_type,
          note: `📞 Call Notes: ${notes}`,
          created_by: user?.id,
        });
        if (noteError) {
          console.error('Note error:', noteError);
          noteWarning = true;
        }
      }

      queryClient.invalidateQueries({ queryKey: ['call_logs'] });
      if (noteWarning) {
        toast.warning('Call logged, but the contact note failed to save');
      } else {
        toast.success('Call logged successfully');
      }
      setPhone(''); setNotes(''); setDuration(''); setMatchResult(null);
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to log call');
    } finally {
      setSaving(false);
    }
  };

  const entityIcon = matchResult?.entity_type === 'candidate' ? UserCheck
    : matchResult?.entity_type === 'contact' ? Users : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Log a Call</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Phone Number</Label>
              <div className="flex gap-2">
                <Input
                  value={phone}
                  onChange={(e) => { setPhone(e.target.value); setMatchResult(null); }}
                  placeholder="+15551234567"
                  className="flex-1"
                />
                <Button variant="outline" size="sm" onClick={handleLookup} disabled={!phone.trim() || matching}>
                  {matching ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Lookup'}
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Direction</Label>
              <div className="flex gap-2">
                <Button
                  variant={direction === 'outbound' ? 'gold' : 'outline'}
                  size="sm"
                  className="flex-1"
                  onClick={() => setDirection('outbound')}
                >
                  <PhoneOutgoing className="h-3.5 w-3.5 mr-1" /> Out
                </Button>
                <Button
                  variant={direction === 'inbound' ? 'gold' : 'outline'}
                  size="sm"
                  className="flex-1"
                  onClick={() => setDirection('inbound')}
                >
                  <PhoneIncoming className="h-3.5 w-3.5 mr-1" /> In
                </Button>
              </div>
            </div>
          </div>

          {/* Match result */}
          {matchResult && (
            <div className={cn(
              'flex items-center gap-3 rounded-lg border p-3',
              matchResult.matched
                ? 'border-success/30 bg-success/5'
                : 'border-warning/30 bg-warning/5'
            )}>
              {matchResult.matched ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">{matchResult.entity_name}</p>
                    <p className="text-xs text-muted-foreground capitalize">{matchResult.entity_type}</p>
                  </div>
                  <Badge variant="outline" className="capitalize text-xs shrink-0">{matchResult.entity_type}</Badge>
                </>
              ) : (
                <>
                  <AlertCircle className="h-4 w-4 text-warning shrink-0" />
                  <p className="text-sm text-muted-foreground">No match found for this number</p>
                </>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label>Duration (seconds)</Label>
            <Input
              type="number"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              placeholder="e.g. 180"
            />
          </div>

          <div className="space-y-2">
            <Label>Call Notes *</Label>
            <Textarea
              rows={5}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What was discussed? Key points, next steps, etc."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="gold" onClick={handleSave} disabled={saving || !phone.trim() || !notes.trim()}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Save Call
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Link Call Dialog ----
function LinkCallDialog({
  open, onOpenChange, call,
}: {
  open: boolean; onOpenChange: (v: boolean) => void; call: CallLog | null;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [linking, setLinking] = useState(false);

  const handleSearch = async () => {
    if (!search.trim()) return;
    setSearching(true);
    const q = search.trim();
    const [cRes, ctRes] = await Promise.all([
      supabase.from('candidates').select('id, full_name, email, phone, current_title').or(`full_name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`).limit(5),
      supabase.from('contacts').select('id, full_name, email, phone, title').or(`full_name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`).limit(5),
    ]);
    setResults([
      ...(cRes.data || []).map(r => ({ ...r, entity_type: 'candidate' })),
      ...(ctRes.data || []).map(r => ({ ...r, entity_type: 'contact' })),
    ]);
    setSearching(false);
  };

  // Auto-search by phone number on open
  const handleAutoTag = async () => {
    if (!call) return;
    setSearching(true);
    const normalized = call.phone_number.replace(/[^0-9+]/g, '');
    const [cRes, ctRes] = await Promise.all([
      supabase.from('candidates').select('id, full_name, email, phone, current_title').not('phone', 'is', null),
      supabase.from('contacts').select('id, full_name, email, phone, title').not('phone', 'is', null),
    ]);
    const norm = (p: string) => p.replace(/[^0-9+]/g, '');
    const matches = [
      ...(cRes.data || []).filter(r => r.phone && norm(r.phone) === normalized).map(r => ({ ...r, entity_type: 'candidate' })),
      ...(ctRes.data || []).filter(r => r.phone && norm(r.phone) === normalized).map(r => ({ ...r, entity_type: 'contact' })),
    ];
    setResults(matches);
    setSearching(false);
    if (matches.length === 0) {
      setSearch(call.phone_number);
    }
  };

  const handleLink = async (entityType: string, entityId: string, entityName: string) => {
    if (!call) return;
    setLinking(true);
    try {
      await supabase.from('call_logs' as any).update({
        linked_entity_type: entityType,
        linked_entity_id: entityId,
        linked_entity_name: entityName,
      }).eq('id', call.id);
      if (call.notes) {
        const userId = (await supabase.auth.getUser()).data.user?.id;
        await supabase.from('notes').insert({
          entity_id: entityId,
          entity_type: entityType,
          note: `📞 Call Notes (${format(new Date(call.started_at), 'MMM d')}): ${call.notes}`,
          created_by: userId,
        });
      }
      queryClient.invalidateQueries({ queryKey: ['call_logs'] });
      toast.success(`Tagged to ${entityName}`);
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to link');
    } finally {
      setLinking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { setSearch(''); setResults([]); } onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            Link Call to Record
          </DialogTitle>
        </DialogHeader>
        {call && (
          <p className="text-xs text-muted-foreground -mt-2">
            {call.direction === 'outbound' ? 'Outbound' : 'Inbound'} call · {call.phone_number}
          </p>
        )}
        <div className="space-y-3">
          <Button variant="outline" size="sm" className="w-full gap-1.5" onClick={handleAutoTag} disabled={searching}>
            {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Phone className="h-3.5 w-3.5" />}
            Auto-match by phone number
          </Button>

          <div className="flex items-center gap-2">
            <div className="flex-1 h-px bg-border" />
            <span className="text-[10px] text-muted-foreground">or search manually</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          <div className="flex gap-2">
            <Input
              placeholder="Search name, email, or phone..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="h-8 text-xs"
            />
            <Button size="sm" variant="outline" onClick={handleSearch} disabled={searching} className="h-8 px-2">
              {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            </Button>
          </div>

          {results.length > 0 && (
            <div className="rounded-lg border border-border overflow-hidden max-h-60 overflow-y-auto">
              {results.map((r) => (
                <button
                  key={r.id + r.entity_type}
                  onClick={() => handleLink(r.entity_type, r.id, r.full_name)}
                  disabled={linking}
                  className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-muted/50 transition-colors border-b border-border/50 last:border-b-0 text-left"
                >
                  {r.entity_type === 'candidate'
                    ? <UserCheck className="h-3.5 w-3.5 text-success shrink-0" />
                    : <Users className="h-3.5 w-3.5 text-info shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">{r.full_name}</p>
                    <p className="text-[10px] text-muted-foreground truncate capitalize">
                      {r.entity_type} · {r.current_title || r.title || r.email || r.phone || ''}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {results.length === 0 && search && !searching && (
            <p className="text-xs text-muted-foreground text-center py-3">No matches found</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- Main page ----
const Calls = () => {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [recruiterFilter, setRecruiterFilter] = useState<string>('all');
  const [logOpen, setLogOpen] = useState(false);
  const [linkCall, setLinkCall] = useState<CallLog | null>(null);
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(new Set());
  const [detailCall, setDetailCall] = useState<{ call: CallLog; aiNotes?: any } | null>(null);
  const queryClient = useQueryClient();

  // Fetch recruiter profiles for filter
  const { data: recruiters = [] } = useQuery({
    queryKey: ['recruiter_profiles'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles' as any)
        .select('id, full_name')
        .order('full_name');
      if (error) throw error;
      return (data ?? []) as { id: string; full_name: string }[];
    },
  });

  const { data: calls = [], isLoading, isError, error: callsError, refetch } = useQuery({
    queryKey: ['call_logs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('call_logs' as any)
        .select('*')
        .order('started_at', { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as unknown as CallLog[];
    },
  });

  // Fetch ALL ai_call_notes (not just those with call_log_id, since most aren't linked yet)
  const { data: aiNotesList = [] } = useQuery({
    queryKey: ['ai_call_notes_all'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ai_call_notes' as any)
        .select('*, candidates(id, first_name, last_name, full_name, current_title, current_company)')
        .order('created_at', { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  // Build lookup maps: by call_log_id AND by phone_number for fallback matching
  const { aiByCallLogId, aiByPhone } = useMemo(() => {
    const byId = new Map<string, any>();
    const byPhone = new Map<string, any>();
    for (const note of aiNotesList) {
      if (note.call_log_id) byId.set(note.call_log_id, note);
      if (note.phone_number) {
        // Keep the most recent note per phone number
        if (!byPhone.has(note.phone_number)) byPhone.set(note.phone_number, note);
      }
    }
    return { aiByCallLogId: byId, aiByPhone: byPhone };
  }, [aiNotesList]);

  const getAiNotes = (call: CallLog) =>
    aiByCallLogId.get(call.id) || aiByPhone.get(call.phone_number) || null;

  const getCandidateName = (call: CallLog) => {
    const ai = getAiNotes(call);
    if (call.linked_entity_name) return call.linked_entity_name;
    if (ai?.candidates) {
      const c = ai.candidates;
      return c.full_name || `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || null;
    }
    return null;
  };

  const getCandidateId = (call: CallLog) => {
    const ai = getAiNotes(call);
    if (call.linked_entity_type === 'candidate' && call.linked_entity_id) return call.linked_entity_id;
    return ai?.candidates?.id ?? null;
  };

  const getRecruiterName = (call: CallLog) =>
    recruiters.find(r => r.id === call.owner_id)?.full_name ?? null;

  const filtered = calls.filter(c => {
    // Recruiter filter
    if (recruiterFilter !== 'all' && c.owner_id !== recruiterFilter) return false;

    // Search
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const name = getCandidateName(c);
    const ai = getAiNotes(c);
    return (
      c.phone_number?.includes(searchQuery) ||
      name?.toLowerCase().includes(q) ||
      c.summary?.toLowerCase().includes(q) ||
      c.notes?.toLowerCase().includes(q) ||
      ai?.ai_summary?.toLowerCase().includes(q)
    );
  });

  const formatDuration = (seconds?: number | null) => {
    if (!seconds) return '--:--';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const entityIcon = (type: string | null) => {
    if (type === 'candidate') return <UserCheck className="h-3.5 w-3.5" />;
    if (type === 'contact') return <Users className="h-3.5 w-3.5" />;
    return <User className="h-3.5 w-3.5" />;
  };

  const entityColor = (type: string | null) => {
    if (type === 'candidate') return 'border-success/30 bg-success/5 text-success';
    if (type === 'contact') return 'border-info/30 bg-info/5 text-info';
    return 'border-border bg-muted text-muted-foreground';
  };

  return (
    <MainLayout>
      <PageHeader
        title="Calls"
        description="Call history with notes auto-tagged to candidates and contacts."
        actions={
          <Button variant="gold" onClick={() => setLogOpen(true)}>
            <Plus className="h-4 w-4" />
            Log Call
          </Button>
        }
      />

      <div className="p-8">
        {/* Search + Recruiter Filter */}
        <div className="flex items-center gap-4 mb-6">
          <div className="relative max-w-md flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search by name, phone, or notes..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-10 pl-10 pr-4 rounded-lg border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {/* Recruiter filter */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setRecruiterFilter('all')}
              className={cn(
                'px-3 py-2 text-xs font-medium rounded-md transition-colors',
                recruiterFilter === 'all'
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted',
              )}
            >
              All
            </button>
            {recruiters.map(r => (
              <button
                key={r.id}
                onClick={() => setRecruiterFilter(r.id)}
                className={cn(
                  'px-3 py-2 text-xs font-medium rounded-md transition-colors',
                  recruiterFilter === r.id
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                )}
              >
                {r.full_name?.split(' ')[0]}
              </button>
            ))}
          </div>
        </div>

        <p className="text-xs text-muted-foreground mb-4">{filtered.length} calls</p>

        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading calls...
          </div>
        ) : isError ? (
          <div className="text-center py-16">
            <AlertCircle className="h-12 w-12 mx-auto text-destructive/40 mb-4" />
            <h3 className="text-lg font-medium text-foreground mb-1">Failed to load calls</h3>
            <p className="text-sm text-muted-foreground mb-4">{(callsError as any)?.message || 'An error occurred while fetching call logs.'}</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4 mr-1" /> Retry
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <Phone className="h-12 w-12 mx-auto text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-medium text-foreground mb-1">No calls logged yet</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Log a call to automatically tag it to a candidate or contact by phone number.
            </p>
            <Button variant="gold" size="sm" onClick={() => setLogOpen(true)}>
              <Plus className="h-4 w-4 mr-1" /> Log a Call
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {filtered.map((call) => {
              const ai = getAiNotes(call);
              const personName = getCandidateName(call);
              const candidateId = getCandidateId(call);
              const summary = ai?.ai_summary || call.summary;
              const audioUrl = ai?.recording_url || call.audio_url;

              return (
              <div
                key={call.id}
                className="rounded-lg border border-border bg-card p-5 hover:border-accent/40 transition-all cursor-pointer"
                onClick={() => setDetailCall({ call, aiNotes: ai })}
              >
                <div className="flex items-start gap-4">
                  {/* Icon */}
                  <div className={cn(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
                    call.direction === 'outbound' ? 'bg-info/10 text-info' : 'bg-success/10 text-success'
                  )}>
                    {call.direction === 'outbound'
                      ? <PhoneOutgoing className="h-5 w-5" />
                      : <PhoneIncoming className="h-5 w-5" />}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-sm font-medium text-foreground">
                            {call.direction === 'outbound' ? 'Outbound' : 'Inbound'} Call
                          </h3>
                          <span className="text-xs text-muted-foreground">{call.phone_number}</span>
                          {getRecruiterName(call) && (
                            <span className="text-xs text-muted-foreground/70">{getRecruiterName(call)?.split(' ')[0]}</span>
                          )}
                          {personName && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                const navId = call.linked_entity_id || candidateId;
                                const navType = call.linked_entity_type || (candidateId ? 'candidate' : null);
                                if (navId && navType) {
                                  const path = navType === 'candidate'
                                    ? `/candidates/${navId}`
                                    : navType === 'contact'
                                      ? `/contacts/${navId}`
                                      : null;
                                  if (path) navigate(path);
                                }
                              }}
                              className={cn(
                                'inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded border cursor-pointer hover:opacity-80 transition-opacity',
                                entityColor(call.linked_entity_type || (candidateId ? 'candidate' : null))
                              )}
                            >
                              {entityIcon(call.linked_entity_type || (candidateId ? 'candidate' : null))}
                              {personName}
                            </button>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {format(new Date(call.started_at), 'MMM d, yyyy · h:mm a')}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                        <span className="flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" />
                          {formatDuration(call.duration_seconds)}
                        </span>
                        <Badge
                          variant="outline"
                          className={cn(
                            'capitalize text-xs',
                            call.status === 'completed' && 'border-success/30 text-success',
                            call.status === 'in_progress' && 'border-warning/30 text-warning',
                          )}
                        >
                          {call.status}
                        </Badge>
                      </div>
                    </div>

                    {/* Summary / Notes — prefer AI summary, then call summary, then raw notes */}
                    {(summary || call.notes) && (() => {
                      if (summary) {
                        return (
                          <div className="mt-2 p-3 rounded-lg bg-accent/5 border border-accent/20">
                            <div className="flex items-center gap-2 mb-1">
                              <FileText className="h-3.5 w-3.5 text-accent" />
                              <span className="text-xs font-medium text-accent">Summary</span>
                            </div>
                            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{summary}</p>
                          </div>
                        );
                      }
                      const isExpanded = expandedNotes.has(call.id);
                      const needsTruncation = (call.notes?.length ?? 0) > 300;
                      return (
                        <div className="mt-3 p-3 rounded-lg bg-muted/50">
                          <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                            {isExpanded || !needsTruncation ? call.notes : `${call.notes!.slice(0, 300)}...`}
                          </p>
                          {needsTruncation && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpandedNotes(prev => {
                                  const next = new Set(prev);
                                  isExpanded ? next.delete(call.id) : next.add(call.id);
                                  return next;
                                });
                              }}
                              className="text-xs text-accent hover:underline mt-1"
                            >
                              {isExpanded ? 'Show less' : 'Show more'}
                            </button>
                          )}
                        </div>
                      );
                    })()}

                    {/* Action Items from AI */}
                    {ai?.ai_action_items && (
                      <div className="mt-2 p-3 rounded-lg bg-muted/50">
                        <div className="flex items-center gap-2 mb-1">
                          <ListChecks className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-xs font-medium text-muted-foreground">Action Items</span>
                        </div>
                        <p className="text-sm text-foreground whitespace-pre-wrap">{ai.ai_action_items}</p>
                      </div>
                    )}

                    {/* Audio Recording */}
                    {audioUrl && (
                      <div className="mt-2 p-3 rounded-lg bg-muted/30 border border-border">
                        <div className="flex items-center gap-2 mb-2">
                          <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-xs font-medium text-muted-foreground">Recording</span>
                        </div>
                        <audio controls className="w-full h-8" preload="none" onClick={(e) => e.stopPropagation()}>
                          <source src={audioUrl} />
                        </audio>
                      </div>
                    )}

                    {/* Tag to record if not linked */}
                    {!call.linked_entity_id && !candidateId && (
                      <div className="mt-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-xs gap-1"
                          onClick={(e) => { e.stopPropagation(); setLinkCall(call); }}
                        >
                          <UserPlus className="h-3 w-3" />
                          Tag to Record
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>

      <LogCallDialog open={logOpen} onOpenChange={setLogOpen} />
      <LinkCallDialog open={!!linkCall} onOpenChange={(v) => !v && setLinkCall(null)} call={linkCall} />
      <CallDetailModal
        open={!!detailCall}
        onOpenChange={(v) => !v && setDetailCall(null)}
        call={detailCall?.call}
        aiNotes={detailCall?.aiNotes}
      />
    </MainLayout>
  );
};

export default Calls;
