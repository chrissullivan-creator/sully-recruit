import type { ElementType } from 'react';
import { Mail, MessageSquare, Linkedin, Phone } from 'lucide-react';

// Shared Inbox types + channel constants. Extracted from Inbox.tsx so the
// inbox sub-components (ThreadItem, EntityPanel, MessagePane, …) can move out
// of the 2,500-line page file while still sharing one source of truth.

// ---------- Types ----------
export interface MessageAttachment {
  name: string;
  url?: string | null;
  storage_path?: string | null;
  mime_type?: string | null;
  size?: number | null;
}

export interface InboxThread {
  id: string;
  channel: string;
  subject: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_inbound_at: string | null;
  last_inbound_preview: string | null;
  sort_at: string | null;
  is_read: boolean;
  is_archived: boolean;
  flagged?: boolean | null;
  snoozed_until?: string | null;
  follow_up_at?: string | null;
  follow_up_at_set_at?: string | null;
  follow_up_triggered_at?: string | null;
  woke_from_snooze_at?: string | null;
  last_outbound_at?: string | null;
  status?: 'awaiting_reply' | 'replied' | 'snoozed' | 'closed' | 'no_reply_needed' | null;
  candidate_id: string | null;
  candidate_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  // Latest inbound message's sender name — the list/detail fall back to this
  // when the thread isn't linked to a CRM person yet (e.g. unknown InMails).
  sender_name?: string | null;
  // Linked person's photo, surfaced by the inbox_threads view for avatars.
  avatar_url?: string | null;
  send_out_id: string | null;
  account_id: string | null;
  external_conversation_id: string | null;
  integration_account_id: string | null;
  has_attachments?: boolean | null;
  // Reply sentiment surfaced from the inbox_threads view (per-person denorm).
  sentiment?: string | null;
  sentiment_note?: string | null;
}

export interface Message {
  id: string;
  conversation_id: string;
  direction: string;
  channel: string;
  subject: string | null;
  body: string | null;
  sent_at: string | null;
  received_at: string | null;
  sender_name: string | null;
  sender_address: string | null;
  recipient_address: string | null;
  created_at: string;
  candidate_id: string;
  contact_id: string | null;
  attachments: MessageAttachment[] | null;
}

// ---------- Constants ----------
// Classic LinkedIn messages only — Recruiter InMails get their own tab.
export const LINKEDIN_CHANNELS = ['linkedin'] as const;

export const CHANNEL_ICONS: Record<string, ElementType> = {
  email: Mail,
  sms: MessageSquare,
  linkedin: Linkedin,
  linkedin_recruiter: Linkedin,
  phone: Phone,
  call: Phone,
};
export const CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  sms: 'SMS',
  linkedin: 'LinkedIn',
  linkedin_recruiter: 'Recruiter',
  phone: 'Phone',
  call: 'Call',
};
export const CHANNEL_COLORS: Record<string, string> = {
  email: 'bg-info/10 text-info',
  linkedin: 'bg-[hsl(199_89%_48%/0.1)] text-[hsl(199_89%_48%)]',
  linkedin_recruiter: 'bg-[hsl(199_89%_48%/0.1)] text-[hsl(199_89%_48%)]',
  sms: 'bg-success/10 text-success',
  phone: 'bg-accent/10 text-accent',
  call: 'bg-accent/10 text-accent',
};
