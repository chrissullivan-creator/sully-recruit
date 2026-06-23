import type { Dispatch, SetStateAction } from 'react';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Loader2, Target } from 'lucide-react';

interface JobSpecSectionProps {
  jobSpecText: string;
  setJobSpecText: Dispatch<SetStateAction<string>>;
  jobSpecTranslating: boolean;
  translateJobSpec: (save: boolean) => void;
  jobSpecLastTranslated: string | null;
  jobSpecFilters: any;
  jobSpecLoaded: boolean;
}

export function JobSpecSection({
  jobSpecText,
  setJobSpecText,
  jobSpecTranslating,
  translateJobSpec,
  jobSpecLastTranslated,
  jobSpecFilters,
  jobSpecLoaded,
}: JobSpecSectionProps) {
  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-foreground mb-1">Lead search filter</h2>
        <p className="text-sm text-muted-foreground">
          Describe the kinds of jobs the firm cares about in plain English. We translate it to a structured PDL filter that's applied to every bulk "Fetch postings" run — so you don't pull every JP Morgan job, only the ones worth pursuing.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div>
          <Label className="text-xs">Spec (free text)</Label>
          <Textarea
            value={jobSpecText}
            onChange={(e) => setJobSpecText(e.target.value)}
            rows={6}
            placeholder="e.g. Senior software engineering leaders in financial services (NYC, San Francisco, or remote). Director level or above. Full-time, $200k base minimum. No interns or contract roles."
            className="mt-1 text-sm font-mono"
          />
          <p className="text-[11px] text-muted-foreground mt-1">
            Tip: be specific about seniority, location, and what to exclude. Vague specs translate to vague filters.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={jobSpecTranslating || !jobSpecText.trim()}
            onClick={() => translateJobSpec(false)}
          >
            {jobSpecTranslating ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Target className="h-3.5 w-3.5 mr-1.5" />}
            Preview filter
          </Button>
          <Button
            size="sm"
            variant="gold"
            disabled={jobSpecTranslating}
            onClick={() => translateJobSpec(true)}
          >
            {jobSpecTranslating && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Translate & save
          </Button>
          {jobSpecLastTranslated && (
            <span className="text-[11px] text-muted-foreground ml-2">
              Saved {new Date(jobSpecLastTranslated).toLocaleString()}
            </span>
          )}
        </div>

        {Object.keys(jobSpecFilters ?? {}).length > 0 && (
          <div className="pt-3 border-t border-border">
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs">Active PDL filter</Label>
              <span className="text-[10px] text-muted-foreground">
                This is what we send to PDL on each fetch
              </span>
            </div>
            <pre className="bg-muted rounded p-3 text-[11px] font-mono whitespace-pre-wrap break-all max-h-64 overflow-y-auto">
              {JSON.stringify(jobSpecFilters, null, 2)}
            </pre>
          </div>
        )}

        {Object.keys(jobSpecFilters ?? {}).length === 0 && jobSpecLoaded && (
          <div className="text-[11px] text-muted-foreground italic">
            No filter active — every fetch pulls every posting PDL has for the company.
          </div>
        )}
      </div>
    </div>
  );
}
