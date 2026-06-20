import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import mammoth from "npm:mammoth";
import { Buffer } from "node:buffer";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MICROSOFT_GRAPH_CLIENT_ID = Deno.env.get("MICROSOFT_GRAPH_CLIENT_ID")!;
const MICROSOFT_GRAPH_CLIENT_SECRET = Deno.env.get("MICROSOFT_GRAPH_CLIENT_SECRET")!;
const MICROSOFT_GRAPH_TENANT_ID = Deno.env.get("MICROSOFT_GRAPH_TENANT_ID") || "common";
const ANTHROPIC_API_KEY =
  Deno.env.get("ANTHROPIC_API_KEY") ??
  Deno.env.get("anthropic_api_key") ??
  "";

const CLAUDE_MODEL = "claude-sonnet-4-20250514";
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";

const RESUME_SYSTEM = `You are a resume parser for The Emerald Recruiting Group, a Wall Street staffing firm. Extract structured candidate data from resumes with precision.

Return ONLY a raw JSON object — no markdown fences, no backticks, no preamble, no explanation. Just the JSON:
{
  "first_name": "",
  "last_name": "",
  "email": "",
  "phone": "",
  "linkedin_url": "",
  "location": "",
  "current_title": "",
  "current_company": "",
  "skills": []
}

Rules:
- Use empty string "" for any unknown/missing fields
- Use empty array [] if no skills found
- Extract up to 25 most relevant skills (technical tools, asset classes, languages, certifications)
- linkedin_url: return the full URL if present, or just the slug (e.g. "johndoe")
- phone: preserve formatting as-is
- location: city, state preferred (e.g. "New York, NY")
- current_title and current_company: use the most recent role`;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(d: unknown, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const RESUME_EXT = new Set([".pdf", ".doc", ".docx"]);
const RESUME_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

function isResume(name: string, mime: string) {
  const e = name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  return RESUME_EXT.has(e) || RESUME_MIME.has(mime);
}

function nEmail(e: any) {
  return e ? String(e).trim().toLowerCase() || null : null;
}

function nPhone(p: any) {
  if (!p) return null;
  const d = String(p).replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

function nLinkedIn(u: any) {
  if (!u) return null;
  const m = String(u).match(/linkedin\.com\/in\/([^/?\s]+)/);
  return m ? m[1].toLowerCase().replace(/\/$/, "") : null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let b64 = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    b64 += btoa(String.fromCharCode(...bytes.slice(i, i + 8192)));
  }
  return b64;
}

async function getToken(account: any): Promise<string> {
  if (
    account.access_token &&
    account.token_expires_at &&
    new Date(account.token_expires_at).getTime() - Date.now() > 300000
  ) return account.access_token;

  const r = await fetch(
    `https://login.microsoftonline.com/${MICROSOFT_GRAPH_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: MICROSOFT_GRAPH_CLIENT_ID,
        client_secret: MICROSOFT_GRAPH_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: account.refresh_token,
        scope: "offline_access Mail.Read Mail.Send User.Read openid profile",
      }),
    }
  );
  const d: any = await r.json();
  if (!r.ok) throw new Error(`Token: ${d?.error_description}`);
  await supabase
    .from("integration_accounts")
    .update({
      access_token: d.access_token,
      refresh_token: d.refresh_token ?? account.refresh_token,
      token_expires_at: new Date(Date.now() + Number(d.expires_in ?? 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", account.id);
  return d.access_token;
}

async function parseResume(fileUrl: string, fileName: string): Promise<any | null> {
  const ext = fileName.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";

  try {
    let content: any[];

    if (ext === ".pdf") {
      const r = await fetch(fileUrl);
      if (!r.ok) throw new Error(`DL ${r.status}`);
      const buf = await r.arrayBuffer();
      const b64 = arrayBufferToBase64(buf);
      content = [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: b64 },
        },
        { type: "text", text: "Parse this resume and return the JSON object." },
      ];
    } else {
      // DOCX / DOC: extract text with mammoth
      const r = await fetch(fileUrl);
      if (!r.ok) throw new Error(`DL ${r.status}`);
      const buf = await r.arrayBuffer();
      const buffer = Buffer.from(buf);
      let extractedText = "";
      try {
        const result = await mammoth.extractRawText({ buffer });
        extractedText = (result.value || "").trim();
      } catch (e) {
        throw new Error(`mammoth extraction failed: ${e}`);
      }
      if (!extractedText) {
        console.warn(`[backfill] empty text from ${fileName}`);
        return null;
      }
      content = [
        {
          type: "text",
          text: `Resume text:\n\n${extractedText}\n\nParse this resume and return the JSON object.`,
        },
      ];
    }

    const res = await fetch(CLAUDE_URL, {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: RESUME_SYSTEM,
        messages: [{ role: "user", content }],
      }),
    });

    const raw = await res.text();
    if (!res.ok) throw new Error(`Claude ${res.status}: ${raw.slice(0, 300)}`);

    const d = JSON.parse(raw);
    const text = d?.content?.[0]?.text ?? "";
    const clean = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error(`[backfill] parse ${fileName}:`, e);
    return null;
  }
}

async function findExisting(em: string | null, ph: string | null, li: string | null): Promise<any | null> {
  if (em) {
    const { data } = await supabase.from("candidates").select("*").ilike("email", em).maybeSingle();
    if (data) return data;
  }
  if (ph) {
    const { data: rows } = await supabase.from("candidates").select("*").not("phone", "is", null).neq("phone", "");
    const m = (rows ?? []).find((r: any) => nPhone(r.phone) === ph);
    if (m) return m;
  }
  if (li) {
    const { data: rows } = await supabase.from("candidates").select("*").not("linkedin_url", "is", null).neq("linkedin_url", "");
    const m = (rows ?? []).find((r: any) => nLinkedIn(r.linkedin_url) === li);
    if (m) return m;
  }
  return null;
}

async function upsert(
  parsed: any,
  ownerUserId: string,
  resumeUrl: string,
  msgDate: string
): Promise<{ id: string; action: string }> {
  const em = nEmail(parsed.email), ph = nPhone(parsed.phone), li = nLinkedIn(parsed.linkedin_url);
  const existing = await findExisting(em, ph, li);
  const f: Record<string, any> = {};
  if (parsed.first_name) f.first_name = parsed.first_name;
  if (parsed.last_name) f.last_name = parsed.last_name;
  if (parsed.first_name || parsed.last_name)
    f.full_name = [parsed.first_name, parsed.last_name].filter(Boolean).join(" ");
  if (parsed.email) f.email = parsed.email;
  if (parsed.phone) f.phone = parsed.phone;
  if (parsed.linkedin_url) f.linkedin_url = parsed.linkedin_url;
  if (parsed.current_title) f.current_title = parsed.current_title;
  if (parsed.current_company) f.current_company = parsed.current_company;
  if (parsed.location) f.location_text = parsed.location;
  if (parsed.skills?.length) f.skills = parsed.skills;
  f.resume_url = resumeUrl;
  f.updated_at = new Date().toISOString();

  if (existing) {
    const isNewer = !existing.updated_at || new Date(msgDate) > new Date(existing.updated_at);
    if (isNewer) {
      await supabase.from("candidates").update(f).eq("id", existing.id);
      return { id: existing.id, action: "updated" };
    } else {
      if (!existing.resume_url)
        await supabase.from("candidates").update({ resume_url: resumeUrl, updated_at: f.updated_at }).eq("id", existing.id);
      return { id: existing.id, action: "skipped" };
    }
  }

  const { data: c, error } = await supabase
    .from("candidates")
    .insert({ ...f, status: "new", owner_user_id: ownerUserId, created_at: new Date().toISOString() })
    .select("id")
    .single();
  if (error) throw new Error(`Insert: ${error.message}`);
  return { id: c.id, action: "created" };
}

async function processMessage(
  token: string,
  folderId: string | null,
  messageId: string,
  ownerUserId: string
): Promise<{ subject: string; stats: any; results: any[] }> {
  const baseUrl = folderId
    ? `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages/${messageId}`
    : `https://graph.microsoft.com/v1.0/me/messages/${messageId}`;

  const [metaResp, attResp] = await Promise.all([
    fetch(`${baseUrl}?$select=receivedDateTime,subject`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    fetch(`${baseUrl}/attachments?$select=id,name,contentType,size,contentBytes`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  ]);

  const md = metaResp.ok ? await metaResp.json() : {};
  const msgDate = md.receivedDateTime ?? new Date().toISOString();
  const subject = md.subject ?? "";

  if (!attResp.ok) {
    const errText = await attResp.text();
    console.error(`[backfill] att fetch ${attResp.status} msg=${messageId.slice(-20)}: ${errText.slice(0, 200)}`);
    return { subject, stats: { resumes_found: 0, created: 0, updated: 0, skipped: 0, errors: 1 }, results: [] };
  }
  const ad = await attResp.json();

  const resumeAtts = (ad.value ?? []).filter(
    (a: any) => a.contentBytes && a.size > 5000 && isResume(a.name ?? "", a.contentType ?? "")
  );
  const stats = { resumes_found: resumeAtts.length, created: 0, updated: 0, skipped: 0, errors: 0 };
  const results: any[] = [];

  console.log(`[backfill] msg="${subject}" resumes=${resumeAtts.length}`);

  for (let i = 0; i < resumeAtts.length; i += 5) {
    const chunk = resumeAtts.slice(i, i + 5);
    const chunkRes = await Promise.all(
      chunk.map(async (att: any) => {
        const fileName = att.name as string;
        try {
          const binary = atob(att.contentBytes);
          const bytes = new Uint8Array(binary.length);
          for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
          const tempPath = `backfill/tmp_${Date.now()}_${Math.random().toString(36).slice(2)}_${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
          const { error: upErr } = await supabase.storage
            .from("resumes")
            .upload(tempPath, bytes, { contentType: att.contentType, upsert: true });
          if (upErr) return { file: fileName, action: "error", error: upErr.message };

          const { data: pub } = supabase.storage.from("resumes").getPublicUrl(tempPath);
          const parsed = await parseResume(pub.publicUrl, fileName);

          if (!parsed || (!parsed.email && !parsed.phone && !parsed.linkedin_url && !parsed.first_name)) {
            await supabase.storage.from("resumes").remove([tempPath]);
            return { file: fileName, action: "unparseable" };
          }

          console.log(`[backfill] parsed: ${parsed.first_name} ${parsed.last_name} | ${parsed.email}`);
          const { id: candidateId, action } = await upsert(parsed, ownerUserId, pub.publicUrl, msgDate);

          const finalPath = `${candidateId}/${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
          await supabase.storage.from("resumes").copy(tempPath, finalPath).catch(() => {});
          await supabase.storage.from("resumes").remove([tempPath]).catch(() => {});
          const { data: fp } = supabase.storage.from("resumes").getPublicUrl(finalPath);

          const { data: ex } = await supabase
            .from("resumes")
            .select("id")
            .eq("candidate_id", candidateId)
            .eq("file_name", fileName)
            .maybeSingle();
          if (!ex)
            await supabase.from("resumes").insert({
              candidate_id: candidateId,
              file_path: finalPath,
              file_name: fileName,
              parser: "claude_email_backfill",
              parsing_status: "parsed",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
          await supabase
            .from("candidates")
            .update({ resume_url: fp.publicUrl, updated_at: new Date().toISOString() })
            .eq("id", candidateId);

          return { file: fileName, action, candidate_id: candidateId, name: `${parsed.first_name} ${parsed.last_name}` };
        } catch (err) {
          return { file: fileName, action: "error", error: String(err) };
        }
      })
    );
    results.push(...chunkRes);
    for (const r of chunkRes) {
      if (r.action === "created") stats.created++;
      else if (r.action === "updated") stats.updated++;
      else if (r.action === "skipped") stats.skipped++;
      else stats.errors++;
    }
  }
  return { subject, stats, results };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const body = await req.json().catch(() => ({}));
  const order: string = body.order === "desc" ? "desc" : "asc";
  const folderId: string | null = body.folder_id ?? null;

  const { data: account } = await supabase
    .from("integration_accounts")
    .select("id, email_address, access_token, refresh_token, token_expires_at, owner_user_id")
    .eq("email_address", "chris.sullivan@emeraldrecruit.com")
    .eq("auth_provider", "microsoft")
    .eq("is_active", true)
    .not("refresh_token", "is", null)
    .maybeSingle();
  if (!account) return json({ error: "No account" }, 400);
  const token = await getToken(account);

  if (body.scan_only && folderId) {
    const messages: any[] = [];
    let url = `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages?$select=id,subject,receivedDateTime,hasAttachments&$top=50&$orderby=receivedDateTime ${order}`;
    let count = 0;
    const maxScan = Number(body.max_scan ?? 200);
    while (url && count < maxScan) {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) break;
      const d = await r.json();
      for (const msg of d.value ?? []) {
        count++;
        messages.push({ id: msg.id, subject: msg.subject, received: msg.receivedDateTime, hasAttachments: msg.hasAttachments });
      }
      url = d["@odata.nextLink"] ?? "";
    }
    return json({ ok: true, scanned: count, folder_id: folderId, messages });
  }

  if (body.process_folder && folderId) {
    const maxProcess = Number(body.max_msgs ?? 10);
    const skip = Number(body.skip ?? 0);
    const totalStats = { resumes_found: 0, created: 0, updated: 0, skipped: 0, errors: 0 };
    const processed: any[] = [];
    const pageUrl = `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages?$select=id,subject,receivedDateTime,hasAttachments&$top=${maxProcess}&$skip=${skip}&$orderby=receivedDateTime asc`;
    const pageResp = await fetch(pageUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!pageResp.ok) return json({ error: `Graph ${pageResp.status}` }, 500);
    const pageData = await pageResp.json();
    const messages = pageData.value ?? [];
    const hasMore = !!pageData["@odata.nextLink"] || messages.length === maxProcess;
    for (const msg of messages) {
      const { subject, stats, results } = await processMessage(token, folderId, msg.id, account.owner_user_id);
      for (const k of Object.keys(totalStats) as (keyof typeof totalStats)[]) totalStats[k] += stats[k];
      if (stats.resumes_found > 0) processed.push({ message_id: msg.id, subject, stats, results });
    }
    return json({ ok: true, folder_id: folderId, skip, scanned: messages.length, has_more: hasMore, next_skip: skip + messages.length, total_stats: totalStats, processed });
  }

  if (body.message_ids && Array.isArray(body.message_ids)) {
    const totalStats = { resumes_found: 0, created: 0, updated: 0, skipped: 0, errors: 0 };
    const allResults: any[] = [];
    for (const msgId of body.message_ids) {
      const { subject, stats, results } = await processMessage(token, folderId, msgId, account.owner_user_id);
      for (const k of Object.keys(totalStats) as (keyof typeof totalStats)[]) totalStats[k] += stats[k];
      allResults.push({ message_id: msgId, subject, stats, results });
    }
    return json({ ok: true, total_stats: totalStats, messages: allResults });
  }

  if (body.message_id) {
    const { subject, stats, results } = await processMessage(token, folderId, body.message_id, account.owner_user_id);
    return json({ ok: true, message_id: body.message_id, subject, stats, results });
  }

  return json({ error: "Pass process_folder=true, message_id, message_ids[], or scan_only=true — all with folder_id" }, 400);
});
