import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { tasks } from "@trigger.dev/sdk/v3";
import { simpleParser } from "mailparser";

/**
 * POST /api/webhooks/cloudflare-email
 *
 * Receives the raw RFC822 message body from a Cloudflare Email Worker
 * bound to the resumes-inbox address (e.g.
 * resumes_emeraldrecruit@sullyrecruit.app). We do the MIME parsing here
 * so the Worker stays zero-dependency and pasteable into the Cloudflare
 * dashboard editor.
 *
 * For each PDF/DOC/DOCX attachment: create or match a candidate stub
 * in `people`, upload the file to the resumes/ Storage bucket, insert
 * a `resumes` row, and queue the AI parser via the `resume-ingestion`
 * Trigger.dev task. Idempotent on (source_message_id, file_name).
 *
 * Auth: shared secret in the `x-cloudflare-secret` header. Value lives
 * in app_settings.CLOUDFLARE_EMAIL_WEBHOOK_SECRET *or* the
 * CLOUDFLARE_EMAIL_WEBHOOK_SECRET Vercel env var. Mismatch = 401.
 *
 * Headers the Worker passes through:
 *   - x-mail-from        — envelope MAIL FROM (often = parsed.from)
 *   - x-mail-to          — envelope RCPT TO   (the inbox alias hit)
 *   - x-cloudflare-secret— shared secret
 *
 * Body: raw RFC822 with Content-Type: message/rfc822.
 */

export const config = {
  api: {
    // mailparser handles binary streams; let bodyParser hand us the raw text.
    bodyParser: {
      sizeLimit: "30mb",
    },
  },
};

const RESUME_EXTS = [".pdf", ".doc", ".docx"];
const RESUMES_BUCKET = "resumes";
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB per attachment

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

  // The Worker may pass the raw email as a string (default JSON body
  // parsing) or as a Buffer. Normalise to a Buffer for mailparser.
  let raw: Buffer;
  if (typeof req.body === "string") {
    raw = Buffer.from(req.body, "utf-8");
  } else if (Buffer.isBuffer(req.body)) {
    raw = req.body;
  } else if (req.body && typeof req.body === "object") {
    // Some Vercel runtimes may have decoded JSON unexpectedly; reject
    // here rather than guess.
    return res.status(400).json({ error: "expected raw RFC822 body, got object" });
  } else {
    return res.status(400).json({ error: "missing body" });
  }

  // Cloudflare envelope headers (preserved by the Worker).
  const envelopeTo = String(req.headers["x-mail-to"] || "").toLowerCase();
  const envelopeFrom = String(req.headers["x-mail-from"] || "").toLowerCase();

  let parsed;
  try {
    parsed = await simpleParser(raw);
  } catch (err: any) {
    console.error("Cloudflare email: parse failed", err.message);
    return res.status(400).json({ error: `parse failed: ${err.message}` });
  }

  const fromAddress = (parsed.from?.value?.[0]?.address || envelopeFrom || "").toLowerCase();
  const fromName = parsed.from?.value?.[0]?.name || "";
  if (!fromAddress) {
    return res.status(400).json({ error: "no sender address found" });
  }

  const sourceMessageId = parsed.messageId || null;

  const resumeAttachments = (parsed.attachments || []).filter((a) => {
    const name = a.filename || "";
    if (!name) return false;
    const lower = name.toLowerCase();
    if (!RESUME_EXTS.some((ext) => lower.endsWith(ext))) return false;
    if (a.size && a.size > MAX_BYTES) return false;
    return !!a.content;
  });

  if (resumeAttachments.length === 0) {
    return res.status(200).json({ action: "no_resume_attachments", created: 0 });
  }

  // Find or create candidate stub.
  const senderDisplay = fromName.trim();
  const [firstNameGuess, ...rest] = senderDisplay.split(/\s+/);
  const lastNameGuess = rest.join(" ") || fromAddress.split("@")[0];

  let candidateId: string;
  const { data: existing } = await supabase
    .from("people")
    .select("id")
    .eq("email", fromAddress)
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
        full_name: senderDisplay || fromAddress,
        email: fromAddress,
        status: "new",
        source: "resumes_inbox",
        source_detail: envelopeTo || "cloudflare_email",
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
    const fileName = att.filename!;

    // Dedup on (source_message_id, file_name).
    if (sourceMessageId) {
      const { data: existingResume } = await supabase
        .from("resumes")
        .select("id")
        .eq("source_message_id", sourceMessageId)
        .eq("file_name", fileName)
        .maybeSingle();
      if (existingResume?.id) { skipped++; continue; }
    }

    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `inbox/${candidateId}/${Date.now()}_${safeName}`;
    const buffer = Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content as any);

    const { error: upErr } = await supabase.storage
      .from(RESUMES_BUCKET)
      .upload(storagePath, buffer, {
        contentType: att.contentType || "application/octet-stream",
        upsert: false,
      });
    if (upErr) {
      console.warn("Cloudflare email: upload failed", { fileName, error: upErr.message });
      skipped++;
      continue;
    }

    const { data: resumeRow, error: resErr } = await supabase
      .from("resumes")
      .insert({
        candidate_id: candidateId,
        file_path: storagePath,
        file_name: fileName,
        mime_type: att.contentType || null,
        parse_status: "pending",
        parsing_status: "pending",
        source_message_id: sourceMessageId,
      } as any)
      .select("id")
      .single();
    if (resErr || !resumeRow?.id) {
      // 23505 = unique violation = race; quietly skip + clean up storage.
      await supabase.storage.from(RESUMES_BUCKET).remove([storagePath]);
      skipped++;
      continue;
    }

    await tasks.trigger("resume-ingestion", {
      resumeId: resumeRow.id,
      candidateId,
      filePath: storagePath,
      fileName,
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
