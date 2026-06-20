import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const RESUME_FILENAME_RE = /resume|cv|curriculum.vitae/i;
const RESUME_EXT_RE = /\.(pdf|docx)$/i;
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const GRAPH_CLIENT_ID = Deno.env.get('MICROSOFT_GRAPH_CLIENT_ID') ?? '';
const GRAPH_CLIENT_SECRET = Deno.env.get('MICROSOFT_GRAPH_CLIENT_SECRET') ?? '';
const GRAPH_TENANT_ID = Deno.env.get('MICROSOFT_GRAPH_TENANT_ID') ?? 'common';
const GRAPH_ACCOUNT_EMAILS = Deno.env.get('MICROSOFT_GRAPH_ACCOUNT_EMAILS') ?? '';
const HOUSE_CLIENT_ID = Deno.env.get('MICROSOFT_CLIENT_ID') ?? '';
const HOUSE_CLIENT_SECRET = Deno.env.get('MICROSOFT_CLIENT_SECRET') ?? '';
const HOUSE_TENANT_ID = Deno.env.get('MICROSOFT_TENANT_ID') ?? 'common';

function getGraphEmails() {
  return new Set(GRAPH_ACCOUNT_EMAILS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}
function getCredsForEmail(email: string) {
  const useGraph = getGraphEmails().has(email.toLowerCase().trim());
  return useGraph
    ? { clientId: GRAPH_CLIENT_ID, clientSecret: GRAPH_CLIENT_SECRET, tenantId: GRAPH_TENANT_ID }
    : { clientId: HOUSE_CLIENT_ID, clientSecret: HOUSE_CLIENT_SECRET, tenantId: HOUSE_TENANT_ID };
}

// ── Claude sentiment analysis — same block as unipile-webhook
async function analyzeSentiment(messageText: string, channel: string): Promise<{ sentiment: string; summary: string } | null> {
  if (!ANTHROPIC_API_KEY || !messageText.trim()) return null;
  // Strip HTML for email bodies before sending to Claude
  const plainText = messageText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
  if (plainText.length < 5) return null;
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: `You analyze inbound replies to recruiting outreach from a Wall Street recruiting firm specializing in hedge funds, investment banks, prop trading, fintech, and asset managers. Classify the sentiment of the reply and write a crisp, useful 1-2 sentence note for the recruiter to read when reviewing the candidate or contact profile.\n\nRespond ONLY with valid JSON — no preamble, no markdown fences:\n{"sentiment": "...", "summary": ".."}\n\nSentiment must be exactly one of:\n- interested: actively asking about a role, requesting details, wants to talk\n- positive: friendly and responsive but no explicit role interest\n- maybe: open to hearing more but noncommittal\n- neutral: purely transactional, no signal either way\n- negative: dismissive or unfriendly but not asking to stop\n- not_interested: clearly declining, too busy, happy where they are\n- do_not_contact: explicitly asked to stop reaching out, unsubscribe, or remove from list\n\nKeep the summary factual, recruiter-facing, and scannable. No fluff.`,
        messages: [{ role: 'user', content: `Channel: ${channel}\n\nInbound message:\n${plainText}` }],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = (data.content?.[0]?.text ?? '') as string;
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (!parsed.sentiment || !parsed.summary) return null;
    return { sentiment: parsed.sentiment, summary: parsed.summary };
  } catch (e) {
    console.error('[sentiment] email analysis failed:', e);
    return null;
  }
}

async function saveSentiment(supabase: any, params: {
  candidateId: string | null; contactId: string | null; enrollmentId: string | null;
  channel: string; sentiment: string; summary: string; rawMessage: string;
}) {
  const now = new Date().toISOString();
  await supabase.from('reply_sentiment').insert({
    candidate_id: params.candidateId, contact_id: params.contactId,
    enrollment_id: params.enrollmentId, channel: params.channel,
    sentiment: params.sentiment, summary: params.summary,
    raw_message: params.rawMessage.slice(0, 2000),
    analyzed_at: now, created_at: now,
  });
}

async function findActiveEnrollment(supabase: any, candidateId: string | null, contactId: string | null): Promise<string | null> {
  const col = candidateId ? 'candidate_id' : 'contact_id';
  const val = candidateId ?? contactId;
  if (!val) return null;
  const { data } = await supabase.from('sequence_enrollments')
    .select('id').eq(col, val).eq('status', 'active')
    .order('enrolled_at', { ascending: false }).limit(1).maybeSingle();
  return data?.id ?? null;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const validationToken = url.searchParams.get('validationToken');
  if (validationToken) {
    return new Response(decodeURIComponent(validationToken), {
      status: 200, headers: { 'Content-Type': 'text/plain' },
    });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json();
    const notifications: any[] = body?.value ?? [];
    console.log(`outlook-webhook: received ${notifications.length} notification(s)`);

    for (const notification of notifications) {
      try { await processNotification(supabase, notification); }
      catch (err: any) { console.error('Error processing notification:', err.message); }
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 202, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('outlook-webhook error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function processNotification(supabase: any, notification: any) {
  const subscriptionId: string = notification.subscriptionId;
  const resourceUrl: string = notification.resource;
  if (!subscriptionId || !resourceUrl) return;

  const { data: account } = await supabase
    .from('integration_accounts')
    .select('id, owner_user_id, email_address, microsoft_user_id, access_token, refresh_token, token_expires_at')
    .eq('microsoft_subscription_id', subscriptionId).eq('is_active', true).maybeSingle();

  const integrationAccount = account ?? await (async () => {
    const { data } = await supabase.from('integration_accounts')
      .select('id, owner_user_id, email_address, microsoft_user_id, access_token, refresh_token, token_expires_at')
      .eq('webhook_subscription_id', subscriptionId).eq('is_active', true).maybeSingle();
    return data;
  })();

  if (!integrationAccount) {
    console.warn('No integration account found for subscriptionId:', subscriptionId); return;
  }

  const accessToken = await getValidToken(supabase, integrationAccount);
  if (!accessToken) { console.error('Could not obtain valid access token for account:', integrationAccount.id); return; }

  const messageIdMatch = resourceUrl.match(/Messages\/([^/]+)$/i);
  const messageId = messageIdMatch?.[1];
  if (!messageId) return;

  const msUserId = integrationAccount.microsoft_user_id;
  const msgRes = await graphGet(
    `${GRAPH_BASE}/users/${msUserId}/messages/${messageId}?$select=id,from,subject,receivedDateTime,body,toRecipients`,
    accessToken,
  );
  if (!msgRes) return;

  const senderEmail: string = msgRes.from?.emailAddress?.address?.toLowerCase().trim() ?? '';
  const senderName: string = msgRes.from?.emailAddress?.name ?? '';
  const subject: string = msgRes.subject ?? '';
  const bodyContent: string = msgRes.body?.content ?? '';
  const receivedAt: string = msgRes.receivedDateTime ?? new Date().toISOString();
  const bodyPreview = bodyContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);

  if (!senderEmail) return;

  const ourEmail = (integrationAccount.email_address ?? '').toLowerCase().trim();
  if (senderEmail === ourEmail) {
    console.log(`outlook-webhook: skipping outbound echo from ${senderEmail}`); return;
  }

  const { data: existingMsg } = await supabase.from('messages').select('id')
    .eq('provider_message_id', messageId).maybeSingle();
  if (existingMsg) { console.log(`outlook-webhook: duplicate message ${messageId}, skipping`); return; }

  const { data: candidateRow } = await supabase.from('candidates').select('id, full_name')
    .ilike('email', senderEmail).maybeSingle();
  const { data: contactRow } = !candidateRow
    ? await supabase.from('contacts').select('id, full_name').ilike('email', senderEmail).maybeSingle()
    : { data: null };

  const candidateId: string | null = candidateRow?.id ?? null;
  const contactId: string | null = contactRow?.id ?? null;
  const entityName: string = candidateRow?.full_name ?? contactRow?.full_name ?? senderName;

  console.log(`outlook-webhook: inbound from ${senderEmail} — candidate=${candidateId} contact=${contactId}`);

  const now = new Date().toISOString();
  let conversationId: string;

  const entityFilter = candidateId
    ? `candidate_id.eq.${candidateId}`
    : contactId ? `contact_id.eq.${contactId}` : null;

  if (entityFilter) {
    const { data: existingConv } = await supabase.from('conversations').select('id')
      .eq('channel', 'email').eq('integration_account_id', integrationAccount.id)
      .or(entityFilter).order('created_at', { ascending: false }).limit(1).maybeSingle();

    if (existingConv) {
      conversationId = existingConv.id;
      await supabase.from('conversations').update({
        last_message_preview: bodyPreview, last_message_at: receivedAt, is_read: false, updated_at: now,
      }).eq('id', conversationId);
    } else {
      const { data: newConv, error: convErr } = await supabase.from('conversations').insert({
        candidate_id: candidateId, contact_id: contactId, channel: 'email',
        integration_account_id: integrationAccount.id, last_message_preview: bodyPreview,
        last_message_at: receivedAt, is_read: false, is_archived: false,
        assigned_user_id: integrationAccount.owner_user_id ?? null, created_at: now, updated_at: now,
      }).select('id').single();
      conversationId = convErr || !newConv ? crypto.randomUUID() : newConv.id;
    }
  } else {
    conversationId = crypto.randomUUID();
  }

  const { error: insertErr } = await supabase.from('messages').insert({
    conversation_id: conversationId, candidate_id: candidateId, contact_id: contactId,
    integration_account_id: integrationAccount.id, channel: 'email', direction: 'inbound',
    topic: subject || '(no subject)', extension: 'email', subject: subject || '(no subject)',
    body: bodyContent, sender_address: senderEmail, recipient_address: ourEmail || null,
    provider_message_id: messageId, sent_at: receivedAt,
    is_read: false, updated_at: now, inserted_at: now, created_at: now,
  });

  if (insertErr) {
    console.error('outlook-webhook: message insert error:', insertErr.message);
  } else {
    console.log(`outlook-webhook: logged inbound email from ${senderEmail} conv=${conversationId}`);
  }

  await handleReplyStop(supabase, candidateId, contactId, senderEmail);

  // ── Claude sentiment analysis on inbound emails
  if (bodyContent.trim().length > 5 && (candidateId || contactId)) {
    const enrollmentId = await findActiveEnrollment(supabase, candidateId, contactId);
    const sentiment = await analyzeSentiment(bodyContent, 'email');
    if (sentiment) {
      await saveSentiment(supabase, {
        candidateId, contactId, enrollmentId, channel: 'email',
        sentiment: sentiment.sentiment, summary: sentiment.summary, rawMessage: bodyContent,
      });
      if (candidateId) {
        await supabase.from('candidates').update({
          last_sequence_sentiment: sentiment.sentiment,
          last_sequence_sentiment_note: sentiment.summary,
          updated_at: new Date().toISOString(),
        }).eq('id', candidateId).throwOnError().catch(() => {});
      } else if (contactId) {
        await supabase.from('contacts').update({
          last_sequence_sentiment: sentiment.sentiment,
          last_sequence_sentiment_note: sentiment.summary,
          updated_at: new Date().toISOString(),
        }).eq('id', contactId).throwOnError().catch(() => {});
      }
      console.log(`[sentiment] email ${candidateId ?? contactId} → ${sentiment.sentiment}: ${sentiment.summary}`);
    }
  }

  // Resume attachment handling
  if (candidateId) {
    const attachmentsRes = await graphGet(
      `${GRAPH_BASE}/users/${msUserId}/messages/${messageId}/attachments`, accessToken,
    );
    const attachments: any[] = attachmentsRes?.value ?? [];
    for (const attachment of attachments) {
      const name: string = attachment.name ?? '';
      if (!isResumeAttachment(name, entityName)) continue;
      const contentBytes: string = attachment.contentBytes;
      if (!contentBytes) continue;
      const bytes = base64ToUint8Array(contentBytes);
      await saveResume(supabase, candidateId, name, attachment.contentType ?? '', bytes);
    }
  }
}

async function handleReplyStop(supabase: any, candidateId: string | null, contactId: string | null, senderEmail: string) {
  const filters: Array<{ col: string; val: string }> = [];
  if (candidateId) filters.push({ col: 'candidate_id', val: candidateId });
  if (contactId) filters.push({ col: 'contact_id', val: contactId });
  for (const { col, val } of filters) {
    const { data: enrollments } = await supabase.from('sequence_enrollments')
      .select('id, sequence_id').eq(col, val).eq('status', 'active');
    for (const e of enrollments ?? []) {
      const { data: seq } = await supabase.from('sequences').select('stop_on_reply').eq('id', e.sequence_id).maybeSingle();
      if (seq?.stop_on_reply !== false) {
        await supabase.from('sequence_enrollments').update({
          status: 'stopped', stopped_reason: 'reply_received_email', updated_at: new Date().toISOString(),
        }).eq('id', e.id);
        console.log(`outlook-webhook: reply-stop enrollment ${e.id} (sender=${senderEmail})`);
      }
    }
  }
}

async function getValidToken(supabase: any, account: any): Promise<string | null> {
  const now = Date.now();
  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  if (account.access_token && expiresAt > now + 5 * 60 * 1000) return account.access_token;
  if (!account.refresh_token) return account.access_token ?? null;
  const email = (account.email_address ?? '').toLowerCase().trim();
  const { clientId, clientSecret, tenantId } = getCredsForEmail(email);
  if (!clientId || !clientSecret) { console.error('outlook-webhook: missing OAuth creds for', email); return account.access_token ?? null; }
  const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: account.refresh_token, scope: 'https://graph.microsoft.com/.default offline_access' }),
  });
  if (!tokenRes.ok) { console.error('outlook-webhook: token refresh failed:', await tokenRes.text()); return account.access_token ?? null; }
  const tokenData = await tokenRes.json();
  const newExpiry = new Date(now + tokenData.expires_in * 1000).toISOString();
  await supabase.from('integration_accounts').update({
    access_token: tokenData.access_token, refresh_token: tokenData.refresh_token ?? account.refresh_token, token_expires_at: newExpiry,
  }).eq('id', account.id);
  return tokenData.access_token;
}

async function graphGet(url: string, accessToken: string): Promise<any | null> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
  if (!res.ok) { console.error('Graph API error:', res.status, await res.text()); return null; }
  return res.json();
}

function isResumeAttachment(filename: string, entityName: string): boolean {
  if (!RESUME_EXT_RE.test(filename)) return false;
  if (RESUME_FILENAME_RE.test(filename)) return true;
  if (entityName) {
    const nameParts = entityName.toLowerCase().split(/\s+/);
    const filenameLower = filename.toLowerCase();
    if (nameParts.some((part) => part.length > 2 && filenameLower.includes(part))) return true;
  }
  return false;
}

async function saveResume(supabase: any, candidateId: string, filename: string, contentType: string, bytes: Uint8Array) {
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = `${candidateId}/${safeFilename}`;
  const { error: uploadErr } = await supabase.storage.from('resumes').upload(filePath, bytes, { contentType: contentType || 'application/octet-stream', upsert: true });
  if (uploadErr) { console.error('Storage upload error:', uploadErr); return; }
  const { data: urlData } = supabase.storage.from('resumes').getPublicUrl(filePath);
  const publicUrl = urlData?.publicUrl ?? '';
  const { data: resumeRow, error: insertErr } = await supabase.from('resumes')
    .insert({ candidate_id: candidateId, file_path: filePath, file_name: filename, parsing_status: 'pending' })
    .select('id').single();
  if (insertErr) { console.error('Failed to insert resumes row:', insertErr); return; }
  await supabase.from('candidates').update({ resume_url: publicUrl }).eq('id', candidateId);
  await triggerParseResume(supabase, candidateId, resumeRow.id, filename, contentType, bytes);
}

async function triggerParseResume(supabase: any, candidateId: string, resumeId: string, filename: string, contentType: string, bytes: Uint8Array) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  try {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: contentType || 'application/pdf' }), filename);
    const res = await fetch(`${supabaseUrl}/functions/v1/parse-resume`, {
      method: 'POST', headers: { Authorization: `Bearer ${serviceKey}` }, body: form,
    });
    if (!res.ok) { await supabase.from('resumes').update({ parsing_status: 'error' }).eq('id', resumeId); return; }
    const parsed = await res.json();
    const data = parsed.parsed ?? {};
    await supabase.from('resumes').update({ parsing_status: 'complete', raw_text: data.raw_text ?? null, parsed_json: data }).eq('id', resumeId);
    const updates: Record<string, any> = {};
    if (data.current_title) updates.current_title = data.current_title;
    if (data.current_company) updates.current_company = data.current_company;
    if (data.linkedin_url) updates.linkedin_url = data.linkedin_url;
    if (Object.keys(updates).length > 0) await supabase.from('candidates').update(updates).eq('id', candidateId);
  } catch (err: any) {
    await supabase.from('resumes').update({ parsing_status: 'error' }).eq('id', resumeId);
  }
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
