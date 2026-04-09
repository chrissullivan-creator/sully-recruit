import { useState, useMemo, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, Search, MapPin, Briefcase, Award, Building, ArrowRight, Sparkles, Send, FileText, MessageSquare } from 'lucide-react';
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

type ChatMsg = { role: 'user' | 'assistant'; content: string };

const BACKEND_URL = import.meta.env.REACT_APP_BACKEND_URL || '';

const visaOptions = [
  'Citizen', 'Green Card', 'H1-B', 'L1', 'O1', 'TN', 'Sponsorship Required', 'Visa Verified',
];

const yearsExperienceOptions = [
  { label: '0-2 years', value: '0-2' },
  { label: '2-5 years', value: '2-5' },
  { label: '5-10 years', value: '5-10' },
  { label: '10+ years', value: '10+' },
];

// ---------- Ask Joe Resume Chat ----------
function AskJoeResumeChat() {
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [sessionId] = useState(() => `resume-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    if (!query.trim() || isLoading) return;

    const userMsg: ChatMsg = { role: 'user', content: query };
    const allMessages = [...messages, userMsg];
    setMessages(allMessages);
    setQuery('');
    setIsLoading(true);

    let assistantSoFar = '';

    try {
      const resp = await fetch(`${BACKEND_URL}/api/resume-search-ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: userMsg.content,
          messages: allMessages.map((m) => ({ role: m.role, content: m.content })),
          session_id: sessionId,
        }),
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }

      const reader = resp.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let textBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        textBuffer += decoder.decode(value, { stream: true });
        const lines = textBuffer.split('\n');
        textBuffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.content) {
                assistantSoFar += data.content;
                setMessages((prev) => {
                  const newMsgs = [...prev];
                  const lastMsg = newMsgs[newMsgs.length - 1];
                  if (lastMsg?.role === 'assistant') {
                    lastMsg.content = assistantSoFar;
                  } else {
                    newMsgs.push({ role: 'assistant', content: assistantSoFar });
                  }
                  return newMsgs;
                });
              }
            } catch {
              textBuffer = line + '\n' + textBuffer;
              break;
            }
          }
        }
      }
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${err.message}` },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const suggestions = [
    'Find candidates with React and TypeScript experience',
    'Who has AWS and cloud architecture skills?',
    'Show me senior engineers with Python backgrounds',
    'Find people with machine learning experience from FAANG',
  ];

  return (
    <div className="flex flex-col h-[calc(100vh-16rem)]">
      {/* Chat Area */}
      <ScrollArea className="flex-1 mb-4">
        <div ref={scrollRef} className="space-y-4 pr-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-4">
              <div className="h-16 w-16 rounded-full bg-accent/10 flex items-center justify-center">
                <Sparkles className="h-8 w-8 text-accent" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-foreground mb-1">Ask Joe to search resumes</p>
                <p className="text-xs opacity-70 max-w-md">
                  Ask natural language questions about candidate resumes. Joe will search through uploaded resumes and give you detailed results.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 justify-center max-w-lg">
                {suggestions.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => { setQuery(s); }}
                    className="text-xs px-3 py-1.5 rounded-full border border-border bg-background text-muted-foreground hover:border-accent/50 hover:text-foreground transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={cn('flex gap-3', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
              {msg.role === 'assistant' && (
                <div className="h-7 w-7 rounded-full bg-accent/10 flex items-center justify-center shrink-0 mt-1">
                  <Sparkles className="h-3.5 w-3.5 text-accent" />
                </div>
              )}
              <div className={cn(
                'max-w-[80%] rounded-2xl px-4 py-3',
                msg.role === 'user'
                  ? 'bg-accent text-accent-foreground rounded-tr-sm'
                  : 'bg-muted rounded-tl-sm'
              )}>
                <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.content}</p>
              </div>
            </div>
          ))}
          {isLoading && messages[messages.length - 1]?.role === 'user' && (
            <div className="flex gap-3 justify-start">
              <div className="h-7 w-7 rounded-full bg-accent/10 flex items-center justify-center shrink-0 mt-1">
                <Sparkles className="h-3.5 w-3.5 text-accent" />
              </div>
              <div className="bg-muted rounded-2xl rounded-tl-sm px-4 py-3">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span className="text-xs">Searching resumes...</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="border-t border-border pt-4">
        <div className="flex items-center gap-2">
          <Input
            placeholder="Ask Joe about resumes... e.g., 'Find candidates with 5+ years of Java experience'"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
            className="flex-1 h-10"
          />
          <Button onClick={handleSend} disabled={isLoading || !query.trim()} className="h-10 px-4">
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        {messages.length > 0 && (
          <button
            onClick={() => setMessages([])}
            className="text-[10px] text-muted-foreground hover:text-foreground mt-2 transition-colors"
          >
            Clear conversation
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- Keyword Search ----------
function KeywordSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 25;

  const [location, setLocation] = useState('');
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [visa, setVisa] = useState('');
  const [yearsExp, setYearsExp] = useState('');

  // Filter, sort by confidence desc, then paginate
  const filteredResults = useMemo(() => {
    return results
      .filter((result) => {
        if (location && !result.location?.toLowerCase().includes(location.toLowerCase())) return false;
        if (title && !result.title?.toLowerCase().includes(title.toLowerCase())) return false;
        if (company && !result.company?.toLowerCase().includes(company.toLowerCase())) return false;
        return true;
      })
      .sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0));
  }, [results, location, title, company]);

  const totalPages = Math.max(1, Math.ceil(filteredResults.length / PAGE_SIZE));
  const paginatedResults = filteredResults.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Reset page when filters change
  const updateFilter = (setter: (v: string) => void, value: string) => {
    setter(value);
    setPage(1);
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) {
      toast.error('Please enter a search query');
      return;
    }

    setSearching(true);
    setHasSearched(true);
    setPage(1);

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/search-resumes`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({ query, limit: 200, max_results: 200 }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to search resumes');
      }

      const data = await response.json();
      const sorted = (data.results || []).sort(
        (a: SearchResult, b: SearchResult) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0)
      );
      setResults(sorted);

      if (sorted.length === 0) {
        toast.info('No resumes matched your search');
      } else {
        toast.success(`Found ${sorted.length} matching resume${sorted.length !== 1 ? 's' : ''}`);
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
    <div>
      <form onSubmit={handleSearch} className="mb-6">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search resumes... e.g., 'React developers with 5+ years'"
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

      {hasSearched && (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3 mb-6">
          <Input placeholder="Filter by location..." value={location} onChange={(e) => updateFilter(setLocation, e.target.value)} className="text-sm" />
          <Input placeholder="Filter by title..." value={title} onChange={(e) => updateFilter(setTitle, e.target.value)} className="text-sm" />
          <Input placeholder="Filter by company..." value={company} onChange={(e) => updateFilter(setCompany, e.target.value)} className="text-sm" />
          <Select value={visa} onValueChange={(v) => updateFilter(setVisa, v)}>
            <SelectTrigger><SelectValue placeholder="Visa status..." /></SelectTrigger>
            <SelectContent>
              {visaOptions.map((option) => (<SelectItem key={option} value={option}>{option}</SelectItem>))}
            </SelectContent>
          </Select>
          <Select value={yearsExp} onValueChange={(v) => updateFilter(setYearsExp, v)}>
            <SelectTrigger><SelectValue placeholder="Years experience..." /></SelectTrigger>
            <SelectContent>
              {yearsExperienceOptions.map((option) => (<SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>))}
            </SelectContent>
          </Select>
        </div>
      )}

      {hasSearched && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-muted-foreground">
              {filteredResults.length} result{filteredResults.length !== 1 ? 's' : ''} found
              {filteredResults.length > PAGE_SIZE && (
                <span> · Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filteredResults.length)}</span>
              )}
              <span className="ml-2 text-xs opacity-70">Sorted by confidence</span>
            </p>
          </div>

          {paginatedResults.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-muted-foreground">
                  {results.length === 0 ? 'No resumes matched your search' : 'No results match your filters'}
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="space-y-3">
                {paginatedResults.map((result, idx) => {
                  const rank = (page - 1) * PAGE_SIZE + idx + 1;
                  return (
                    <Card key={result.id} className="hover:border-accent/50 transition-colors cursor-pointer">
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex items-start gap-3">
                            <span className="text-xs font-bold text-muted-foreground bg-muted rounded-full h-6 w-6 flex items-center justify-center shrink-0 mt-0.5">
                              {rank}
                            </span>
                            <div>
                              <h3 className="font-semibold text-foreground">{result.full_name}</h3>
                              <p className="text-sm text-muted-foreground">
                                {result.title && result.company
                                  ? `${result.title} at ${result.company}`
                                  : result.title || result.company || 'No title'}
                              </p>
                            </div>
                          </div>
                          <Badge
                            variant="secondary"
                            className={cn(
                              'text-sm font-semibold shrink-0',
                              result.relevance_score >= 0.8 ? 'bg-success/10 text-success' :
                              result.relevance_score >= 0.6 ? 'bg-accent/10 text-accent' :
                              result.relevance_score >= 0.4 ? 'bg-warning/10 text-warning' :
                              'bg-muted text-muted-foreground'
                            )}
                          >
                            {Math.round(result.relevance_score * 100)}% Match
                          </Badge>
                        </div>

                        <div className="flex flex-wrap gap-3 mb-3 text-xs text-muted-foreground">
                          {result.location && (
                            <div className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{result.location}</div>
                          )}
                          {result.title && (
                            <div className="flex items-center gap-1"><Briefcase className="h-3.5 w-3.5" />{result.title}</div>
                          )}
                          {result.company && (
                            <div className="flex items-center gap-1"><Building className="h-3.5 w-3.5" />{result.company}</div>
                          )}
                        </div>

                        {result.skills && result.skills.length > 0 && (
                          <div className="mb-3">
                            <div className="flex flex-wrap gap-1.5">
                              {result.skills.slice(0, 8).map((skill, idx) => (
                                <Badge key={idx} variant="outline" className="text-xs">{skill}</Badge>
                              ))}
                              {result.skills.length > 8 && (
                                <Badge variant="outline" className="text-xs">+{result.skills.length - 8}</Badge>
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

                        <Button variant="outline" size="sm" onClick={() => navigate(`/candidates/${result.id}`)} className="w-full">
                          Open Profile <ArrowRight className="h-3.5 w-3.5 ml-1" />
                        </Button>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-6 pt-4 border-t border-border">
                  <p className="text-xs text-muted-foreground">
                    Page {page} of {totalPages} · {filteredResults.length} total results
                  </p>
                  <div className="flex items-center gap-1">
                    <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(1)}>First</Button>
                    <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
                    <span className="text-xs text-muted-foreground px-3">{page} / {totalPages}</span>
                    <Button variant="outline" size="sm" disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
                    <Button variant="outline" size="sm" disabled={page === totalPages} onClick={() => setPage(totalPages)}>Last</Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {!hasSearched && (
        <Card className="max-w-xl mx-auto">
          <CardContent className="py-12 text-center">
            <Search className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-50" />
            <p className="text-muted-foreground">Enter a search query above to find candidates by resume keywords</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------- Main Page ----------
export const ResumeSearch = () => {
  return (
    <MainLayout>
      <PageHeader
        title="Resume Search"
        description="Find candidates by searching through uploaded resumes."
      />

      <div className="p-8">
        <Tabs defaultValue="ask-joe" className="w-full">
          <TabsList className="mb-6 bg-secondary">
            <TabsTrigger value="ask-joe" className="gap-1.5">
              <Sparkles className="h-3.5 w-3.5" />
              Ask Joe
            </TabsTrigger>
            <TabsTrigger value="keyword" className="gap-1.5">
              <Search className="h-3.5 w-3.5" />
              Keyword Search
            </TabsTrigger>
          </TabsList>

          <TabsContent value="ask-joe" className="mt-0">
            <AskJoeResumeChat />
          </TabsContent>

          <TabsContent value="keyword" className="mt-0">
            <KeywordSearch />
          </TabsContent>
        </Tabs>
      </div>
    </MainLayout>
  );
};
