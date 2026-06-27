import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, ArrowUp, Martini, Loader2, ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

type Msg = { role: 'user' | 'assistant'; content: string };

const CHAT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ask-joe`;

// The recruiter-flavored starter prompts shown before the first question.
const EXAMPLES = [
  'Who should I call today?',
  'Which candidates are underpaid?',
  'Find PMs who traded CLOs',
  'Summarize Acme Capital',
  'Draft a send-out',
];

const GREETING: Msg = {
  role: 'assistant',
  content: "Hey, I'm Joe. Ask me anything about your desk — your pipeline, who to call, comp gaps, a company, or draft outreach.",
};

/**
 * Premium, command-palette-style Ask Joe. Controlled via `open`; reachable
 * from the global top-bar launcher on every page. Streams from the ask-joe
 * edge function (same transport as the legacy bubble).
 */
export function AskJoePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([GREETING]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasConversation = messages.length > 1;

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const send = useCallback(async (text: string) => {
    if (!text.trim() || isLoading) return;
    const userMsg: Msg = { role: 'user', content: text };
    const allMessages = [...messages, userMsg];
    setMessages(allMessages);
    setMessage('');
    setIsLoading(true);

    let assistantSoFar = '';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45_000);

    try {
      const resp = await fetch(CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({ messages: allMessages.map((m) => ({ role: m.role, content: m.content })) }),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        const errData = await resp.json().catch(() => null);
        throw new Error(errData?.error || `Request failed (${resp.status})`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let textBuffer = '';
      let streamDone = false;
      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;
        textBuffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = textBuffer.indexOf('\n')) !== -1) {
          let line = textBuffer.slice(0, newlineIndex);
          textBuffer = textBuffer.slice(newlineIndex + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (line.startsWith(':') || line.trim() === '') continue;
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') { streamDone = true; break; }
          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content as string | undefined;
            if (content) {
              assistantSoFar += content;
              const current = assistantSoFar;
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant' && prev.length > allMessages.length) {
                  return prev.map((m, i) => (i === prev.length - 1 ? { ...m, content: current } : m));
                }
                return [...prev, { role: 'assistant', content: current }];
              });
            }
          } catch {
            textBuffer = line + '\n' + textBuffer;
            break;
          }
        }
      }
    } catch (err: any) {
      const aborted = err?.name === 'AbortError';
      const msg = aborted ? 'Joe timed out. Please try again.' : (err?.message || 'Joe had a problem. Please try again.');
      toast.error(msg);
      setMessages((prev) => [...prev, { role: 'assistant', content: `Sorry, something went wrong: ${msg}` }]);
    } finally {
      clearTimeout(timeoutId);
      setIsLoading(false);
    }
  }, [isLoading, messages]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-foreground/20 backdrop-blur-sm animate-fade-in" onClick={onClose} />

      {/* Palette */}
      <div className="relative z-10 w-full max-w-2xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl animate-fade-in">
        {/* Input row */}
        <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
          <Martini className="h-5 w-5 shrink-0 text-accent" />
          <input
            ref={inputRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(message); }}
            placeholder="What do you want to know?"
            disabled={isLoading}
            className="flex-1 bg-transparent text-base text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
          />
          {message.trim() && (
            <button onClick={() => send(message)} disabled={isLoading} className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50">
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Examples (before first question) */}
        {!hasConversation && (
          <div className="px-4 py-4">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Try asking</p>
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => send(ex)}
                  className="rounded-full border border-border bg-card px-3 py-1.5 text-sm text-foreground transition-all hover:-translate-y-0.5 hover:border-accent/40 hover:bg-accent/5 hover:shadow-sm"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Conversation */}
        {hasConversation && (
          <div ref={scrollRef} className="max-h-[42vh] space-y-4 overflow-y-auto p-4">
            {messages.slice(1).map((msg, i) => (
              <div key={i} className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className={cn(
                  'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm',
                  msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
                )}>
                  {msg.content}
                </div>
              </div>
            ))}
            {isLoading && messages[messages.length - 1]?.role === 'user' && (
              <div className="flex justify-start">
                <div className="rounded-2xl bg-muted px-3.5 py-2.5"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
          <span className="text-xs text-muted-foreground">Joe · AI assistant</span>
          <button
            onClick={() => { onClose(); navigate('/ask-joe'); }}
            className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            Open full Ask Joe <ArrowUpRight className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
