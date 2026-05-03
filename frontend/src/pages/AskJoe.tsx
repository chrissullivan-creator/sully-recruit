import { useState } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { AskJoeAdvancedSearch } from '@/components/candidates/AskJoeAdvancedSearch';
import { Sparkles, UserCheck, Users } from 'lucide-react';

// Placeholder Ask Joe landing page. Lets the user pick a search mode and opens
// the existing AskJoeAdvancedSearch dialog. Will be replaced when the universal
// search UI lands.
export default function AskJoe() {
  const [mode, setMode] = useState<'candidate_search' | 'contact_search' | null>(null);

  return (
    <MainLayout>
      <PageHeader
        title="Ask Joe"
        description="Natural-language search across candidates and contacts."
      />
      <div className="p-8 max-w-2xl mx-auto">
        <div className="rounded-2xl border border-border bg-card p-8 text-center space-y-6">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gold/10 border border-gold/20 mx-auto">
            <Sparkles className="h-7 w-7 text-gold" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">What are you looking for?</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Pick a scope. Joe will search using your natural-language query.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Button variant="outline" className="h-20 flex-col gap-1.5" onClick={() => setMode('candidate_search')}>
              <UserCheck className="h-5 w-5 text-success" />
              <span className="text-sm font-medium">Search Candidates</span>
            </Button>
            <Button variant="outline" className="h-20 flex-col gap-1.5" onClick={() => setMode('contact_search')}>
              <Users className="h-5 w-5 text-info" />
              <span className="text-sm font-medium">Search Contacts</span>
            </Button>
          </div>
        </div>
      </div>

      <AskJoeAdvancedSearch
        open={mode !== null}
        onOpenChange={(v) => { if (!v) setMode(null); }}
        mode={mode ?? 'candidate_search'}
      />
    </MainLayout>
  );
}
