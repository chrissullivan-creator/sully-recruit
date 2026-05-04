import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { tasks } from "@trigger.dev/sdk/v3";

/**
 * POST /api/webhooks/cloudflare-email
 *
 * Receives a parsed inbound email from a Cloudflare Email Worker bound
 * to the resumes-inbox address (e.g. resumes_emeraldrecruit@sullyrecruit.app).
 * For each PDF/DOC/DOCX attachment, creates or matches a candidate stub
 * in `people`, uploads the file to the resumes/ Storage bucket, inserts
 * a `resumes` row, and queues the AI parser via the `resume-ingestion`
 * Trigger.dev task.
 *
 * Idempotent on (source_message_id, file_name): redeliveries return 200
 * without duplicating work.
 *
 * Auth: shared secret in the `x-cloudflare-secret` header (the same
 * value goes in app_settings.CLOUDFLARE_EMAIL_WEBHOOK_SECRET *or* the
 * CLOUDFLARE_EMAIL_WEBHOOK_SECRET env var). When neither is set the
 * endpoint refuses requests outright — never accept unverified payloads
 * on a public URL.
 */

interface InboundAttachment {
  filename: string;
  contentType: string;
  /** Base64-encoded bytes. */
  contentBase64: string;
  size?: number;
}

interface InboundPayload {
  sender_email: string;
  sender_name?: string;
  recipient_email: string;
  subject?: string;
  message_id?: string;
  attachments: InboundAttachment[];
}

const RESUME_EXTS = [".pdf", ".doc", ".docx"];
const RESUMES_BUCKET = "resumes";
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "server misconfigured" });
  const supabase = createClient(supabaseUrl, serviceKey);

  // Resolve expected secret from env var first, then app_settings.
  let expectedSecret = process.env.CLOUDFLARE_EMAIL_WEBHOOK_SECRET || "";
  if (!expectedSecret) {
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "CLOUDFLARE_EMAIL_WEBHOOK_SECRET")
      .maybeSingle();
    expectedSecret = data?.value || "";
  }
  if (!expectedSecret) {
    return res.status(500).json({ error: "CLOUDFLARE_EMAIL_WEBHOOK_SECRET not configured" });
  }
  const incoming = String(req.headers["x-cloudflare-secret"] || "");
  if (incoming !== expectedSecret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const body = req.body as InboundPayload;
  if (!body || !body.sender_email || !Array.isArray(body.attachments)) {
    return res.status(400).json({ error: "malformed payload" });
  }

  const sender = body.sender_email.toLowerCase();
  const recipient = (body.recipient_email || "").toLowerCase();
  const sourceMessageId = body.message_id || null;

  const resumeAttachments = body.attachments.filter((a) => {
    if (!a.filename || !a.contentBase64) return false;
    const lower = a.filename.toLowerCase();
    if (!RESUME_EXTS.some((ext) => lower.endsWith(ext))) return false;
    if (a.size && a.size > MAX_BYTES) return false;
    return true;
  });

  if (resumeAttachments.length === 0) {
    return res.status(200).json({ action: "no_resume_attachments", created: 0 });
  }

  // Find or create candidate stub.
  const senderDisplay = body.sender_name?.trim() || "";
  const [firstNameGuess, ...rest] = senderDisplay.split(/\s+/);
  const lastNameGuess = rest.join(" ") || sender.split("@")[0];

  let candidateId: string;
  const { data: existing } = await supabase
    .from("people")
    .select("id")
    .eq("email", sender)
    .maybeSingle();
  if (existing?.id) {
    candidateId = existing.id;
  } else {
    const { data: created, error: createErr } = await supabase
      .from("people")
      .insert({
        type: "candidate",
        first_name: firstNameGuess || null,
        last_name: lastNameGuess || null,
        full_name: senderDisplay || sender,
        email: sender,
        status: "new",
        source: "resumes_inbox",
        source_detail: recipient || "cloudflare_email",
        is_stub: true,
      } as any)
      .select("id")
      .single();
    if (createErr || !created?.id) {
      console.error("Cloudflare email: create candidate failed", createErr);
      return res.status(500).json({ error: "candidate insert failed" });
    }
    candidateId = created.id;
  }

  let created = 0;
  let skipped = 0;

  for (const att of resumeAttachments) {
    // Dedup on (source_message_id, file_name) so worker retries don't
    // duplicate parses.
    if (sourceMessageId) {
      const { data: existingResume } = await supabase
        .from("resumes")
        .select("id")
        .eq("source_message_id", sourceMessageId)
        .eq("file_name", att.filename)
        .maybeSingle();
      if (existingResume?.id) { skipped++; continue; }
    }

    const safeName = att.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `inbox/${candidateId}/${Date.now()}_${safeName}`;
    const buffer = Buffer.from(att.contentBase64, "base64");

    const { error: upErr } = await supabase.storage
      .from(RESUMES_BUCKET)
      .upload(storagePath, buffer, {
        contentType: att.contentType || "application/octet-stream",
        upsert: false,
      });
    if (upErr) {
      console.warn("Cloudflare email: upload failed", { filename: att.filename, error: upErr.message });
      skipped++;
      continue;
    }

    const { data: resumeRow, error: resErr } = await supabase
      .from("resumes")
      .insert({
        candidate_id: candidateId,
        file_path: storagePath,
        file_name: att.filename,
        mime_type: att.contentType || null,
        parse_status: "pending",
        parsing_status: "pending",
        source_message_id: sourceMessageId,
      } as any)
      .select("id")
      .single();
    if (resErr || !resumeRow?.id) {
      // 23505 = unique violation = race; quietly skip + clean storage.
      await supabase.storage.from(RESUMES_BUCKET).remove([storagePath]);
      skipped++;
      continue;
    }

    await tasks.trigger("resume-ingestion", {
      resumeId: resumeRow.id,
      candidateId,
      filePath: storagePath,
      fileName: att.filename,
    });
    created++;
  }

  return res.status(200).json({
    action: "processed",
    candidate_id: candidateId,
    created,
    skipped,
  });
}
