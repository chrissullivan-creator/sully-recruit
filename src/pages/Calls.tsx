import { useState } from 'react';
import { Link } from 'react-router-dom';
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
  CheckCircle2, AlertCircle, Tag, ExternalLink, Sparkles,
} from 'lucide-react';

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
  external_call_id: string | null;
}

const formatDuration = (seconds?: number | null) => {
  if (!seconds) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

// ---- Tag Dialog ----
function TagDialog({
  call,
  open,
  onOpenChange,
}: {
  call: CallLog | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<{ id: string; name: string; type: 'candidate' | 'contact' } | null>(null);

  const { data: results = [], isFetching } = useQuery({
    queryKey: ['tag_search', search],
    queryFn: async () => {
      if (search.trim().length < 2) return [];
      const q = search.trim();
      const [{ data: cands }, { data: conts }] = await Promise.all([
        supabase.from('candidates').select('id, full_name').ilike('full_name', `%${q}%`).limit(8),
        supabase.from('contacts').select('id, full_name').ilike('full_name', `%${q}%`).limit(8),
      ]);
      return [
        ...(cands ?? []).map((c) => ({ id: c.id, name: c.full_name ?? '', type: 'candidate' as const })),
        ...(conts ?? []).map((c) => ({ id: c.id, name: (c as any).full_name ?? '', type: 'contact' as const })),
      ];
    },
    enabled: search.trim().length >= 2,
  });

  const handleSave = async () => {
    if (!call || !selected) return;
    setSaving(true);
    try {
      const { error } = await (supabase as any)
        .from('call_logs')
        .update({
          linked_entity_id: selected.id,
          linked_entity_type: selected.type,
          linked_entity_name: selected.name,
        })
        .eq('id', call.id);
      if (error) throw error;

      // Sync note to the entity
      const durationStr = call.duration_seconds ? ` (${formatDuration(call.duration_seconds)})` : '';
      let noteText = `📞 ${call.direction === 'outbound' ? 'Outbound' : 'Inbound'} call${durationStr}`;
      if (call.notes) noteText += `\n${call.notes}`;
      if (call.summary) noteText += `\n🤖 Summary: ${call.summary}`;

      await supabase.from('notes').insert({
        entity_id: selected.id,
        entity_type: selected.type,
        note: noteText,
        created_by: user?.id ?? null,
      });

      queryClient.invalidateQueries({ queryKey: ['call_logs'] });
      toast.success(`Tagged to ${selected.name} — note synced`);
      onOpenChange(false);
      setSearch('');
      setSelected(null);
    } catch (err: any) {
      toast.error(err.message || 'Failed to tag call');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) { setSearch(''); setSelected(null); } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Tag Call to Candidate or Contact</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Phone: <span className="font-medium text-foreground">{call?.phone_number}</span>
          </p>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              autoFocus
              value={search}
              onChange={(e) => { setSearch(e.target.value); setSelected(null); }}
              placeholder="Search by name…"
              className="pl-9"
            />
          </div>

          {isFetching && <p className="text-xs text-muted-foreground">Searching…</p>}

          {results.length > 0 && (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {results.map((r) => (
                <button
                  key={`${r.type}-${r.id}`}
                  onClick={() => setSelected(r)}
                  className={cn(
                    'w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
                    selected?.id === r.id
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-muted/60'
                  )}
                >
                  {r.type === 'candidate'
                    ? <UserCheck className="h-4 w-4 text-success shrink-0" />
                    : <Users className="h-4 w-4 text-info shrink-0" />}
                  <span className="text-sm font-medium flex-1">{r.name}</span>
                  <Badge variant="outline" className="capitalize text-xs shrink-0">{r.type}</Badge>
                </button>
              ))}
            </div>
          )}

          {search.trim().length >= 2 && !isFetching && results.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-2">No matches found</p>
          )}

          {selected && (
            <p className="text-xs text-muted-foreground">
              A note will be automatically added to {selected.name}'s profile.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="gold" onClick={handleSave} disabled={!selected || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Tag className="h-4 w-4 mr-1" />}
            Tag to {selected?.name ?? '…'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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
      const normalized = phone.replace(/[^0-9+]/g, '');
      const [cRes, ctRes] = await Promise.all([
        supabase.from('candidates').select('id, full_name, phone').not('phone', 'is', null),
        supabase.from('contacts').select('id, full_name, phone').not('phone', 'is', null),
      ]);
      const norm = (p: string) => p.replace(/[^0-9+]/g, '');
      const candidate = cRes.data?.find(r => r.phone && norm(r.phone) === normalized);
      if (candidate) { setMatchResult({ matched: true, entity_type: 'candidate', entity_id: candidate.id, entity_name: candidate.full_name }); setMatching(false); return; }
      const contact = ctRes.data?.find((r: any) => r.phone && norm(r.phone) === normalized);
      if (contact) { setMatchResult({ matched: true, entity_type: 'contact', entity_id: (contact as any).id, entity_name: (contact as any).full_name }); setMatching(false); return; }
      setMatchResult({ matched: false, entity_type: null, entity_id: null, entity_name: null });
    } catch { setMatchResult(null); }
    setMatching(false);
  };

  const handleSave = async () => {
    if (!phone.trim() || !notes.trim()) { toast.error('Phone number and notes are required'); return; }
    setSaving(true);
    try {
      const { data: callData, error: callError } = await (supabase as any).from('call_logs').insert({
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

      if (matchResult?.matched && matchResult.entity_id && matchResult.entity_type) {
        await supabase.from('notes').insert({
          entity_id: matchResult.entity_id,
          entity_type: matchResult.entity_type,
          note: `📞 Call Notes: ${notes}`,
          created_by: user?.id,
        });
      }

      queryClient.invalidateQueries({ queryKey: ['call_logs'] });
      toast.success('Call logged successfully');
      setPhone(''); setNotes(''); setDuration(''); setMatchResult(null);
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to log call');
    } finally {
      setSaving(false);
    }
  };

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
                <Button variant={direction === 'outbound' ? 'gold' : 'outline'} size="sm" className="flex-1" onClick={() => setDirection('outbound')}>
                  <PhoneOutgoing className="h-3.5 w-3.5 mr-1" /> Out
                </Button>
                <Button variant={direction === 'inbound' ? 'gold' : 'outline'} size="sm" className="flex-1" onClick={() => setDirection('inbound')}>
                  <PhoneIncoming className="h-3.5 w-3.5 mr-1" /> In
                </Button>
              </div>
            </div>
          </div>

          {matchResult && (
            <div className={cn(
              'flex items-center gap-3 rounded-lg border p-3',
              matchResult.matched ? 'border-success/30 bg-success/5' : 'border-warning/30 bg-warning/5'
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
            <Input type="number" value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="e.g. 180" />
          </div>

          <div className="space-y-2">
            <Label>Call Notes *</Label>
            <Textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was discussed? Key points, next steps, etc." />
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

// ---- Entity badge / link ----
function EntityBadge({ call }: { call: CallLog }) {
  if (!call.linked_entity_name) return null;
  const href = call.linked_entity_type === 'candidate'
    ? `/candidates/${call.linked_entity_id}`
    : `/contacts/${call.linked_entity_id}`;
  const colorClass = call.linked_entity_type === 'candidate'
    ? 'border-success/30 bg-success/5 text-success'
    : 'border-info/30 bg-info/5 text-info';
  const Icon = call.linked_entity_type === 'candidate' ? UserCheck : Users;
  return (
    <Link
      to={href}
      onClick={(e) => e.stopPropagation()}
      className={cn('inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded border hover:opacity-80 transition-opacity', colorClass)}
    >
      <Icon className="h-3.5 w-3.5" />
      {call.linked_entity_name}
      <ExternalLink className="h-2.5 w-2.5 ml-0.5 opacity-60" />
    </Link>
  );
}

// ---- Main page ----
type FilterTab = 'all' | 'untagged';

const Calls = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<FilterTab>('all');
  const [logOpen, setLogOpen] = useState(false);
  const [tagCall, setTagCall] = useState<CallLog | null>(null);

  const { data: calls = [], isLoading } = useQuery({
    queryKey: ['call_logs'],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('call_logs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as CallLog[];
    },
  });

  const filtered = calls.filter((c) => {
    if (filter === 'untagged' && c.linked_entity_name) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        c.phone_number?.includes(q) ||
        c.linked_entity_name?.toLowerCase().includes(q) ||
        c.notes?.toLowerCase().includes(q) ||
        c.summary?.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const untaggedCount = calls.filter((c) => !c.linked_entity_name).length;

  return (
    <MainLayout>
      <PageHeader
        title="Calls"
        description="Call history from RingCentral — auto-tagged to candidates and contacts by phone number."
        actions={
          <Button variant="gold" onClick={() => setLogOpen(true)}>
            <Plus className="h-4 w-4" />
            Log Call
          </Button>
        }
      />

      <div className="p-8">
        {/* Filter tabs */}
        <div className="flex items-center gap-2 mb-5">
          <Button
            variant={filter === 'all' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setFilter('all')}
          >
            All
            <Badge variant="outline" className="ml-1.5 text-[10px] h-4 px-1.5 py-0">{calls.length}</Badge>
          </Button>
          <Button
            variant={filter === 'untagged' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setFilter('untagged')}
          >
            Untagged
            {untaggedCount > 0 && (
              <Badge variant="outline" className="ml-1.5 text-[10px] h-4 px-1.5 py-0 border-warning/40 text-warning">{untaggedCount}</Badge>
            )}
          </Button>
        </div>

        {/* Search */}
        <div className="relative max-w-md mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by name, phone, notes…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-10 pl-10 pr-4 rounded-lg border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading calls…
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <Phone className="h-12 w-12 mx-auto text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-medium text-foreground mb-1">
              {filter === 'untagged' ? 'All calls are tagged' : 'No calls logged yet'}
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              {filter === 'untagged'
                ? 'Every call has been linked to a candidate or contact.'
                : 'Calls from RingCentral appear here automatically, or log one manually.'}
            </p>
            {filter === 'all' && (
              <Button variant="gold" size="sm" onClick={() => setLogOpen(true)}>
                <Plus className="h-4 w-4 mr-1" /> Log a Call
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {filtered.map((call) => (
              <div
                key={call.id}
                className="rounded-lg border border-border bg-card p-5 hover:border-accent/40 transition-all"
              >
                <div className="flex items-start gap-4">
                  {/* Direction icon */}
                  <div className={cn(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
                    call.direction === 'outbound' ? 'bg-info/10 text-info' : 'bg-success/10 text-success'
                  )}>
                    {call.direction === 'outbound'
                      ? <PhoneOutgoing className="h-5 w-5" />
                      : <PhoneIncoming className="h-5 w-5" />}
                  </div>

                  <div className="flex-1 min-w-0">
                    {/* Header row */}
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-sm font-medium text-foreground">
                            {call.direction === 'outbound' ? 'Outbound' : 'Inbound'} Call
                          </h3>
                          <span className="text-xs text-muted-foreground">{call.phone_number}</span>
                          <EntityBadge call={call} />
                          {!call.linked_entity_name && (
                            <button
                              onClick={() => setTagCall(call)}
                              className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded border border-dashed border-border text-muted-foreground hover:border-accent/60 hover:text-accent transition-colors"
                            >
                              <Tag className="h-3 w-3" /> Tag
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

                    {/* Call notes */}
                    {call.notes && (
                      <div className="mt-3 p-3 rounded-lg bg-muted/50">
                        <p className="text-sm text-foreground leading-relaxed">{call.notes}</p>
                      </div>
                    )}

                    {/* AI Summary */}
                    {call.summary && (
                      <div className="mt-2 p-3 rounded-lg bg-accent/5 border border-accent/20">
                        <div className="flex items-center gap-2 mb-1">
                          <Sparkles className="h-3.5 w-3.5 text-accent" />
                          <span className="text-xs font-medium text-accent">AI Summary</span>
                        </div>
                        <p className="text-sm text-muted-foreground leading-relaxed">{call.summary}</p>
                      </div>
                    )}

                    {/* Recording */}
                    {call.audio_url && (
                      <div className="mt-2 flex items-center gap-2">
                        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                        <a
                          href={call.audio_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-accent hover:underline flex items-center gap-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Open Recording <ExternalLink className="h-2.5 w-2.5" />
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <LogCallDialog open={logOpen} onOpenChange={setLogOpen} />
      <TagDialog call={tagCall} open={!!tagCall} onOpenChange={(v) => { if (!v) setTagCall(null); }} />
    </MainLayout>
  );
};

export default Calls;
