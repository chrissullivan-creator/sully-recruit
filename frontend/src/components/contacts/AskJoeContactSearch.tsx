import { useState, useRef, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Send, Loader2, Sparkles, Play, Building, Mail, Linkedin, UserCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface ContactResult {
  id: string;
  name: string;
  title: string;
  company: string;
  email: string | null;
  linkedin_url: string | null;
}

type Msg =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; contacts?: ContactResult[] };

const CHAT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ask-joe`;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnrollContacts?: (contactIds: string[]) => void;
}

export function AskJoeContactSearch({ open, onOpenChange, onEnrollContacts }: Props) {
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
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
      setSelectedIds([]);
    }
  }, [open]);

  const toggleContact = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const toggleAll = (contacts: ContactResult[]) => {
    const ids = contacts.map((c) => c.id);
    const allSelected = ids.every((id) => selectedIds.includes(id));
    if (allSelected) {
      setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
    } else {
      setSelectedIds((prev) => [...new Set([...prev, ...ids])]);
    }
  };

  const handleSearch = async () => {
    if (!query.trim() || isLoading) return;

    const userMsg: Msg = { role: 'user', content: query };
    const allMessages = [...messages, userMsg];
    setMessages(allMessages);
    setQuery('');
    setIsLoading(true);

    let assistantText = '';
    let foundContacts: ContactResult[] | undefined;
    const msgIndex = allMessages.length; // index of the upcoming assistant msg
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45_000);

    try {
      const resp = await fetch(CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({
          messages: allMessages
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({ role: m.role, content: m.content })),
          mode: 'contact_search',
        }),
        signal: controller.signal,
      });

      if (!resp.ok || !resp.body) {
        const errData = await resp.json().catch(() => null);
        throw new Error(errData?.error || `Request failed (${resp.status})`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          let line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
          buffer = buffer.slice(newlineIdx + 1);

          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;

          try {
            const parsed = JSON.parse(jsonStr);

            if (parsed.type === 'contacts_found') {
              foundContacts = parsed.contacts as ContactResult[];
              setMessages((prev) => {
                const next = [...prev];
                if (next[msgIndex]?.role === 'assistant') {
                  (next[msgIndex] as any).contacts = foundContacts;
                } else {
                  next.push({ role: 'assistant', content: assistantText, contacts: foundContacts });
                }
                return next;
              });
            } else if (parsed.type === 'text' || parsed.content) {
              // legacy fallback: parsed.content from old format
              const chunk: string = parsed.content ?? parsed.content ?? '';
              assistantText += chunk;
              setMessages((prev) => {
                const next = [...prev];
                if (next[msgIndex]?.role === 'assistant') {
                  next[msgIndex] = { ...next[msgIndex], content: assistantText } as Msg;
                } else {
                  next.push({ role: 'assistant', content: assistantText });
                }
                return next;
              });
            }
          } catch {
            // non-JSON line — skip
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

  const handleEnroll = () => {
    if (!onEnrollContacts || selectedIds.length === 0) return;
    onEnrollContacts(selectedIds);
    onOpenChange(false);
  };

  // Count total contacts across all result messages for "select all" context
  const allResultContacts: ContactResult[] = messages
    .filter((m): m is Extract<Msg, { role: 'assistant' }> => m.role === 'assistant' && !!(m as any).contacts)
    .flatMap((m) => (m as any).contacts as ContactResult[]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-0 p-0">
        {/* Header */}
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-accent" />
            Ask Joe — Search Candidates &amp; Contacts
          </DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Search contacts by company, title, and more using natural language. Try:{' '}
            <span className="italic">"Show me all contacts at PGIM or Prudential"</span>
          </p>
        </DialogHeader>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 min-h-[200px] max-h-[450px] overflow-y-auto space-y-4 px-5 py-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 py-10">
              <UserCheck className="h-9 w-9 opacity-30" />
              <p className="text-sm">Ask Joe to find contacts from your network</p>
              <p className="text-xs opacity-50 text-center">Filter by firm, title, or anything else</p>
            </div>
          )}

          {messages.map((msg, i) => {
            if (msg.role === 'user') {
              return (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm bg-accent text-accent-foreground">
                    {msg.content}
                  </div>
                </div>
              );
            }

            const contacts = (msg as any).contacts as ContactResult[] | undefined;

            return (
              <div key={i} className="flex justify-start flex-col gap-2 max-w-full">
                {/* Text portion */}
                {msg.content && (
                  <div className="max-w-[90%] rounded-lg px-3 py-2 text-sm bg-muted text-foreground whitespace-pre-wrap">
                    {msg.content}
                  </div>
                )}

                {/* Selectable contacts grid */}
                {contacts && contacts.length > 0 && (
                  <div className="rounded-lg border border-border overflow-hidden w-full">
                    {/* Toolbar */}
                    <div className="flex items-center justify-between px-3 py-2 bg-secondary/60 border-b border-border">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          checked={contacts.every((c) => selectedIds.includes(c.id))}
                          onCheckedChange={() => toggleAll(contacts)}
                        />
                        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          {contacts.length} contact{contacts.length !== 1 ? 's' : ''} found
                        </span>
                      </div>
                      {selectedIds.filter((id) => contacts.some((c) => c.id === id)).length > 0 && (
                        <Badge variant="secondary" className="text-xs">
                          {selectedIds.filter((id) => contacts.some((c) => c.id === id)).length} selected
                        </Badge>
                      )}
                    </div>

                    {/* Contact rows */}
                    <div className="divide-y divide-border max-h-64 overflow-y-auto">
                      {contacts.map((contact) => (
                        <label
                          key={contact.id}
                          className={cn(
                            'flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors hover:bg-muted/50',
                            selectedIds.includes(contact.id) && 'bg-accent/5'
                          )}
                        >
                          <Checkbox
                            checked={selectedIds.includes(contact.id)}
                            onCheckedChange={() => toggleContact(contact.id)}
                          />
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-medium text-accent">
                            {contact.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-foreground truncate">{contact.name}</p>
                            <p className="text-xs text-muted-foreground truncate">
                              {contact.title}
                              {contact.company !== '—' && ` · ${contact.company}`}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {contact.email && (
                              <span className="p-1 rounded text-muted-foreground/50">
                                <Mail className="h-3.5 w-3.5" />
                              </span>
                            )}
                            {contact.linkedin_url && (
                              <span className="p-1 rounded text-muted-foreground/50">
                                <Linkedin className="h-3.5 w-3.5" />
                              </span>
                            )}
                            <span className="text-xs text-muted-foreground/50">
                              <Building className="h-3.5 w-3.5" />
                            </span>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {isLoading && messages[messages.length - 1]?.role === 'user' && (
            <div className="flex justify-start">
              <div className="bg-muted rounded-lg px-3 py-2">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border px-5 py-3 space-y-3">
          {selectedIds.length > 0 && (
            <Button
              variant="gold"
              size="sm"
              className="w-full"
              onClick={handleEnroll}
            >
              <Play className="h-3.5 w-3.5 mr-1.5" />
              Enroll {selectedIds.length} Contact{selectedIds.length !== 1 ? 's' : ''} in Sequence
            </Button>
          )}
          <div className="flex items-center gap-2">
            <Input
              placeholder="E.g., 'Show me all contacts at PGIM or Prudential'"
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
          <p className="text-xs text-muted-foreground opacity-60">
            Examples: "All portfolio managers at hedge funds", "Contacts at Goldman or Morgan Stanley"
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
