import { useState, useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Mail, Linkedin, MessageCircle, PhoneCall, Loader2, Check, X, Edit } from 'lucide-react';

// SentimentChip now lives in components/shared so the inbox + candidate detail
// share one treatment. Re-exported here to keep existing imports working.
export { SentimentChip } from '@/components/shared/SentimentChip';

export const ChannelIcon = ({ channel }: { channel?: string | null }) => {
  if (!channel) return null;
  if (channel === 'email') return <Mail className="h-3 w-3" />;
  if (channel === 'linkedin' || channel.startsWith('linkedin')) return <Linkedin className="h-3 w-3" />;
  if (channel === 'sms') return <MessageCircle className="h-3 w-3" />;
  if (channel === 'phone') return <PhoneCall className="h-3 w-3" />;
  return null;
};

export const EditableField = ({ label, value, onSave, type = 'text', placeholder, disabled = false, highlight = false }: {
  label: ReactNode; value: string | null | undefined; onSave: (v: string) => Promise<void>;
  type?: string; placeholder?: string; disabled?: boolean; highlight?: boolean;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setDraft(value ?? ''); }, [value]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);
  const save = async () => { setSaving(true); await onSave(draft); setSaving(false); setEditing(false); };
  const cancel = () => { setDraft(value ?? ''); setEditing(false); };
  return (
    <div className="group space-y-0.5">
      <Label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{label}</Label>
      {editing ? (
        <div className="flex items-center gap-1">
          <Input ref={inputRef} type={type} value={draft} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
            className="h-7 text-sm flex-1" placeholder={placeholder} />
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3 text-green-400" />}
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={cancel}>
            <X className="h-3 w-3 text-red-400" />
          </Button>
        </div>
      ) : (
        <div className={cn("flex items-center gap-1 rounded px-1.5 py-0.5 -mx-1.5 transition-colors", disabled ? '' : 'cursor-pointer hover:bg-accent/10', highlight && !disabled && 'bg-accent/5 ring-1 ring-accent/20')} onClick={() => !disabled && setEditing(true)}>
          <span className={cn('text-sm flex-1 truncate', value ? 'text-foreground' : 'text-muted-foreground italic')}>
            {value || placeholder || '—'}
          </span>
          {!disabled && <Edit className={cn("h-3 w-3 text-muted-foreground shrink-0", highlight ? 'opacity-100 text-accent' : 'opacity-0 group-hover:opacity-100')} />}
        </div>
      )}
    </div>
  );
};

export const EditableTextarea = ({ label, value, onSave, placeholder, rows = 4, disabled = false }: {
  label: string; value: string | null | undefined; onSave: (v: string) => Promise<void>;
  placeholder?: string; rows?: number; disabled?: boolean;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(value ?? ''); }, [value]);
  const save = async () => { setSaving(true); await onSave(draft); setSaving(false); setEditing(false); };
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{label}</Label>
        {!editing && !disabled && (
          <button onClick={() => setEditing(true)} className="text-[10px] text-muted-foreground hover:text-accent flex items-center gap-0.5">
            <Edit className="h-2.5 w-2.5" /> Edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="space-y-1.5">
          <textarea autoFocus value={draft} onChange={e => setDraft(e.target.value)} rows={rows}
            className="w-full rounded-md border border-input bg-background text-foreground p-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y"
            placeholder={placeholder} />
          <div className="flex gap-1.5">
            <Button size="sm" variant="gold" onClick={save} disabled={saving} className="h-7 text-xs">
              {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null} Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setDraft(value ?? ''); setEditing(false); }} className="h-7 text-xs">Cancel</Button>
          </div>
        </div>
      ) : (
        <div className={cn("text-sm text-foreground rounded-md border border-transparent p-1.5 -mx-1.5 min-h-8 whitespace-pre-wrap", disabled ? '' : 'hover:border-border cursor-pointer')} onClick={() => !disabled && setEditing(true)}>
          {value || <span className="text-muted-foreground italic">{placeholder || 'Click to add…'}</span>}
        </div>
      )}
    </div>
  );
};
