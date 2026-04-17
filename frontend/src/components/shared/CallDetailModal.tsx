import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import {
  PhoneIncoming, PhoneOutgoing, Clock, FileText, ListChecks,
  DollarSign, Briefcase, ChevronDown, ChevronUp,
} from 'lucide-react';
import { useState } from 'react';

interface CallDetailModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  call: any; // call_log row
  aiNotes?: any; // ai_call_notes row (optional, may not exist)
}

export function CallDetailModal({ open, onOpenChange, call, aiNotes }: CallDetailModalProps) {
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  if (!call) return null;

  const isOutbound = call.direction === 'outbound';
  const duration = call.duration_seconds;
  const durationStr = duration
    ? `${Math.floor(duration / 60)}:${(duration % 60).toString().padStart(2, '0')}`
    : '--:--';
  const startedAt = call.started_at ? format(new Date(call.started_at), 'MMM d, yyyy · h:mm a') : '—';
  const personName = call.linked_entity_name || aiNotes?.candidate_id || 'Unknown';

  const summary = aiNotes?.ai_summary || call.summary;
  const actionItems = aiNotes?.ai_action_items;
  const transcript = aiNotes?.transcript;
  // Don't fall back to call.notes — it's RC's status string ("Call connected", "Missed", etc.)
  // and just clutters the modal when there's no real note.
  const notes = aiNotes?.extracted_notes ?? null;
  const audioUrl = aiNotes?.recording_url || call.audio_url;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
              isOutbound ? 'bg-info/10 text-info' : 'bg-success/10 text-success'
            )}>
              {isOutbound ? <PhoneOutgoing className="h-4.5 w-4.5" /> : <PhoneIncoming className="h-4.5 w-4.5" />}
            </div>
            <div>
              <span className="text-base">{isOutbound ? 'Outbound' : 'Inbound'} Call — {personName}</span>
              <p className="text-xs text-muted-foreground font-normal mt-0.5">
                {call.phone_number} · {startedAt} · <Clock className="h-3 w-3 inline" /> {durationStr}
              </p>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {/* Audio Player */}
          {audioUrl && (
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Recording</p>
              <audio controls className="w-full h-8" preload="none">
                <source src={audioUrl} />
              </audio>
            </div>
          )}

          {/* AI Summary */}
          {summary && (
            <div className="rounded-lg border border-accent/20 bg-accent/5 p-4">
              <div className="flex items-center gap-2 mb-2">
                <FileText className="h-4 w-4 text-accent" />
                <p className="text-xs font-semibold text-accent uppercase tracking-wide">Joe's Summary</p>
              </div>
              <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{summary}</p>
            </div>
          )}

          {/* Action Items */}
          {actionItems && (
            <div className="rounded-lg border border-border bg-secondary/30 p-4">
              <div className="flex items-center gap-2 mb-2">
                <ListChecks className="h-4 w-4 text-foreground" />
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Action Items</p>
              </div>
              <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{actionItems}</p>
            </div>
          )}

          {/* Extracted Notes */}
          {notes && (
            <div className="rounded-lg border border-border bg-secondary/30 p-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Notes</p>
              <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{notes}</p>
            </div>
          )}

          {/* Extracted Comp & Intel */}
          {(aiNotes?.extracted_current_base != null || aiNotes?.extracted_target_base != null || aiNotes?.extracted_reason_for_leaving) && (
            <div className="rounded-lg border border-border bg-secondary/30 p-4">
              <div className="flex items-center gap-2 mb-3">
                <DollarSign className="h-4 w-4 text-foreground" />
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Extracted Intel</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {aiNotes?.extracted_current_base != null && (
                  <div>
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-0.5">Current Base</p>
                    <p className="text-sm text-foreground">${Number(aiNotes.extracted_current_base).toLocaleString()}</p>
                  </div>
                )}
                {aiNotes?.extracted_current_bonus != null && (
                  <div>
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-0.5">Current Bonus</p>
                    <p className="text-sm text-foreground">${Number(aiNotes.extracted_current_bonus).toLocaleString()}</p>
                  </div>
                )}
                {aiNotes?.extracted_target_base != null && (
                  <div>
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-0.5">Target Base</p>
                    <p className="text-sm text-foreground">${Number(aiNotes.extracted_target_base).toLocaleString()}</p>
                  </div>
                )}
                {aiNotes?.extracted_target_bonus != null && (
                  <div>
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-0.5">Target Bonus</p>
                    <p className="text-sm text-foreground">${Number(aiNotes.extracted_target_bonus).toLocaleString()}</p>
                  </div>
                )}
              </div>
              {aiNotes?.extracted_reason_for_leaving && (
                <div className="mt-3">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-0.5">Reason for Leaving</p>
                  <p className="text-sm text-foreground leading-relaxed">{aiNotes.extracted_reason_for_leaving}</p>
                </div>
              )}
            </div>
          )}

          {/* Collapsible Transcript */}
          {transcript && (
            <div className="rounded-lg border border-border">
              <button
                onClick={() => setTranscriptOpen(!transcriptOpen)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors"
              >
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Full Transcript</span>
                {transcriptOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
              </button>
              {transcriptOpen && (
                <div className="px-4 pb-4 max-h-80 overflow-y-auto">
                  <p className="text-xs text-foreground/80 leading-relaxed whitespace-pre-wrap font-mono">{transcript}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
