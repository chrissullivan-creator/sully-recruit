import { useState } from 'react';
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
  CheckCircle2, AlertCircle, UserPlus,
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
      const normalize = (p: string) => p.replace(/[^0-9+]/g, '');
      const candidate = cRes.data?.find(r => r.phone && normalize(r.phone) === normalized);
      if (candidate) { setMatchResult({ matched: true, entity_type: 'candidate', entity_id: candidate.id, entity_name: candidate.full_name }); setMatching(false); return; }
      const contact = ctRes.data?.find(r => r.phone && normalize(r.phone) === normalized);
      if (contact) { setMatchResult({ matched: true, entity_type: 'contact', entity_id: contact.id, entity_name: contact.full_name }); setMatching(false); return; }
      setMatchResult({ matched: false, entity_type: null, entity_id: null, entity_name: null });
    } catch { setMatchResult(null); }
    setMatching(false);
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
      if (matchResult?.matched && matchResult.entity_id && matchResult.entity_type) {
        const { error: noteError } = await supabase.from('notes').insert({
          entity_id: matchResult.entity_id,
          entity_type: matchResult.entity_type,
          note: `📞 Call Notes: ${notes}`,
          created_by: user?.id,
        });
        if (noteError) console.error('Note error:', noteError);
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

// ---- Main page ----
const Calls = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [logOpen, setLogOpen] = useState(false);

  const { data: calls = [], isLoading } = useQuery({
    queryKey: ['call_logs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('call_logs' as any)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as CallLog[];
    },
  });

  const filtered = calls.filter(c =>
    !searchQuery ||
    c.phone_number?.includes(searchQuery) ||
    c.linked_entity_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.notes?.toLowerCase().includes(searchQuery.toLowerCase())
  );

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
        {/* Search */}
        <div className="relative max-w-md mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by name, phone, or notes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-10 pl-10 pr-4 rounded-lg border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading calls...
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
            {filtered.map((call) => (
              <div
                key={call.id}
                className="rounded-lg border border-border bg-card p-5 hover:border-accent/40 transition-all"
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
                          {call.linked_entity_name && (
                            <span className={cn(
                              'inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded border',
                              entityColor(call.linked_entity_type)
                            )}>
                              {entityIcon(call.linked_entity_type)}
                              {call.linked_entity_name}
                            </span>
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

                    {/* Notes */}
                    {call.notes && (
                      <div className="mt-3 p-3 rounded-lg bg-muted/50">
                        <p className="text-sm text-foreground leading-relaxed">{call.notes}</p>
                      </div>
                    )}

                    {/* AI Summary */}
                    {call.summary && (
                      <div className="mt-2 p-3 rounded-lg bg-accent/5 border border-accent/20">
                        <div className="flex items-center gap-2 mb-1">
                          <FileText className="h-3.5 w-3.5 text-accent" />
                          <span className="text-xs font-medium text-accent">Summary</span>
                        </div>
                        <p className="text-sm text-muted-foreground">{call.summary}</p>
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
    </MainLayout>
  );
};

export default Calls;
