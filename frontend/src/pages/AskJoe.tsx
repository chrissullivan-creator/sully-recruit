import { useEffect, useRef, useState } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Martini, Send, Loader2, Sparkles, Trash2, UserCheck, Users } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';

type Mode = 'candidate_search' | 'contact_search';
type Role = 'user' | 'assistant';
interface Msg { role: Role; content: string }

const CHAT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ask-joe`;
const STORAGE_KEY = 'ask-joe-chat';

function loadChat(): { mode: Mode; messages: Msg[] } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { mode: 'candidate_search', messages: [] };
    return JSON.parse(raw);
  } catch {
    return { mode: 'candidate_search', messages: [] };
  }
}

function saveChat(mode: Mode, messages: Msg[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode, messages }));
  } catch { /* quota / private mode */ }
}

const SUGGESTIONS = [
  'Senior PMs in fintech who left their last role 6+ months ago',
  'Hedge fund quants based in NYC with Python and C++',
  'CFOs at PE-backed SaaS companies under $100M ARR',
  'Engineering managers I haven’t reached out to in 90 days',
];

export default function AskJoe() {
  const [mode, setMode] = useState<Mode>(() => loadChat().mode);
  const [messages, setMessages] = useState<Msg[]>(() => loadChat().messages);
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Persist
  useEffect(() => { saveChat(mode, messages); }, [mode, messages]);

  // Auto-scroll on new content.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, isLoading]);

  const ask = async (text: string) => {
    if (!text.trim() || isLoading) return;
    const userMsg: Msg = { role: 'user', content: text };
    const all = [...messages, userMsg];
    setMessages(all);
    setQuery('');
    setIsLoading(true);

    let assistantSoFar = '';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      const resp = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          messages: all.map((m) => ({ role: m.role, content: m.content })),
          mode,
        }),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        const err = await resp.json().catch(() => null);
        throw new Error(err?.error || `Request failed (${resp.status})`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let done = false;

      while (!done) {
        const { done: readDone, value } = await reader.read();
        if (readDone) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          let line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (line.startsWith(':') || line.trim() === '' || !line.startsWith('data: ')) continue;
          const json = line.slice(6).trim();
          if (json === '[DONE]') { done = true; break; }
          try {
            const parsed = JSON.parse(json);
            // Handle both Claude shape ({content:'...'}) and OpenAI shape ({choices:[{delta:{content:'...'}}]}).
            const content = parsed.content ?? parsed.choices?.[0]?.delta?.content;
            if (typeof content === 'string') {
              assistantSoFar += content;
              const current = assistantSoFar;
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant' && prev.length > all.length) {
                  return prev.map((m, i) => (i === prev.length - 1 ? { ...m, content: current } : m));
                }
                return [...prev, { role: 'assistant', content: current }];
              });
            }
          } catch {
            // Partial JSON: push it back on the buffer and break out of the inner loop.
            buf = line + '\n' + buf;
            break;
          }
        }
      }
    } catch (err: any) {
      const aborted = err?.name === 'AbortError';
      const msg = aborted ? 'Joe timed out. Please try again.' : (err?.message || 'Joe had a problem. Try again.');
      toast.error(msg);
      setMessages((prev) => [...prev, { role: 'assistant', content: `Error: ${msg}` }]);
    } finally {
      clearTimeout(timeout);
      setIsLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleClear = () => {
    setMessages([]);
    setQuery('');
    inputRef.current?.focus();
  };

  return (
    <MainLayout>
      <PageHeader
        title="Ask Joe"
        description="Natural-language search across people. Ask, refine, follow up."
        actions={
          <div className="flex items-center gap-2">
            {messages.length > 0 && (
              <Button variant="outline" size="sm" onClick={handleClear} className="gap-1.5">
                <Trash2 className="h-3.5 w-3.5" /> Clear
              </Button>
            )}
          </div>
        }
      />

      <div className="bg-page-bg min-h-[calc(100vh-4rem)] flex flex-col">
        {/* Mode toggle */}
        <div className="px-6 lg:px-8 py-3 border-b border-card-border bg-white">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Search</span>
            <button
              onClick={() => setMode('candidate_search')}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-colors',
                mode === 'candidate_search'
                  ? 'bg-emerald text-white border-emerald'
                  : 'bg-white text-muted-foreground border-card-border hover:border-emerald',
              )}
            >
              <UserCheck className="h-3 w-3" /> Candidates
            </button>
            <button
              onClick={() => setMode('contact_search')}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-colors',
                mode === 'contact_search'
                  ? 'bg-gold text-white border-gold'
                  : 'bg-white text-muted-foreground border-card-border hover:border-gold',
              )}
            >
              <Users className="h-3 w-3" /> Contacts
            </button>
          </div>
        </div>

        {/* Conversation */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-6 lg:px-8 py-6">
          {messages.length === 0 ? (
            <div className="max-w-2xl mx-auto text-center py-10 space-y-6">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gold/10 border border-gold/20 mx-auto">
                <Martini className="h-7 w-7 text-gold-deep" />
              </div>
              <div>
                <h2 className="text-2xl font-bold font-display text-emerald-dark">What can Joe find for you?</h2>
                <p className="text-sm text-muted-foreground mt-2">
                  Joe searches your {mode === 'candidate_search' ? 'candidates' : 'contacts'} using natural language.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-left">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => ask(s)}
                    className="rounded-lg border border-card-border bg-white px-3 py-2 text-xs text-foreground hover:border-emerald/40 hover:bg-emerald-light/30 transition-colors"
                  >
                    <Sparkles className="inline h-3 w-3 text-gold-deep mr-1.5" />
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-3">
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={cn(
                    'flex',
                    m.role === 'user' ? 'justify-end' : 'justify-start',
                  )}
                >
                  <div className={cn(
                    'max-w-[85%] sm:max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap',
                    m.role === 'user'
                      ? 'bg-emerald text-white rounded-br-md'
                      : 'bg-white border border-card-border text-foreground rounded-bl-md',
                  )}>
                    {m.content || (isLoading && i === messages.length - 1 ? '…' : '')}
                  </div>
                </div>
              ))}
              {isLoading && messages[messages.length - 1]?.role === 'user' && (
                <div className="flex justify-start">
                  <div className="bg-white border border-card-border rounded-2xl rounded-bl-md px-4 py-2.5 text-sm text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin inline mr-2" /> Joe is thinking…
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Input */}
        <div className="border-t border-card-border bg-white px-4 sm:px-6 lg:px-8 py-3">
          <div className="max-w-3xl mx-auto flex items-center gap-2">
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(query); } }}
              placeholder={mode === 'candidate_search' ? 'Ask about your candidates…' : 'Ask about your contacts…'}
              disabled={isLoading}
              className="flex-1 h-10 border-card-border bg-page-bg/50"
            />
            <Button
              onClick={() => ask(query)}
              disabled={!query.trim() || isLoading}
              variant="gold"
              size="sm"
              className="h-10 gap-1.5"
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Ask Joe
            </Button>
          </div>
        </div>
      </div>
    </MainLayout>
  );
}
