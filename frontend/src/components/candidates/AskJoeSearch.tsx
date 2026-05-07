import { useState, useRef, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, Send, Loader2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { authHeaders } from '@/lib/api-auth';

type Msg = { role: 'user' | 'assistant'; content: string };

const BACKEND_URL = import.meta.env.REACT_APP_BACKEND_URL || '';
const CHAT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ask-joe`;

type SearchMode = 'candidate_search' | 'contact_search' | 'resume_search';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AskJoeSearch({ open, onOpenChange }: Props) {
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [mode, setMode] = useState<SearchMode>('candidate_search');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (!open) {
      setMessages([]);
      setQuery('');
      setMode('candidate_search');
    }
  }, [open]);

  const handleSearch = async () => {
    if (!query.trim() || isLoading) return;

    const userMsg: Msg = { role: 'user', content: query };
    const allMessages = [...messages, userMsg];
    setMessages(allMessages);
    setQuery('');
    setIsLoading(true);

    let assistantSoFar = '';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45_000);

    try {
      let resp: Response;

      if (mode === 'resume_search') {
        // Use our backend with Claude
        resp = await fetch(`${BACKEND_URL}/api/resume-search-ai`, {
          method: 'POST',
          headers: await authHeaders(),
          body: JSON.stringify({
            query: query,
            messages: allMessages.map((m) => ({ role: m.role, content: m.content })),
            session_id: `askjoe-${Date.now()}`,
          }),
          signal: controller.signal,
        });
      } else {
        // Try Supabase edge function for candidate/contact search
        resp = await fetch(CHAT_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({
            messages: allMessages.map((m) => ({ role: m.role, content: m.content })),
            mode: mode,
          }),
          signal: controller.signal,
        });
      }

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
      const aborted = err?.name === 'AbortError';
      const msg = aborted ? 'Joe timed out. Please try again.' : (err?.message || 'Joe had a problem. Please try again.');
      toast.error(msg);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${msg}` },
      ]);
    } finally {
      clearTimeout(timeoutId);
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSearch();
    }
  };

  const getTitle = () => {
    switch (mode) {
      case 'candidate_search': return 'Ask Joe — Candidate Search';
      case 'contact_search': return 'Ask Joe — Contact Search';
      case 'resume_search': return 'Ask Joe — Resume Search';
      default: return 'Ask Joe — Search';
    }
  };

  const getDescription = () => {
    switch (mode) {
      case 'candidate_search':
        return 'Search candidates by company, title, skills, and background using natural language. Try: "Find all Python developers who worked at FAANG companies"';
      case 'contact_search':
        return 'Search contacts by company, title, and role using natural language. Try: "Show me all HR directors from tech companies in California"';
      case 'resume_search':
        return 'Search through uploaded resumes using natural language. Try: "Find candidates with React experience and AWS skills"';
      default: return '';
    }
  };

  const getPlaceholder = () => {
    switch (mode) {
      case 'candidate_search': return 'Search candidates by company, title, skills...';
      case 'contact_search': return 'Search contacts by company, title, role...';
      case 'resume_search': return 'Search resumes by skills, experience, keywords...';
      default: return 'Ask Joe a question...';
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-accent" />
            {getTitle()}
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm text-muted-foreground">Search type:</span>
          <Select value={mode} onValueChange={(value: SearchMode) => setMode(value)}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="candidate_search">Candidates</SelectItem>
              <SelectItem value="contact_search">Contacts</SelectItem>
              <SelectItem value="resume_search">Resumes</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <p className="text-sm text-muted-foreground">
          {getDescription()}
        </p>

        <div ref={scrollRef} className="flex-1 min-h-[200px] max-h-[400px] overflow-y-auto space-y-3 py-2">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 py-8">
              <Search className="h-8 w-8 opacity-40" />
              <p className="text-sm">Ask Joe to search your data</p>
              <p className="text-xs opacity-60 text-center">
                Choose a search type above and ask natural language questions
              </p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div className={cn(
                'max-w-[90%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap',
                msg.role === 'user' ? 'bg-accent text-accent-foreground' : 'bg-muted text-foreground'
              )}>
                {msg.content}
              </div>
            </div>
          ))}
          {isLoading && messages[messages.length - 1]?.role === 'user' && (
            <div className="flex justify-start">
              <div className="bg-muted rounded-lg px-3 py-2">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-border pt-3">
          <div className="flex items-center gap-2">
            <Input
              placeholder={getPlaceholder()}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isLoading}
              className="flex-1"
            />
            <Button
              size="sm"
              onClick={handleSearch}
              disabled={isLoading || !query.trim()}
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}