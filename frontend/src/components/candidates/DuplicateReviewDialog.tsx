import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { invalidatePersonScope } from '@/lib/invalidate';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Users, ChevronLeft, ChevronRight, Merge, X, Loader2, RefreshCw,
  Mail, Phone, Linkedin, Building, MapPin, Briefcase,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface DuplicatePair {
  id: string;
  candidate_id_a: string;
  candidate_id_b: string;
  match_type: string;
  match_value: string | null;
  confidence: number;
  status: string;
  created_at: string;
}

interface CandidateInfo {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  linkedin_url: string | null;
  current_title: string;
  current_company: string;
  location_text: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  notes: string | null;
  skills: string[] | null;
  // Counts
  _conversationCount?: number;
  _enrollmentCount?: number;
  _noteCount?: number;
}

const MATCH_TYPE_LABELS: Record<string, string> = {
  email: 'Email',
  phone: 'Phone',
  linkedin: 'LinkedIn',
  name_company: 'Name + Company',
};

const MATCH_TYPE_ICONS: Record<string, React.ReactNode> = {
  email: <Mail className="h-3 w-3" />,
  phone: <Phone className="h-3 w-3" />,
  linkedin: <Linkedin className="h-3 w-3" />,
  name_company: <Building className="h-3 w-3" />,
};

function CandidateCard({
  candidate,
  isSelected,
  onSelect,
  side,
}: {
  candidate: CandidateInfo;
  isSelected: boolean;
  onSelect: () => void;
  side: 'left' | 'right';
}) {
  const name = `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim() || 'Unknown';

  return (
    <div
      onClick={onSelect}
      className={cn(
        'flex-1 rounded-lg border p-4 cursor-pointer transition-all',
        isSelected
          ? 'border-primary bg-primary/5 ring-2 ring-primary/30'
          : 'border-border hover:border-primary/50 hover:bg-muted/30'
      )}
    >
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-semibold text-foreground">{name}</h4>
        {isSelected && (
          <Badge className="bg-primary/20 text-primary text-xs">Keep This One</Badge>
        )}
      </div>

      <div className="space-y-1.5 text-sm">
        {candidate.current_title && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Briefcase className="h-3 w-3 shrink-0" />
            <span className="truncate">{candidate.current_title}</span>
          </div>
        )}
        {candidate.current_company && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Building className="h-3 w-3 shrink-0" />
            <span className="truncate">{candidate.current_company}</span>
          </div>
        )}
        {candidate.email && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Mail className="h-3 w-3 shrink-0" />
            <span className="truncate">{candidate.email}</span>
          </div>
        )}
        {candidate.phone && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Phone className="h-3 w-3 shrink-0" />
            <span>{candidate.phone}</span>
          </div>
        )}
        {candidate.linkedin_url && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Linkedin className="h-3 w-3 shrink-0" />
            <span className="truncate">{candidate.linkedin_url.replace(/^https?:\/\/(www\.)?linkedin\.com/, '')}</span>
          </div>
        )}
        {candidate.location_text && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <MapPin className="h-3 w-3 shrink-0" />
            <span className="truncate">{candidate.location_text}</span>
          </div>
        )}
      </div>

      <div className="mt-3 pt-3 border-t border-border flex items-center gap-3 text-xs text-muted-foreground">
        <span>Status: <Badge variant="outline" className="text-xs ml-1">{candidate.status}</Badge></span>
        {candidate._conversationCount !== undefined && (
          <span>{candidate._conversationCount} conversations</span>
        )}
        {candidate._enrollmentCount !== undefined && (
          <span>{candidate._enrollmentCount} enrollments</span>
        )}
        {candidate._noteCount !== undefined && (
          <span>{candidate._noteCount} notes</span>
        )}
      </div>

      <div className="mt-2 text-xs text-muted-foreground">
        Created {new Date(candidate.created_at).toLocaleDateString()}
        {' · '}Updated {new Date(candidate.updated_at).toLocaleDateString()}
      </div>
    </div>
  );
}

export function DuplicateReviewDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [pairs, setPairs] = useState<DuplicatePair[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [merging, setMerging] = useState(false);
  const [candidateA, setCandidateA] = useState<CandidateInfo | null>(null);
  const [candidateB, setCandidateB] = useState<CandidateInfo | null>(null);
  const [selectedSurvivor, setSelectedSurvivor] = useState<'a' | 'b' | null>(null);

  const currentPair = pairs[currentIndex] || null;

  // Fetch pending duplicate pairs
  const fetchPairs = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('duplicate_candidates')
        .select('*')
        .eq('status', 'pending')
        .order('confidence', { ascending: false })
        .order('created_at', { ascending: true });

      if (error) throw error;
      setPairs((data as any[]) || []);
      setCurrentIndex(0);
    } catch (err: any) {
      toast.error('Failed to load duplicates: ' + err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch candidate details for current pair
  const fetchCandidateDetails = useCallback(async (pair: DuplicatePair) => {
    setCandidateA(null);
    setCandidateB(null);
    setSelectedSurvivor(null);

    const fetchOne = async (id: string): Promise<CandidateInfo | null> => {
      const { data: candidate } = await supabase
        .from('people')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (!candidate) return null;

      // Get activity counts
      const [convRes, enrollRes, noteRes] = await Promise.all([
        supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('candidate_id', id),
        supabase.from('sequence_enrollments').select('id', { count: 'exact', head: true }).eq('candidate_id', id),
        supabase.from('notes').select('id', { count: 'exact', head: true }).eq('entity_id', id).eq('entity_type', 'candidate'),
      ]);

      return {
        ...candidate,
        _conversationCount: convRes.count || 0,
        _enrollmentCount: enrollRes.count || 0,
        _noteCount: noteRes.count || 0,
      } as CandidateInfo;
    };

    const [a, b] = await Promise.all([
      fetchOne(pair.candidate_id_a),
      fetchOne(pair.candidate_id_b),
    ]);

    setCandidateA(a);
    setCandidateB(b);

    // Auto-select the candidate with more activity
    if (a && b) {
      const scoreA = (a._conversationCount || 0) + (a._enrollmentCount || 0) + (a._noteCount || 0);
      const scoreB = (b._conversationCount || 0) + (b._enrollmentCount || 0) + (b._noteCount || 0);
      setSelectedSurvivor(scoreA >= scoreB ? 'a' : 'b');
    }
  }, []);

  useEffect(() => {
    if (open) fetchPairs();
  }, [open, fetchPairs]);

  useEffect(() => {
    if (currentPair) fetchCandidateDetails(currentPair);
  }, [currentPair, fetchCandidateDetails]);

  const handleMerge = async () => {
    if (!selectedSurvivor || !currentPair || !candidateA || !candidateB) return;

    const survivorId = selectedSurvivor === 'a' ? candidateA.id : candidateB.id;
    const mergedId = selectedSurvivor === 'a' ? candidateB.id : candidateA.id;

    setMerging(true);
    try {
      // Call the merge RPC directly for synchronous, atomic merge
      const { data, error } = await supabase.rpc('merge_duplicate_candidate', {
        p_survivor_id: survivorId,
        p_merged_id: mergedId,
        p_duplicate_row_id: currentPair.id,
      });

      if (error) throw error;

      const result = data as any;
      const fieldsCount = result?.fields_filled?.length || 0;
      toast.success(
        `Merged successfully${fieldsCount > 0 ? ` — ${fieldsCount} field${fieldsCount > 1 ? 's' : ''} filled from duplicate` : ''}`
      );

      // Remove this pair and move to next
      const newPairs = pairs.filter((_, i) => i !== currentIndex);
      setPairs(newPairs);
      if (currentIndex >= newPairs.length && newPairs.length > 0) {
        setCurrentIndex(newPairs.length - 1);
      }

      invalidatePersonScope(queryClient);
    } catch (err: any) {
      toast.error('Merge failed: ' + err.message);
    } finally {
      setMerging(false);
    }
  };

  const handleDismiss = async () => {
    if (!currentPair) return;

    try {
      await supabase
        .from('duplicate_candidates')
        .update({ status: 'dismissed' })
        .eq('id', currentPair.id);

      const newPairs = pairs.filter((_, i) => i !== currentIndex);
      setPairs(newPairs);
      if (currentIndex >= newPairs.length && newPairs.length > 0) {
        setCurrentIndex(newPairs.length - 1);
      }

      toast.success('Dismissed — not a duplicate');
    } catch (err: any) {
      toast.error('Failed to dismiss: ' + err.message);
    }
  };

  const handleScan = async () => {
    setScanning(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch('/api/dedup/scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token || ''}`,
        },
      });

      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || 'Scan failed');
      }

      toast.success('Duplicate scan started — results will appear shortly');

      // Wait a few seconds then refresh
      setTimeout(() => fetchPairs(), 5000);
    } catch (err: any) {
      toast.error('Scan failed: ' + err.message);
    } finally {
      setScanning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Duplicate Review
            {pairs.length > 0 && (
              <Badge variant="secondary" className="ml-2">{pairs.length} pending</Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            Review potential duplicates and choose which record to keep. All related data (conversations, enrollments, notes) will be merged into the survivor.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : pairs.length === 0 ? (
          <div className="text-center py-12">
            <Users className="h-12 w-12 mx-auto mb-4 text-muted-foreground/50" />
            <p className="text-muted-foreground mb-4">No pending duplicates found</p>
            <Button variant="outline" onClick={handleScan} disabled={scanning}>
              {scanning ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
              Scan for Duplicates
            </Button>
          </div>
        ) : (
          <>
            {/* Navigation + Match Info */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={currentIndex === 0}
                  onClick={() => setCurrentIndex(currentIndex - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm text-muted-foreground">
                  {currentIndex + 1} of {pairs.length}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={currentIndex >= pairs.length - 1}
                  onClick={() => setCurrentIndex(currentIndex + 1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>

              {currentPair && (
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="gap-1">
                    {MATCH_TYPE_ICONS[currentPair.match_type]}
                    {MATCH_TYPE_LABELS[currentPair.match_type] || currentPair.match_type}
                  </Badge>
                  {currentPair.match_value && (
                    <span className="text-xs text-muted-foreground font-mono">
                      {currentPair.match_value}
                    </span>
                  )}
                </div>
              )}

              <Button variant="outline" size="sm" onClick={handleScan} disabled={scanning}>
                {scanning ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
                Re-scan
              </Button>
            </div>

            {/* Side-by-side candidates */}
            {candidateA && candidateB ? (
              <div className="flex gap-4">
                <CandidateCard
                  candidate={candidateA}
                  isSelected={selectedSurvivor === 'a'}
                  onSelect={() => setSelectedSurvivor('a')}
                  side="left"
                />
                <CandidateCard
                  candidate={candidateB}
                  isSelected={selectedSurvivor === 'b'}
                  onSelect={() => setSelectedSurvivor('b')}
                  side="right"
                />
              </div>
            ) : (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-between pt-2 border-t border-border">
              <Button variant="ghost" size="sm" onClick={handleDismiss}>
                <X className="h-4 w-4 mr-1" />
                Not a Duplicate
              </Button>

              <Button
                variant="gold"
                disabled={!selectedSurvivor || merging}
                onClick={handleMerge}
              >
                {merging ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Merge className="h-4 w-4 mr-1" />
                )}
                Merge — Keep {selectedSurvivor === 'a' && candidateA
                  ? `${candidateA.first_name} ${candidateA.last_name}`.trim()
                  : selectedSurvivor === 'b' && candidateB
                    ? `${candidateB.first_name} ${candidateB.last_name}`.trim()
                    : '...'}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
