import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import {
  Phone, PhoneIncoming, PhoneOutgoing, Mic, ListChecks,
  PlayCircle, ChevronDown, ChevronRight, Loader2, ExternalLink, Hash,
} from 'lucide-react';
import { formatAbsoluteTimestamp, formatThreadTimestamp } from '@/lib/format-time';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Link } from 'react-router-dom';

interface CallLogRow {
  id: string;
  phone_number: string | null;
  direction: string | null;
  duration_seconds: number | null;
  started_at: string | null;
  ended_at: string | null;
  status: string | null;
  notes: string | null;
  summary: string | null;
  audio_url: string | null;
  external_call_id: string | null;
  linked_entity_name: string | null;
}

interface AiCallNoteRow {
  id: string;
  ai_summary: string | null;
  ai_action_items: string | null;
  transcript: string | null;
  call_duration_formatted: string | null;
  recording_url: string | null;
  extracted_current_base: number | null;
  extracted_current_bonus: number | null;
  extracted_target_base: number | null;
  extracted_target_bonus: number | null;
  extracted_reason_for_leaving: string | null;
  extracted_notes: string | null;
  structured_notes: unknown;
  processing_status: string | null;
}

interface CallMessageCardProps {
  /** call_logs.id === conversations.id for calls synced by the trigger */
  callLogId: string;
  entityName?: string | null;
  defaultExpanded?: boolean;
}

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function formatMoney(n: number | null | undefined): string | null {
  if (n === null || n === undefined) return null;
  if (n >= 1000) return `$${Math.round(n / 1000)}k`;
  return `$${n}`;
}

/**
 * Outlook-style card for a single call in the inbox reading pane.
 * Shows direction, duration, AI summary, action items, extracted intel
 * (compensation, reason for leaving), and inline audio playback when a
 * recording URL is available. Designed to replace the chat bubble for
 * channel='call' threads.
 */
export function CallMessageCard({ callLogId, entityName, defaultExpanded = true }: CallMessageCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showTranscript, setShowTranscript] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['inbox_call_detail', callLogId],
    queryFn: async () => {
      const [{ data: log }, { data: notesList }] = await Promise.all([
        supabase.from('call_logs').select(
          'id, phone_number, direction, duration_seconds, started_at, ended_at, status, notes, summary, audio_url, external_call_id, linked_entity_name'
        ).eq('id', callLogId).maybeSingle(),
        supabase.from('ai_call_notes').select(
          'id, ai_summary, ai_action_items, transcript, call_duration_formatted, recording_url, extracted_current_base, extracted_current_bonus, extracted_target_base, extracted_target_bonus, extracted_reason_for_leaving, extracted_notes, structured_notes, processing_status'
        ).eq('call_log_id', callLogId).order('created_at', { ascending: false }).limit(1),
      ]);
      return { log: log as CallLogRow | null, note: (notesList?.[0] ?? null) as AiCallNoteRow | null };
    },
  });

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border/60 px-4 py-4 flex items-center gap-3">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Loading call…</span>
      </div>
    );
  }
  if (!data?.log) {
    return (
      <div className="rounded-lg border border-border/60 px-4 py-4">
        <p className="text-xs text-muted-foreground italic">Call detail not found.</p>
      </div>
    );
  }

  const { log, note } = data;
  const isInbound = (log.direction ?? 'inbound') === 'inbound';
  const DirectionIcon = isInbound ? PhoneIncoming : PhoneOutgoing;
  const ts = log.started_at || log.ended_at;
  const summaryText = note?.ai_summary || log.summary || log.notes || '';
  const durationLabel = note?.call_duration_formatted || formatDuration(log.duration_seconds);
  const recordingUrl = note?.recording_url || log.audio_url || null;
  const aiProcessing = note?.processing_status && note.processing_status !== 'completed' && note.processing_status !== 'success';

  const compItems: { label: string; value: string }[] = [];
  if (note?.extracted_current_base) compItems.push({ label: 'Current base', value: formatMoney(note.extracted_current_base) || '' });
  if (note?.extracted_current_bonus) compItems.push({ label: 'Current bonus', value: formatMoney(note.extracted_current_bonus) || '' });
  if (note?.extracted_target_base) compItems.push({ label: 'Target base', value: formatMoney(note.extracted_target_base) || '' });
  if (note?.extracted_target_bonus) compItems.push({ label: 'Target bonus', value: formatMoney(note.extracted_target_bonus) || '' });

  return (
    <div className={cn('rounded-lg border bg-background', expanded ? 'border-border shadow-sm' : 'border-border/60')}>
      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-4 py-3 flex items-start gap-3"
      >
        <div className="mt-0.5 text-muted-foreground shrink-0">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </div>
        <div className={cn(
          'h-8 w-8 shrink-0 rounded-full flex items-center justify-center',
          isInbound ? 'bg-[#2A5C42]/15 text-[#2A5C42]' : 'bg-[#C9A84C]/15 text-[#C9A84C]',
        )}>
          <DirectionIcon className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="text-sm font-semibold text-foreground truncate">
                {isInbound ? 'Call from' : 'Call to'} {entityName || log.linked_entity_name || log.phone_number || 'unknown'}
              </span>
              {log.phone_number && (
                <span className="text-xs text-muted-foreground truncate">{log.phone_number}</span>
              )}
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-xs text-muted-foreground tabular-nums shrink-0 cursor-default">
                  {formatThreadTimestamp(ts)}
                </span>
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">{formatAbsoluteTimestamp(ts)}</TooltipContent>
            </Tooltip>
          </div>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Phone className="h-3 w-3" /> {durationLabel}
            </span>
            {log.status && (
              <>
                <span className="opacity-50">·</span>
                <span className="capitalize">{log.status}</span>
              </>
            )}
            {aiProcessing && (
              <>
                <span className="opacity-50">·</span>
                <span className="inline-flex items-center gap-1 text-amber-600">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  AI processing
                </span>
              </>
            )}
          </div>
        </div>
      </button>

      {/* Body — only when expanded */}
      {expanded && (
        <div className="px-4 pb-4 pt-1 border-t border-border/60 space-y-4">
          {/* Recording */}
          {recordingUrl && (
            <div className="flex items-center gap-2 rounded border border-border/60 bg-muted/30 px-3 py-2">
              <PlayCircle className="h-4 w-4 text-accent shrink-0" />
              <audio controls src={recordingUrl} className="flex-1 h-7" preload="none">
                Your browser doesn't support inline audio.
              </audio>
              <a
                href={recordingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                title="Open recording in new tab"
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}

          {/* AI summary */}
          {summaryText ? (
            <div>
              <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Summary</h4>
              <p className="text-sm text-foreground whitespace-pre-wrap">{summaryText}</p>
            </div>
          ) : (
            <p className="text-sm italic text-muted-foreground">No summary yet.</p>
          )}

          {/* Action items */}
          {note?.ai_action_items && (
            <div>
              <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1 inline-flex items-center gap-1">
                <ListChecks className="h-3 w-3" /> Action items
              </h4>
              <div className="text-sm text-foreground whitespace-pre-wrap">{note.ai_action_items}</div>
            </div>
          )}

          {/* Extracted comp intel */}
          {compItems.length > 0 && (
            <div>
              <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 inline-flex items-center gap-1">
                <Hash className="h-3 w-3" /> Extracted intel
              </h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {compItems.map((c) => (
                  <div key={c.label} className="rounded border border-border/60 px-2.5 py-1.5">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{c.label}</div>
                    <div className="text-sm font-semibold tabular-nums">{c.value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {note?.extracted_reason_for_leaving && (
            <div>
              <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Why looking</h4>
              <p className="text-sm text-foreground">{note.extracted_reason_for_leaving}</p>
            </div>
          )}

          {note?.extracted_notes && (
            <div>
              <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Notes</h4>
              <p className="text-sm text-foreground whitespace-pre-wrap">{note.extracted_notes}</p>
            </div>
          )}

          {/* Transcript — collapsed by default */}
          {note?.transcript && (
            <div>
              <button
                type="button"
                onClick={() => setShowTranscript((v) => !v)}
                className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                <Mic className="h-3 w-3" />
                {showTranscript ? 'Hide transcript' : 'Show transcript'}
                {showTranscript ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </button>
              {showTranscript && (
                <pre className="mt-2 text-xs whitespace-pre-wrap font-sans text-foreground/80 bg-muted/30 rounded p-3 max-h-80 overflow-y-auto">
                  {note.transcript}
                </pre>
              )}
            </div>
          )}

          {/* Footer link to dedicated /calls page for advanced editing */}
          <div className="pt-2 border-t border-border/60">
            <Link
              to={`/calls?call_id=${log.id}`}
              className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            >
              <ExternalLink className="h-3 w-3" />
              Open in Calls workspace
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
