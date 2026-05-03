import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Merge, Loader2, Search, Mail, Phone, Linkedin,
  Building, MapPin, Briefcase, ArrowRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface CandidateResult {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  current_title: string | null;
  current_company: string | null;
  location_text: string | null;
  status: string;
  created_at: string;
}

function CandidateResultCard({
  candidate,
  isSelected,
  onClick,
}: {
  candidate: CandidateResult;
  isSelected: boolean;
  onClick: () => void;
}) {
  const name = `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim() || 'Unknown';

  return (
    <div
      onClick={onClick}
      className={cn(
        'rounded-lg border p-3 cursor-pointer transition-all',
        isSelected
          ? 'border-primary bg-primary/5 ring-2 ring-primary/30'
          : 'border-border hover:border-primary/50 hover:bg-muted/30'
      )}
    >
      <div className="flex items-center justify-between mb-1.5">
        <h4 className="font-medium text-sm text-foreground">{name}</h4>
        <Badge variant="outline" className="text-[10px]">{candidate.status}</Badge>
      </div>
      <div className="space-y-1 text-xs text-muted-foreground">
        {candidate.current_title && (
          <div className="flex items-center gap-1.5">
            <Briefcase className="h-3 w-3 shrink-0" />
            <span className="truncate">{candidate.current_title}</span>
          </div>
        )}
        {candidate.current_company && (
          <div className="flex items-center gap-1.5">
            <Building className="h-3 w-3 shrink-0" />
            <span className="truncate">{candidate.current_company}</span>
          </div>
        )}
        {candidate.email && (
          <div className="flex items-center gap-1.5">
            <Mail className="h-3 w-3 shrink-0" />
            <span className="truncate">{candidate.email}</span>
          </div>
        )}
        {candidate.phone && (
          <div className="flex items-center gap-1.5">
            <Phone className="h-3 w-3 shrink-0" />
            <span>{candidate.phone}</span>
          </div>
        )}
        {candidate.linkedin_url && (
          <div className="flex items-center gap-1.5">
            <Linkedin className="h-3 w-3 shrink-0" />
            <span className="truncate">{candidate.linkedin_url.replace(/^https?:\/\/(www\.)?linkedin\.com/, '')}</span>
          </div>
        )}
        {candidate.location_text && (
          <div className="flex items-center gap-1.5">
            <MapPin className="h-3 w-3 shrink-0" />
            <span className="truncate">{candidate.location_text}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function MergeCandidateDialog({
  open,
  onOpenChange,
  currentCandidate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentCandidate: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    current_title: string | null;
    current_company: string | null;
  };
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CandidateResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<CandidateResult | null>(null);
  const [survivorChoice, setSurvivorChoice] = useState<'current' | 'other'>('current');
  const [merging, setMerging] = useState(false);
  const [step, setStep] = useState<'search' | 'confirm'>('search');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const currentName = `${currentCandidate.first_name || ''} ${currentCandidate.last_name || ''}`.trim() || 'Unknown';

  const handleSearch = useCallback(async (searchQuery: string) => {
    if (searchQuery.trim().length < 2) {
      setResults([]);
      return;
    }

    setSearching(true);
    try {
      const q = searchQuery.trim();
      const { data, error } = await supabase
        .from('people')
        .select('id, first_name, last_name, email, phone, linkedin_url, current_title, current_company, location_text, status, created_at')
        .neq('id', currentCandidate.id)
        .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%,current_company.ilike.%${q}%,linkedin_url.ilike.%${q}%`)
        .order('updated_at', { ascending: false })
        .limit(20);

      if (error) throw error;
      setResults((data as CandidateResult[]) || []);
    } catch (err: any) {
      toast.error('Search failed: ' + err.message);
    } finally {
      setSearching(false);
    }
  }, [currentCandidate.id]);

  const handleInputChange = (value: string) => {
    setQuery(value);
    setSelected(null);
    setStep('search');
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => handleSearch(value), 300);
  };

  const handleSelectCandidate = (candidate: CandidateResult) => {
    setSelected(candidate);
    setStep('confirm');
    setSurvivorChoice('current');
  };

  const handleMerge = async () => {
    if (!selected) return;

    const survivorId = survivorChoice === 'current' ? currentCandidate.id : selected.id;
    const mergedId = survivorChoice === 'current' ? selected.id : currentCandidate.id;

    setMerging(true);
    try {
      const { data, error } = await supabase.rpc('merge_duplicate_candidate', {
        p_survivor_id: survivorId,
        p_merged_id: mergedId,
      });

      if (error) throw error;

      const result = data as any;
      const fieldsCount = result?.fields_filled?.length || 0;
      toast.success(
        `Merged successfully${fieldsCount > 0 ? ` — ${fieldsCount} field${fieldsCount > 1 ? 's' : ''} filled from duplicate` : ''}`
      );

      queryClient.invalidateQueries({ queryKey: ['candidates'] });
      queryClient.invalidateQueries({ queryKey: ['candidate', survivorId] });
      onOpenChange(false);

      // If the current candidate was merged away, navigate to the survivor
      if (mergedId === currentCandidate.id) {
        navigate(`/candidates/${survivorId}`);
      }
    } catch (err: any) {
      toast.error('Merge failed: ' + err.message);
    } finally {
      setMerging(false);
    }
  };

  const handleClose = (open: boolean) => {
    if (!open) {
      setQuery('');
      setResults([]);
      setSelected(null);
      setStep('search');
      setMerging(false);
    }
    onOpenChange(open);
  };

  const selectedName = selected
    ? `${selected.first_name || ''} ${selected.last_name || ''}`.trim() || 'Unknown'
    : '';

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Merge className="h-5 w-5" />
            Merge Candidate
          </DialogTitle>
          <DialogDescription>
            Search for a duplicate of <span className="font-medium text-foreground">{currentName}</span> and merge the two profiles. All related data will be consolidated into the survivor.
          </DialogDescription>
        </DialogHeader>

        {step === 'search' && (
          <>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name, email, phone, company, or LinkedIn..."
                value={query}
                onChange={(e) => handleInputChange(e.target.value)}
                className="pl-9"
                autoFocus
              />
              {searching && (
                <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
              )}
            </div>

            {results.length > 0 && (
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                {results.map((c) => (
                  <CandidateResultCard
                    key={c.id}
                    candidate={c}
                    isSelected={selected?.id === c.id}
                    onClick={() => handleSelectCandidate(c)}
                  />
                ))}
              </div>
            )}

            {query.trim().length >= 2 && !searching && results.length === 0 && (
              <p className="text-center text-sm text-muted-foreground py-6">No matching candidates found</p>
            )}
          </>
        )}

        {step === 'confirm' && selected && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Choose which profile to keep. The other will be merged into it, then deleted.
            </p>

            <div className="space-y-2">
              <div
                onClick={() => setSurvivorChoice('current')}
                className={cn(
                  'rounded-lg border p-3 cursor-pointer transition-all',
                  survivorChoice === 'current'
                    ? 'border-primary bg-primary/5 ring-2 ring-primary/30'
                    : 'border-border hover:border-primary/50'
                )}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium text-sm">{currentName}</span>
                    {currentCandidate.current_title && (
                      <span className="text-xs text-muted-foreground ml-2">{currentCandidate.current_title}</span>
                    )}
                  </div>
                  {survivorChoice === 'current' && (
                    <Badge className="bg-primary/20 text-primary text-xs">Keep</Badge>
                  )}
                </div>
                {currentCandidate.email && (
                  <p className="text-xs text-muted-foreground mt-1">{currentCandidate.email}</p>
                )}
              </div>

              <div className="flex items-center justify-center">
                <ArrowRight className="h-4 w-4 text-muted-foreground rotate-90" />
              </div>

              <div
                onClick={() => setSurvivorChoice('other')}
                className={cn(
                  'rounded-lg border p-3 cursor-pointer transition-all',
                  survivorChoice === 'other'
                    ? 'border-primary bg-primary/5 ring-2 ring-primary/30'
                    : 'border-border hover:border-primary/50'
                )}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium text-sm">{selectedName}</span>
                    {selected.current_title && (
                      <span className="text-xs text-muted-foreground ml-2">{selected.current_title}</span>
                    )}
                  </div>
                  {survivorChoice === 'other' && (
                    <Badge className="bg-primary/20 text-primary text-xs">Keep</Badge>
                  )}
                </div>
                {selected.email && (
                  <p className="text-xs text-muted-foreground mt-1">{selected.email}</p>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-border">
              <Button variant="ghost" size="sm" onClick={() => setStep('search')}>
                Back to Search
              </Button>
              <Button
                variant="gold"
                disabled={merging}
                onClick={handleMerge}
              >
                {merging ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Merge className="h-4 w-4 mr-1" />
                )}
                Merge — Keep {survivorChoice === 'current' ? currentName : selectedName}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
