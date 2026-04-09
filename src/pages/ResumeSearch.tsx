import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Loader2, Search, MapPin, Briefcase, Award, Building, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface SearchResult {
  id: string;
  full_name: string;
  title: string;
  company: string;
  location: string;
  skills: string[];
  relevance_score: number;
  match_reasons: string[];
}

const visaOptions = [
  'Citizen',
  'Green Card',
  'H1-B',
  'L1',
  'O1',
  'TN',
  'Sponsorship Required',
  'Visa Verified',
];

const yearsExperienceOptions = [
  { label: '0-2 years', value: '0-2' },
  { label: '2-5 years', value: '2-5' },
  { label: '5-10 years', value: '5-10' },
  { label: '10+ years', value: '10+' },
];

export const ResumeSearch = () => {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);

  // Filters
  const [location, setLocation] = useState('');
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [visa, setVisa] = useState('');
  const [yearsExp, setYearsExp] = useState('');

  const filteredResults = useMemo(() => {
    return results.filter((result) => {
      if (location && !result.location.toLowerCase().includes(location.toLowerCase())) return false;
      if (title && !result.title.toLowerCase().includes(title.toLowerCase())) return false;
      if (company && !result.company.toLowerCase().includes(company.toLowerCase())) return false;
      return true;
    });
  }, [results, location, title, company]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) {
      toast.error('Please enter a search query');
      return;
    }

    setSearching(true);
    setHasSearched(true);

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/search-resumes`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({ query }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to search resumes');
      }

      const data = await response.json();
      setResults(data.results || []);

      if (data.results?.length === 0) {
        toast.info('No resumes matched your search');
      } else {
        toast.success(`Found ${data.results.length} matching resumes`);
      }
    } catch (err: any) {
      console.error('Search error:', err);
      toast.error(err.message || 'Failed to search resumes');
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Resume Search"
        description="Find candidates by searching resumes with natural language queries."
      />

      <div className="p-8">
        {/* Search Bar */}
        <form onSubmit={handleSearch} className="mb-8">
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search resumes... e.g., 'React developers with 5+ years'..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-10 h-12 text-base"
              disabled={searching}
            />
            <Button
              type="submit"
              disabled={searching || !query.trim()}
              className="absolute right-1 top-1/2 -translate-y-1/2"
            >
              {searching && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {searching ? 'Searching...' : 'Search'}
            </Button>
          </div>
        </form>

        {/* Filters */}
        {hasSearched && (
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3 mb-8">
            <Input
              placeholder="Filter by location..."
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="text-sm"
            />
            <Input
              placeholder="Filter by title..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="text-sm"
            />
            <Input
              placeholder="Filter by company..."
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              className="text-sm"
            />
            <Select value={visa} onValueChange={setVisa}>
              <SelectTrigger>
                <SelectValue placeholder="Visa status..." />
              </SelectTrigger>
              <SelectContent>
                {visaOptions.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={yearsExp} onValueChange={setYearsExp}>
              <SelectTrigger>
                <SelectValue placeholder="Years experience..." />
              </SelectTrigger>
              <SelectContent>
                {yearsExperienceOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Results */}
        {hasSearched && (
          <div>
            <div className="mb-4">
              <p className="text-sm text-muted-foreground">
                {filteredResults.length} result{filteredResults.length !== 1 ? 's' : ''} found
              </p>
            </div>

            {filteredResults.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <p className="text-muted-foreground">
                    {results.length === 0
                      ? 'No resumes matched your search'
                      : 'No results match your filters'}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {filteredResults.map((result) => (
                  <Card
                    key={result.id}
                    className="hover:border-accent/50 transition-colors cursor-pointer"
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <h3 className="font-semibold text-foreground">{result.full_name}</h3>
                          <p className="text-sm text-muted-foreground">
                            {result.title && result.company
                              ? `${result.title} at ${result.company}`
                              : result.title || result.company || 'No title'}
                          </p>
                        </div>
                        <div className="text-right">
                          <Badge variant="secondary" className="text-base">
                            {Math.round(result.relevance_score * 100)}% Match
                          </Badge>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-3 mb-3 text-xs text-muted-foreground">
                        {result.location && (
                          <div className="flex items-center gap-1">
                            <MapPin className="h-3.5 w-3.5" />
                            {result.location}
                          </div>
                        )}
                        {result.title && (
                          <div className="flex items-center gap-1">
                            <Briefcase className="h-3.5 w-3.5" />
                            {result.title}
                          </div>
                        )}
                        {result.company && (
                          <div className="flex items-center gap-1">
                            <Building className="h-3.5 w-3.5" />
                            {result.company}
                          </div>
                        )}
                      </div>

                      {result.skills && result.skills.length > 0 && (
                        <div className="mb-3">
                          <div className="flex flex-wrap gap-1.5">
                            {result.skills.slice(0, 5).map((skill, idx) => (
                              <Badge key={idx} variant="outline" className="text-xs">
                                {skill}
                              </Badge>
                            ))}
                            {result.skills.length > 5 && (
                              <Badge variant="outline" className="text-xs">
                                +{result.skills.length - 5}
                              </Badge>
                            )}
                          </div>
                        </div>
                      )}

                      {result.match_reasons && result.match_reasons.length > 0 && (
                        <div className="mb-3 p-2 bg-accent/5 rounded text-xs text-muted-foreground">
                          <p className="font-medium mb-1">Why this match:</p>
                          <ul className="space-y-0.5 list-disc list-inside">
                            {result.match_reasons.slice(0, 3).map((reason, idx) => (
                              <li key={idx}>{reason}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => navigate(`/candidates/${result.id}`)}
                        className="w-full"
                      >
                        Open Profile
                        <ArrowRight className="h-3.5 w-3.5 ml-1" />
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}

        {!hasSearched && (
          <Card className="max-w-xl mx-auto">
            <CardContent className="py-12 text-center">
              <Search className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-50" />
              <p className="text-muted-foreground">
                Enter a search query above to find candidates
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </MainLayout>
  );
};