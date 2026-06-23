import { supabase } from '@/integrations/supabase/client';
import type { MessageAttachment } from '@/components/inbox/inbox-shared';

// Shared Inbox utility helpers — extracted from Inbox.tsx so the page's
// sub-components can move out while still sharing one implementation.

export function stripEmailThread(body: string): string {
  // Remove everything after "On ... wrote:" quote block
  const patterns = [
    /\r?\n\s*On .{10,80} wrote:\s*\r?\n[\s\S]*/,
    /\r?\n\s*----+ ?Original Message ?----+[\s\S]*/i,
    /\r?\n\s*From: .+[\s\S]*/,
    /\r?\n\s*>.*(\r?\n\s*>.*)*/,
  ];
  let result = body;
  for (const p of patterns) {
    const m = result.match(p);
    if (m && m.index !== undefined && m.index > 20) {
      result = result.slice(0, m.index).trimEnd();
      break;
    }
  }
  return result;
}

export function getInitials(name: string | null | undefined): string {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// ---------- Attachments ----------
export const MESSAGE_ATTACHMENTS_BUCKET = 'message-attachments';
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15 MB

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function resolveAttachmentUrl(att: MessageAttachment): Promise<string | null> {
  if (att.url) return att.url;
  if (!att.storage_path) return null;
  const { data } = await supabase.storage
    .from(MESSAGE_ATTACHMENTS_BUCKET)
    .createSignedUrl(att.storage_path, 60 * 60); // 1 hour
  return data?.signedUrl ?? null;
}

export interface PendingAttachment {
  id: string;
  file: File;
  storage_path?: string;
  uploading: boolean;
  error?: string;
}

export async function uploadAttachment(
  conversationId: string,
  file: File
): Promise<{ storage_path: string; name: string; size: number; mime_type: string }> {
  const ext = file.name.split('.').pop() || 'bin';
  const safeBase = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${conversationId}/${Date.now()}-${crypto.randomUUID()}-${safeBase}`;
  const { error } = await supabase.storage
    .from(MESSAGE_ATTACHMENTS_BUCKET)
    .upload(path, file, {
      contentType: file.type || `application/${ext}`,
      upsert: false,
    });
  if (error) throw error;
  return {
    storage_path: path,
    name: file.name,
    size: file.size,
    mime_type: file.type || 'application/octet-stream',
  };
}

// ---------- Drafts ----------
// Drafts persist per-thread in localStorage so switching threads or
// closing the tab doesn't blow away what the user typed. Key shape:
// inbox_draft:<thread_id>. Stored as { html, text, updated_at } JSON.
const DRAFT_KEY_PREFIX = 'inbox_draft:';

export function loadDraft(threadId: string | null): { html: string; text: string } | null {
  if (!threadId || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(`${DRAFT_KEY_PREFIX}${threadId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return { html: parsed.html ?? '', text: parsed.text ?? '' };
  } catch {
    return null;
  }
}

export function saveDraft(threadId: string, html: string, text: string): void {
  if (typeof window === 'undefined') return;
  if (!html.trim() && !text.trim()) {
    window.localStorage.removeItem(`${DRAFT_KEY_PREFIX}${threadId}`);
    return;
  }
  try {
    window.localStorage.setItem(
      `${DRAFT_KEY_PREFIX}${threadId}`,
      JSON.stringify({ html, text, updated_at: Date.now() }),
    );
  } catch {
    // Quota / disabled storage — silently ignore, draft just won't persist.
  }
}

export function clearDraft(threadId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(`${DRAFT_KEY_PREFIX}${threadId}`);
  } catch {
    // ignore
  }
}
