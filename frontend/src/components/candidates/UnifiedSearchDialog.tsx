import { useState, useRef, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Search, Send, Loader2, Sparkles, Globe, Users, FileText, MessageSquare, StickyNote } from 'lucide-react';
import { cn } from '@/lib/utils';

type Msg = { role: 'user' | 'assistant'; content: string };

const BACKEND_URL = import.meta.env.REACT_APP_BACKEND_URL || '';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const suggestions = [
  'Find everyone who has worked at Goldman Sachs',
  'Any candidates or notes mentioning Python and AWS?',
  'Show me all communication with john@example.com',
  'Who do we know at JP Morgan? Check candidates, contacts, and messages.',
  'Find candidates with React skills who we haven\'t reached out to',
];

export function UnifiedSearchDialog({ open, onOpenChange }: Props) {
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [sessionId] = useState(() => `unified-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

    try {
      const resp = await fetch(`${BACKEND_URL}/api/unified-search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: userMsg.content,
          messages: allMessages.map((m) => ({ role: m.role, content: m.content })),
          session_id: sessionId,
        }),
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);

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
              if (data.error) throw new Error(data.error);
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
            } catch (e: any) {
              if (e.message && !e.message.includes('JSON')) throw e;
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-6 pb-3">
          <DialogTitle className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10">
              <Globe className="h-4 w-4 text-accent" />
            </div>
            <div>
              <span>Search Everything</span>
              <p className="text-xs font-normal text-muted-foreground mt-0.5">
                Search across candidates, contacts, resumes, notes, and messages
              </p>
            </div>
          </DialogTitle>
          {/* Data source badges */}
          <div className="flex flex-wrap gap-1.5 mt-2">
            <Badge variant="secondary" className="text-[10px] gap-1">
              <Users className="h-2.5 w-2.5" /> Candidates
            </Badge>
            <Badge variant="secondary" className="text-[10px] gap-1">
              <Users className="h-2.5 w-2.5" /> Contacts
            </Badge>
            <Badge variant="secondary" className="text-[10px] gap-1">
              <FileText className="h-2.5 w-2.5" /> Resumes
            </Badge>
            <Badge variant="secondary" className="text-[10px] gap-1">
              <StickyNote className="h-2.5 w-2.5" /> Notes
            </Badge>
            <Badge variant="secondary" className="text-[10px] gap-1">
              <MessageSquare className="h-2.5 w-2.5" /> Messages
            </Badge>
          </div>
        </DialogHeader>

        {/* Chat area */}
        <ScrollArea className="flex-1 px-6">
          <div ref={scrollRef} className="space-y-4 pb-4">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-4">
                <div className="h-16 w-16 rounded-full bg-accent/10 flex items-center justify-center">
                  <Globe className="h-8 w-8 text-accent" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-medium text-foreground mb-1">Search across all your data</p>
                  <p className="text-xs opacity-70 max-w-md">
                    Joe will search candidates, contacts, resumes, notes, and message history to find what you need.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 justify-center max-w-lg">
                  {suggestions.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => setQuery(s)}
                      className="text-xs px-3 py-1.5 rounded-full border border-border bg-background text-muted-foreground hover:border-accent/50 hover:text-foreground transition-colors text-left"
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
                  'max-w-[85%] rounded-2xl px-4 py-3',
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
                    <span className="text-xs">Searching all data sources...</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Input */}
        <div className="border-t border-border px-6 py-4">
          <div className="flex items-center gap-2">
            <Input
              placeholder="Search across everything... candidates, contacts, resumes, notes, messages"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSearch(); } }}
              disabled={isLoading}
              className="flex-1 h-10"
            />
            <Button onClick={handleSearch} disabled={isLoading || !query.trim()} className="h-10 px-4">
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
      </DialogContent>
    </Dialog>
  );
}
