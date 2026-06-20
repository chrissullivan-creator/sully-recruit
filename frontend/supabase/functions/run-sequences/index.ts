import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MICROSOFT_CLIENT_ID = Deno.env.get("MICROSOFT_CLIENT_ID");
const MICROSOFT_CLIENT_SECRET = Deno.env.get("MICROSOFT_CLIENT_SECRET");
const MICROSOFT_TENANT_ID = Deno.env.get("MICROSOFT_TENANT_ID") || "common";
const MICROSOFT_GRAPH_CLIENT_ID = Deno.env.get("MICROSOFT_GRAPH_CLIENT_ID");
const MICROSOFT_GRAPH_CLIENT_SECRET = Deno.env.get("MICROSOFT_GRAPH_CLIENT_SECRET");
const MICROSOFT_GRAPH_TENANT_ID = Deno.env.get("MICROSOFT_GRAPH_TENANT_ID") || "common";
const MICROSOFT_GRAPH_ACCOUNT_EMAILS = Deno.env.get("MICROSOFT_GRAPH_ACCOUNT_EMAILS") || "";
const UNIPILE_API_URL = Deno.env.get("UNIPILE_API_URL") || "https://api2.unipile.com:13080";
const UNIPILE_API_KEY = Deno.env.get("UNIPILE_API_KEY") || "";
const RC_CLIENT_ID = Deno.env.get("RC_CLIENT_ID") || "";
const RC_CLIENT_SECRET = Deno.env.get("RC_CLIENT_SECRET") || "";
const RC_SERVER = Deno.env.get("RC_SERVER") || "https://platform.ringcentral.com";

const CHICAGO_TZ = "America/Chicago";
const WINDOW_START_HOUR = 4, WINDOW_START_MIN = 30;
const WINDOW_END_HOUR = 21, WINDOW_END_MIN = 30;
const SMS_WINDOW_END_HOUR = 20, SMS_WINDOW_END_MIN = 0;
const SMS_BATCH_SIZE = 10;
const SMS_BATCH_INTERVAL_MIN = 5;
const EMAIL_DAILY_MAX = 150;
const EMAIL_MIN_INTERVAL = 3, EMAIL_MAX_INTERVAL = 15;
const LI_CONNECTION_DAILY_MAX = 30, LI_MESSAGE_DAILY_MAX = 40;
const LI_MIN_INTERVAL = 5, LI_MAX_INTERVAL = 20;
const SMS_DAILY_MAX = 100;
const BATCH_LIMIT = 50;

const CONNECTION_STEP_TYPES = ["connection_request","send_connection","linkedin_connection"];
const INMAIL_STEP_TYPES = ["inmail","recruiter_inmail","sales_nav_inmail","linkedin_inmail"];
const CREDIT_ERROR_TYPES = ["errors/insufficient_credits","errors/limit_exceeded","errors/not_allowed_inmail"];
function isCreditError(e: string | null | undefined) { return !!e && CREDIT_ERROR_TYPES.some(t => e.includes(t)); }

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };

type IntegrationAccount = {
  id: string; email_address: string | null; account_label: string | null;
  auth_provider: string | null; unipile_account_id: string | null; unipile_provider: string | null;
  linkedin_capability: string | null;
  is_active: boolean; access_token: string | null; refresh_token: string | null;
  token_expires_at: string | null; next_available_send_at: string | null;
  daily_send_limit: number | null; linkedin_daily_connection_limit: number | null;
  linkedin_daily_message_limit: number | null; linkedin_next_available_send_at: string | null;
  linkedin_next_available_connection_at: string | null;
  rc_phone_number: string | null; rc_jwt: string | null; rc_extension: string | null;
  owner_user_id: string | null;
};
type SequenceStep = {
  id: string; sequence_id: string; step_order: number; channel: string; step_type: string;
  delay_days: number | null; delay_hours: number | null; delay_minutes: number | null;
  subject: string | null; body: string | null; is_active: boolean;
  jitter_min_minutes?: number; jitter_max_minutes?: number; inter_message_jitter_minutes?: number;
  post_connect_delay_hours?: number; post_connect_jitter_min?: number; post_connect_jitter_max?: number;
  respect_send_window?: boolean;
};
// Column names: unipile_sales_nav_id | unipile_recruiter_id | unipile_classic_id
type Candidate = {
  id: string; first_name: string | null; last_name: string | null; full_name: string | null;
  email: string | null; phone: string | null; linkedin_url: string | null;
  unipile_sales_nav_id: string | null;  // Chris (ACw)
  unipile_recruiter_id: string | null;  // Nancy (ACw)
  unipile_classic_id: string | null;    // Ashley (ACo)
  current_title: string | null; current_company: string | null;
};
type AccountRunState = {
  emailSentThisRun: number; emailSentToday: number; lastEmailSentAt: Date | null;
  liMessagesSentThisRun: number; liMessagesSentToday: number;
  liConnectionsSentThisRun: number; liConnectionsSentToday: number;
  lastLiSentAt: Date | null; lastLiConnectionAt: Date | null;
  smsSentThisRun: number; smsSentToday: number; lastSmsSentAt: Date | null;
  smsSentThisBatch: number; smsBatchStartAt: Date | null;
};

function randomInt(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
function normKey(r: string) { return r.toLowerCase().replace(/[\s_]+/g, ""); }
function renderTemplate(t: string | null, c: Candidate): string {
  const body = t ?? "";
  const fn = c.first_name?.trim() || c.full_name?.split(" ")[0] || "there";
  const ln = c.last_name?.trim() || "";
  const full = c.full_name?.trim() || [c.first_name, c.last_name].filter(Boolean).join(" ") || "there";
  const title = c.current_title?.trim() || ""; const co = c.current_company?.trim() || "";
  const v: Record<string,string> = { firstname: fn, lastname: ln, fullname: full, name: full, title, jobtitle: title, company: co, currentcompany: co };
  return body.replace(/\{\{([^}]+)\}\}/g, (_m, r: string) => v[normKey(r.trim())] ?? _m);
}

const sigCache = new Map<string, string | null>();
async function getSignature(uid: string | null): Promise<string | null> {
  if (!uid) return null;
  if (sigCache.has(uid)) return sigCache.get(uid) ?? null;
  const { data } = await supabase.from("profiles").select("email_signature").eq("id", uid).maybeSingle();
  const sig = data?.email_signature ?? null; sigCache.set(uid, sig); return sig;
}
function appendSig(body: string, sig: string | null) { return sig ? `${body}<br/><br/><hr style="border:none;border-top:1px solid #e0e0e0;margin:16px 0;"/>${sig}` : body; }

function chicagoTime(d: Date) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: CHICAGO_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const m = Object.fromEntries(p.map(x => [x.type, x.value]));
  return { h: Number(m.hour === "24" ? "0" : m.hour), min: Number(m.minute) };
}
function inWindow(d: Date) { const { h, min } = chicagoTime(d); const t = h*60+min; return t >= WINDOW_START_HOUR*60+WINDOW_START_MIN && t < WINDOW_END_HOUR*60+WINDOW_END_MIN; }
function inSmsWindow(d: Date) { const { h, min } = chicagoTime(d); const t = h*60+min; return t >= WINDOW_START_HOUR*60+WINDOW_START_MIN && t < SMS_WINDOW_END_HOUR*60+SMS_WINDOW_END_MIN; }
function enforceWindow(d: Date): Date {
  let x = new Date(d); const s=WINDOW_START_HOUR*60+WINDOW_START_MIN, e=WINDOW_END_HOUR*60+WINDOW_END_MIN;
  for (let i=0;i<3;i++) { const {h,min}=chicagoTime(x); const t=h*60+min; if(t>=s&&t<e) return x; x=t<s?new Date(x.getTime()+(s-t)*60000):new Date(x.getTime()+(1440-t+s)*60000); } return x;
}
function enforceSmsWindow(d: Date): Date {
  let x = new Date(d); const s=WINDOW_START_HOUR*60+WINDOW_START_MIN, e=SMS_WINDOW_END_HOUR*60+SMS_WINDOW_END_MIN;
  for (let i=0;i<3;i++) { const {h,min}=chicagoTime(x); const t=h*60+min; if(t>=s&&t<e) return x; x=t<s?new Date(x.getTime()+(s-t)*60000):new Date(x.getTime()+(1440-t+s)*60000); } return x;
}
function chiOffset(d: Date) {
  const p = new Intl.DateTimeFormat("en-US",{timeZone:CHICAGO_TZ,timeZoneName:"shortOffset",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(d);
  const tz = p.find(x=>x.type==="timeZoneName")?.value??"GMT-6"; const m=tz.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if(!m) return -360; return (m[1]==="-"?-1:1)*(Number(m[2])*60+Number(m[3]??"-0"));
}
function startOfChicagoDay(now: Date): Date {
  const f=new Intl.DateTimeFormat("en-US",{timeZone:CHICAGO_TZ,year:"numeric",month:"2-digit",day:"2-digit"});
  const cp=Object.fromEntries(f.formatToParts(now).map(p=>[p.type,p.value]));
  return new Date(new Date(`${cp.year}-${cp.month}-${cp.day}T00:00:00`).getTime()-chiOffset(now)*60000);
}

async function loadRunState(ia: IntegrationAccount, cache: Map<string,AccountRunState>): Promise<AccountRunState> {
  if (cache.has(ia.id)) return cache.get(ia.id)!;
  const now=new Date(), sod=startOfChicagoDay(now);
  const {count:emailSentToday}=await supabase.from("messages").select("id",{count:"exact",head:true}).eq("channel","email").eq("direction","outbound").eq("sender_address",ia.email_address??"").gte("sent_at",sod.toISOString());
  const {count:liMsgToday}=await supabase.from("messages").select("id",{count:"exact",head:true}).in("channel",["linkedin","linkedin_recruiter","linkedin_sales_nav"]).eq("direction","outbound").eq("integration_account_id",ia.id).gte("sent_at",sod.toISOString());
  const {count:liConnToday}=await supabase.from("sequence_step_executions").select("id",{count:"exact",head:true}).eq("status","sent").in("channel",["linkedin","linkedin_recruiter","linkedin_sales_nav"]).in("step_type",CONNECTION_STEP_TYPES).gte("executed_at",sod.toISOString());
  const {count:smsToday}=await supabase.from("messages").select("id",{count:"exact",head:true}).eq("channel","sms").eq("direction","outbound").eq("integration_account_id",ia.id).gte("sent_at",sod.toISOString());
  const bw=new Date(now.getTime()-SMS_BATCH_INTERVAL_MIN*60000);
  const {data:rs}=await supabase.from("messages").select("sent_at").eq("channel","sms").eq("direction","outbound").eq("integration_account_id",ia.id).gte("sent_at",bw.toISOString()).order("sent_at",{ascending:true});
  const st: AccountRunState = { emailSentThisRun:0,emailSentToday:emailSentToday??0,lastEmailSentAt:null, liMessagesSentThisRun:0,liMessagesSentToday:liMsgToday??0, liConnectionsSentThisRun:0,liConnectionsSentToday:liConnToday??0, lastLiSentAt:null,lastLiConnectionAt:null, smsSentThisRun:0,smsSentToday:smsToday??0,lastSmsSentAt:null, smsSentThisBatch:rs?.length??0,smsBatchStartAt:rs?.length?new Date(rs[0].sent_at):null };
  cache.set(ia.id,st); return st;
}

function nextEmail(s: AccountRunState) { return s.lastEmailSentAt ? enforceWindow(new Date(s.lastEmailSentAt.getTime()+randomInt(EMAIL_MIN_INTERVAL,EMAIL_MAX_INTERVAL)*60000)) : null; }
function nextLiMsg(s: AccountRunState) { return s.lastLiSentAt ? enforceWindow(new Date(s.lastLiSentAt.getTime()+randomInt(LI_MIN_INTERVAL,LI_MAX_INTERVAL)*60000)) : null; }
function nextLiConn(s: AccountRunState) { return s.lastLiConnectionAt ? new Date(s.lastLiConnectionAt.getTime()+randomInt(10,30)*60000) : null; }
function nextSms(s: AccountRunState, now: Date) {
  if (s.smsSentThisBatch+s.smsSentThisRun < SMS_BATCH_SIZE) return null;
  return enforceSmsWindow(new Date((s.smsBatchStartAt??now).getTime()+SMS_BATCH_INTERVAL_MIN*60000));
}

function graphEmails() { return new Set(MICROSOFT_GRAPH_ACCOUNT_EMAILS.split(",").map(s=>s.trim().toLowerCase()).filter(Boolean)); }
async function refreshMs(a: IntegrationAccount): Promise<IntegrationAccount> {
  if (!a.refresh_token) throw new Error(`No refresh_token for ${a.email_address}`);
  const email=(a.email_address??"").toLowerCase().trim(), useG=graphEmails().has(email);
  const cid=useG?MICROSOFT_GRAPH_CLIENT_ID:MICROSOFT_CLIENT_ID, cs=useG?MICROSOFT_GRAPH_CLIENT_SECRET:MICROSOFT_CLIENT_SECRET, tid=useG?MICROSOFT_GRAPH_TENANT_ID:MICROSOFT_TENANT_ID;
  if(!cid||!cs) throw new Error(`Missing MS creds for ${email}`);
  const r=await fetch(`https://login.microsoftonline.com/${tid}/oauth2/v2.0/token`,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:cid,client_secret:cs,grant_type:"refresh_token",refresh_token:a.refresh_token,scope:"offline_access Mail.Send Mail.Read User.Read openid profile"})});
  const d:Record<string,unknown>=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(String(d?.error_description??`Token refresh ${r.status}`));
  const exp=new Date(Date.now()+Number(d?.expires_in??3600)*1000).toISOString();
  const {data:up,error:ue}=await supabase.from("integration_accounts").update({access_token:d.access_token,refresh_token:d.refresh_token??a.refresh_token,token_expires_at:exp,updated_at:new Date().toISOString()}).eq("id",a.id).select("*").single();
  if(ue||!up) throw new Error(`Save token: ${ue?.message}`); return up as IntegrationAccount;
}
async function validMsToken(a: IntegrationAccount) {
  let x=a; if(!x.access_token||!x.token_expires_at||new Date(x.token_expires_at).getTime()-Date.now()<5*60000) x=await refreshMs(x);
  if(!x.access_token) throw new Error(`No token ${x.email_address}`); return {a:x,tok:x.access_token};
}
async function sendEmail(p:{toEmail:string;subject:string;body:string;account:IntegrationAccount;replyTo?:string|null;threadSubj?:string|null}):Promise<{ok:boolean;msgId?:string;error?:string}> {
  const {a,tok}=await validMsToken(p.account); if(!a.email_address) return {ok:false,error:"no sender"};
  const B="https://graph.microsoft.com/v1.0/me";
  if(p.replyTo) {
    const rs=p.threadSubj?(p.threadSubj.startsWith("Re:")?p.threadSubj:`Re: ${p.threadSubj}`):p.subject;
    const dr=await fetch(`${B}/messages/${p.replyTo}/createReply`,{method:"POST",headers:{Authorization:`Bearer ${tok}`,"Content-Type":"application/json"},body:JSON.stringify({})});
    if(!dr.ok){const t=await dr.text();console.error("createReply",dr.status,t);return sendEmailNew({to:p.toEmail,subj:rs,body:p.body,tok,B});}
    const dft=await dr.json(); const did=dft.id as string;
    await fetch(`${B}/messages/${did}`,{method:"PATCH",headers:{Authorization:`Bearer ${tok}`,"Content-Type":"application/json"},body:JSON.stringify({body:{contentType:"HTML",content:p.body},toRecipients:[{emailAddress:{address:p.toEmail}}]})});
    const sr=await fetch(`${B}/messages/${did}/send`,{method:"POST",headers:{Authorization:`Bearer ${tok}`}});
    if(!sr.ok){const t=await sr.text();return {ok:false,error:`reply send ${sr.status}: ${t}`};}
    return {ok:true,msgId:did};
  }
  return sendEmailNew({to:p.toEmail,subj:p.subject,body:p.body,tok,B});
}
async function sendEmailNew(p:{to:string;subj:string;body:string;tok:string;B:string}):Promise<{ok:boolean;msgId?:string;error?:string}> {
  const dr=await fetch(`${p.B}/messages`,{method:"POST",headers:{Authorization:`Bearer ${p.tok}`,"Content-Type":"application/json"},body:JSON.stringify({subject:p.subj||"(no subject)",body:{contentType:"HTML",content:p.body},toRecipients:[{emailAddress:{address:p.to}}]})});
  if(!dr.ok){const t=await dr.text();return {ok:false,error:`draft ${dr.status}: ${t}`};}
  const dft=await dr.json(); const did=dft.id as string;
  const sr=await fetch(`${p.B}/messages/${did}/send`,{method:"POST",headers:{Authorization:`Bearer ${p.tok}`}});
  if(!sr.ok){const t=await sr.text();return {ok:false,error:`send ${sr.status}: ${t}`};}
  return {ok:true,msgId:did};
}
async function rcToken(jwt:string):Promise<string> {
  const creds=btoa(`${RC_CLIENT_ID}:${RC_CLIENT_SECRET}`);
  const r=await fetch(`${RC_SERVER}/restapi/oauth/token`,{method:"POST",headers:{Authorization:`Basic ${creds}`,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:jwt})});
  const d:Record<string,unknown>=await r.json().catch(()=>({})); if(!r.ok) throw new Error(`RC token ${r.status}: ${JSON.stringify(d)}`); return d.access_token as string;
}
async function sendSMS(p:{from:string;to:string;text:string;jwt:string}):Promise<{ok:boolean;id?:string;error?:string}> {
  let tok:string; try{tok=await rcToken(p.jwt);}catch(e){return {ok:false,error:e instanceof Error?e.message:"RC fail"};}
  const r=await fetch(`${RC_SERVER}/restapi/v1.0/account/~/extension/~/sms`,{method:"POST",headers:{Authorization:`Bearer ${tok}`,"Content-Type":"application/json"},body:JSON.stringify({from:{phoneNumber:p.from},to:[{phoneNumber:p.to}],text:p.text})});
  const d:Record<string,unknown>=await r.json().catch(()=>({})); if(!r.ok) return {ok:false,error:`RC SMS ${r.status}: ${JSON.stringify(d)}`}; return {ok:true,id:d.id as string};
}

const uniH = () => ({ "X-API-KEY": UNIPILE_API_KEY, "Content-Type": "application/json", "Accept": "application/json" });

/**
 * Capability-aware recipient ID resolver.
 * Column mapping:
 *   sales_nav → unipile_sales_nav_id (ACw, Chris)
 *   recruiter → unipile_recruiter_id (ACw, Nancy)
 *   classic   → unipile_classic_id   (ACo, Ashley)
 */
async function resolveRecipientId(ia: IntegrationAccount, c: Candidate, isContact: boolean): Promise<string | null> {
  const cap = ia.linkedin_capability ?? "sales_nav";
  const stored = cap==="recruiter" ? c.unipile_recruiter_id : cap==="classic" ? c.unipile_classic_id : c.unipile_sales_nav_id;
  if (stored) return stored;
  if (!c.linkedin_url || !UNIPILE_API_KEY || !ia.unipile_account_id) return null;
  const m = c.linkedin_url.replace(/\/+$/,"").match(/linkedin\.com\/in\/([^/?\s#]+)/);
  const slug = m?.[1];
  if (!slug||slug.startsWith("ACo")||slug.startsWith("ACw")||slug.startsWith("acw")) return null;
  const r = await fetch(`${UNIPILE_API_URL}/api/v1/users/${encodeURIComponent(slug)}?account_id=${ia.unipile_account_id}`,{headers:uniH()});
  if (!r.ok) return null;
  const p: Record<string,unknown> = await r.json().catch(()=>({}));
  if (p.is_self===true) return null;
  const uid = (p.provider_id??p.id??null) as string|null;
  if (uid) {
    const col = cap==="recruiter" ? "unipile_recruiter_id" : cap==="classic" ? "unipile_classic_id" : "unipile_sales_nav_id";
    const tbl = isContact ? "contacts" : "candidates";
    await supabase.from(tbl).update({[col]:uid,updated_at:new Date().toISOString()}).eq("id",c.id);
    console.log(`[resolve] ${tbl} ${c.id} ${col}=${uid} (${cap})`);
  }
  return uid;
}

async function connStatus(ia: IntegrationAccount, rid: string): Promise<"connected"|"pending"|"not_connected"> {
  if (!UNIPILE_API_KEY) return "not_connected";
  const r=await fetch(`${UNIPILE_API_URL}/api/v1/linkedin/relations/${rid}?account_id=${ia.unipile_account_id}`,{headers:uniH()}); if(!r.ok) return "not_connected";
  const d:Record<string,unknown>=await r.json().catch(()=>({})); const s=String(d.status??d.connection_status??"").toLowerCase();
  return s.includes("connect")&&!s.includes("pending")?"connected":s.includes("pending")?"pending":"not_connected";
}
async function sendConnReq(ia: IntegrationAccount, rid: string, msg?: string): Promise<{ok:boolean;error?:string}> {
  if (!UNIPILE_API_KEY) return {ok:false,error:"no key"};
  const b:Record<string,unknown>={account_id:ia.unipile_account_id,provider_id:rid}; if(msg) b.message=msg;
  const r=await fetch(`${UNIPILE_API_URL}/api/v1/linkedin/relations`,{method:"POST",headers:uniH(),body:JSON.stringify(b)});
  const d:Record<string,unknown>=await r.json().catch(()=>({})); if(!r.ok) return {ok:false,error:`Unipile ${r.status}: ${JSON.stringify(d)}`}; return {ok:true};
}
async function sendLiMsg(ia: IntegrationAccount, rid: string, msg: string, chatId?: string|null): Promise<{ok:boolean;chatId?:string;msgId?:string;error?:string}> {
  if (!UNIPILE_API_KEY) return {ok:false,error:"no key"};
  if (chatId) {
    const r=await fetch(`${UNIPILE_API_URL}/api/v1/chats/${chatId}/messages`,{method:"POST",headers:uniH(),body:JSON.stringify({account_id:ia.unipile_account_id,text:msg})});
    const d:Record<string,unknown>=await r.json().catch(()=>({})); if(!r.ok) return {ok:false,error:`Unipile ${r.status}: ${JSON.stringify(d)}`};
    return {ok:true,chatId,msgId:(d.id??d.message_id??null) as string};
  }
  const r=await fetch(`${UNIPILE_API_URL}/api/v1/chats`,{method:"POST",headers:uniH(),body:JSON.stringify({account_id:ia.unipile_account_id,attendees_ids:[rid],text:msg})});
  const d:Record<string,unknown>=await r.json().catch(()=>({})); if(!r.ok) return {ok:false,error:`Unipile ${r.status}: ${JSON.stringify(d)}`};
  return {ok:true,chatId:(d.chat_id??d.id??null) as string,msgId:(d.message_id??null) as string};
}
async function sendInMail(ia: IntegrationAccount, rid: string, subj: string|null, msg: string): Promise<{ok:boolean;chatId?:string;error?:string}> {
  if (!UNIPILE_API_KEY) return {ok:false,error:"no key"};
  const p:Record<string,unknown>={account_id:ia.unipile_account_id,attendees_ids:[rid],text:msg,linkedin:{inmail:true}}; if(subj) p.subject=subj;
  const r=await fetch(`${UNIPILE_API_URL}/api/v1/chats`,{method:"POST",headers:uniH(),body:JSON.stringify(p)});
  const d:Record<string,unknown>=await r.json().catch(()=>({})); if(!r.ok) return {ok:false,error:`InMail ${r.status}: ${JSON.stringify(d)}`};
  return {ok:true,chatId:(d.chat_id??d.id??null) as string};
}

async function getAccount(id: string): Promise<IntegrationAccount | null> {
  const {data}=await supabase.from("integration_accounts").select("id,email_address,account_label,auth_provider,unipile_account_id,unipile_provider,linkedin_capability,is_active,access_token,refresh_token,token_expires_at,next_available_send_at,daily_send_limit,linkedin_daily_connection_limit,linkedin_daily_message_limit,linkedin_next_available_send_at,linkedin_next_available_connection_at,rc_phone_number,rc_jwt,rc_extension,owner_user_id").eq("id",id).eq("is_active",true).maybeSingle();
  return (data as IntegrationAccount|null)??null;
}
async function getRCForUser(uid: string): Promise<IntegrationAccount | null> {
  const {data}=await supabase.from("integration_accounts").select("id,email_address,account_label,auth_provider,rc_phone_number,rc_jwt,rc_extension,owner_user_id,is_active,daily_send_limit").eq("owner_user_id",uid).eq("provider","sms").eq("auth_provider","ringcentral").eq("is_active",true).maybeSingle();
  return (data as IntegrationAccount|null)??null;
}
async function getCandidate(id: string): Promise<Candidate | null> {
  const {data}=await supabase.from("candidates").select("id,first_name,last_name,full_name,email,phone,linkedin_url,unipile_sales_nav_id,unipile_recruiter_id,unipile_classic_id,current_title,current_company").eq("id",id).maybeSingle();
  return (data as Candidate|null)??null;
}
async function getContactAsCandidate(id: string): Promise<Candidate | null> {
  const {data,error}=await supabase.from("contacts").select("id,first_name,last_name,email,phone,linkedin_url,title,company_name,unipile_sales_nav_id,unipile_recruiter_id,unipile_classic_id").eq("id",id).maybeSingle();
  if(error) console.error("[getContact] error:",error.message); if(!data) return null;
  const c=data as Record<string,unknown>;
  return { id:c.id as string, first_name:(c.first_name??null) as string|null, last_name:(c.last_name??null) as string|null, full_name:[c.first_name,c.last_name].filter(Boolean).join(" ")||null, email:(c.email??null) as string|null, phone:(c.phone??null) as string|null, linkedin_url:(c.linkedin_url??null) as string|null, unipile_sales_nav_id:(c.unipile_sales_nav_id??null) as string|null, unipile_recruiter_id:(c.unipile_recruiter_id??null) as string|null, unipile_classic_id:(c.unipile_classic_id??null) as string|null, current_title:(c.title??null) as string|null, current_company:(c.company_name??null) as string|null };
}

async function getStep(seqId: string, order: number): Promise<SequenceStep | null> {
  if (order===0) { const {data}=await supabase.from("sequence_steps").select("*").eq("sequence_id",seqId).eq("is_active",true).order("step_order",{ascending:true}).limit(1).maybeSingle(); return (data as SequenceStep|null)??null; }
  const {data}=await supabase.from("sequence_steps").select("*").eq("sequence_id",seqId).eq("step_order",order).eq("is_active",true).maybeSingle();
  return (data as SequenceStep|null)??null;
}
async function nextStep(seqId: string, cur: number): Promise<SequenceStep | null> {
  const {data}=await supabase.from("sequence_steps").select("*").eq("sequence_id",seqId).eq("is_active",true).gt("step_order",cur).order("step_order",{ascending:true}).limit(1).maybeSingle();
  return (data as SequenceStep|null)??null;
}
async function logExec(p:{eid:string;seqId:string;entityId:string;isContact:boolean;step:SequenceStep;status:"sent"|"failed"|"skipped";err?:string|null}): Promise<void> {
  const now=new Date().toISOString();
  const d:Record<string,unknown>={enrollment_id:p.eid,sequence_id:p.seqId,sequence_step_id:p.step.id,step_id:p.step.id,step_order:p.step.step_order,channel:p.step.channel,step_type:p.step.step_type,status:p.status,error_message:p.err??null,executed_at:now,created_at:now};
  if(p.isContact) d.contact_id=p.entityId; else d.candidate_id=p.entityId;
  const {error}=await supabase.from("sequence_step_executions").insert(d); if(error) console.error("[log]",error.message);
}
async function insertEmailMsg(p:{cId:string|null;ctId:string|null;iaId:string;from:string;to:string;subj:string;body:string;convId:string}): Promise<void> {
  const now=new Date().toISOString();
  const {error}=await supabase.from("messages").insert({conversation_id:p.convId,candidate_id:p.cId??null,contact_id:p.ctId??null,channel:"email",direction:"outbound",topic:p.subj||"(no subject)",extension:"email",subject:p.subj||"(no subject)",body:p.body,sender_address:p.from,recipient_address:p.to,integration_account_id:p.iaId,sent_at:now,is_read:true,updated_at:now,inserted_at:now,created_at:now});
  if(error) console.error("[email msg]",error.message);
}
async function insertSmsMsg(p:{cId:string|null;ctId:string|null;iaId:string;from:string;to:string;body:string;id?:string}): Promise<void> {
  const now=new Date().toISOString();
  const {error}=await supabase.from("messages").insert({conversation_id:crypto.randomUUID(),candidate_id:p.cId??null,contact_id:p.ctId??null,channel:"sms",direction:"outbound",topic:"SMS",extension:"sms",body:p.body,sender_address:p.from,recipient_address:p.to,integration_account_id:p.iaId,provider_message_id:p.id??null,sent_at:new Date().toISOString(),is_read:true,updated_at:new Date().toISOString(),inserted_at:new Date().toISOString(),created_at:new Date().toISOString()});
  if(error) console.error("[sms msg]",error.message);
}
async function insertLiMsg(p:{cId:string|null;ctId:string|null;iaId:string;channel:string;body:string;chatId?:string|null;msgId?:string|null;convId:string}): Promise<void> {
  const now=new Date().toISOString();
  const {error}=await supabase.from("messages").insert({conversation_id:p.convId,candidate_id:p.cId??null,contact_id:p.ctId??null,channel:p.channel,direction:"outbound",topic:p.channel,extension:p.channel,body:p.body,integration_account_id:p.iaId,unipile_message_id:p.msgId??null,unipile_chat_id:p.chatId??null,sent_at:now,is_read:true,updated_at:now,inserted_at:now,created_at:now});
  if(error) console.error("[li msg]",error.message);
}
async function createCallTask(p:{cId:string|null;ctId:string|null;eid:string;assignTo:string|null;name:string;phone:string|null;body:string|null}): Promise<void> {
  const due=enforceWindow(new Date(Date.now()+30*60000)); const now=new Date().toISOString();
  await supabase.from("tasks").insert({title:`Call ${p.name}${p.phone?` — ${p.phone}`:""}`,description:p.body||`Follow up call with ${p.name} as part of sequence.`,status:"open",priority:"high",due_date:due.toISOString(),assigned_to:p.assignTo,source_type:"sequence_enrollment",source_id:p.eid,created_at:now,updated_at:now});
}

async function advance(eid: string, seqId: string, cur: SequenceStep, anchor: Date, opts?: {jitter?:boolean}): Promise<void> {
  const ns=await nextStep(seqId,cur.step_order);
  if (!ns) { await supabase.from("sequence_enrollments").update({status:"completed",completed_at:new Date().toISOString(),next_step_at:null,staggered_at:null,updated_at:new Date().toISOString()}).eq("id",eid); return; }
  const t=new Date(anchor); t.setUTCDate(t.getUTCDate()+(ns.delay_days??0)); t.setUTCHours(t.getUTCHours()+(ns.delay_hours??0)); t.setUTCMinutes(t.getUTCMinutes()+(ns.delay_minutes??0));
  const j=randomInt(ns.jitter_min_minutes??2,ns.jitter_max_minutes??35)*60000;
  let inter=0; if(opts?.jitter){const jm=cur.inter_message_jitter_minutes??43; inter=(randomInt(0,1)===0?1:-1)*randomInt(0,jm)*60000;}
  const raw=Math.max(t.getTime(),Date.now()+30000)+j+inter; const ct=new Date(raw);
  const isConn=CONNECTION_STEP_TYPES.includes((ns.step_type??"").toLowerCase()); const isSms=ns.channel==="sms";
  const fin=isSms?enforceSmsWindow(ct):(ns.respect_send_window!==false&&!isConn?enforceWindow(ct):ct);
  await supabase.from("sequence_enrollments").update({current_step_order:ns.step_order,next_step_at:fin.toISOString(),staggered_at:null,waiting_for_connection_acceptance:false,updated_at:new Date().toISOString()}).eq("id",eid);
}
async function stop(eid: string, reason: string) { await supabase.from("sequence_enrollments").update({status:"stopped",stopped_reason:reason,staggered_at:null,updated_at:new Date().toISOString()}).eq("id",eid); }
async function backoff(eid: string, hrs=6) { await supabase.from("sequence_enrollments").update({next_step_at:new Date(Date.now()+hrs*3600000).toISOString(),updated_at:new Date().toISOString()}).eq("id",eid); }

async function hasReplied(cId:string|null,ctId:string|null,email:string|null,since:string): Promise<boolean> {
  if(cId){const{data}=await supabase.from("messages").select("id").eq("candidate_id",cId).eq("direction","inbound").gt("created_at",since).limit(1); if(data?.length) return true;}
  if(ctId){const{data}=await supabase.from("messages").select("id").eq("contact_id",ctId).eq("direction","inbound").gt("created_at",since).limit(1); if(data?.length) return true;}
  if(email){const{data}=await supabase.from("messages").select("id").ilike("sender_address",email).eq("direction","inbound").gt("created_at",since).limit(1); if(data?.length) return true;}
  return false;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method==="OPTIONS") return new Response(null,{headers:corsHeaders});
  if (req.method!=="POST") return json({error:"Method not allowed"},405);
  try {
    const now=new Date(); const inWin=inWindow(now); const inSmsWin=inSmsWindow(now);
    const {data:enrollments,error:ee}=await supabase.from("sequence_enrollments").select("*").eq("status","active").not("next_step_at","is",null).lte("next_step_at",now.toISOString()).order("next_step_at",{ascending:true}).limit(BATCH_LIMIT);
    if(ee) throw ee;
    console.log(`[run-sequences] ${enrollments?.length??0} due | win=${inWin} sms=${inSmsWin}`);

    const stateCache=new Map<string,AccountRunState>(), acctCache=new Map<string,IntegrationAccount>(), liLimit=new Set<string>();
    const results:Record<string,unknown>[]=[];
    let sent=0,skipped=0,failed=0,stopped=0;

    for (const en of enrollments??[]) {
      try {
        const isCtx=!en.candidate_id&&!!en.contact_id;
        const eid=en.candidate_id??en.contact_id;
        const step=await getStep(en.sequence_id,en.current_step_order);
        if(!step){await stop(en.id,`No step at ${en.current_step_order}`);stopped++;results.push({id:en.id,status:"stopped",reason:"missing_step"});continue;}
        if(en.current_step_order===0&&step.step_order>0){await supabase.from("sequence_enrollments").update({current_step_order:step.step_order,updated_at:now.toISOString()}).eq("id",en.id);en.current_step_order=step.step_order;}

        const st=(step.step_type??"").toLowerCase();
        const isConn=CONNECTION_STEP_TYPES.includes(st), isInMail=INMAIL_STEP_TYPES.includes(st);
        const isLI=["linkedin","linkedin_recruiter","linkedin_sales_nav"].includes(step.channel);
        const isSms=step.channel==="sms";

        if(!isConn&&!inWin){results.push({id:en.id,status:"queued",reason:"outside_window"});skipped++;continue;}
        if(isSms&&!inSmsWin){const nm=enforceSmsWindow(new Date(now.getTime()+60000));await supabase.from("sequence_enrollments").update({next_step_at:nm.toISOString(),updated_at:now.toISOString()}).eq("id",en.id);results.push({id:en.id,status:"queued",reason:"outside_sms_window"});skipped++;continue;}

        const aid=en.integration_account_id;
        if(!aid){await stop(en.id,"No integration_account_id");stopped++;results.push({id:en.id,status:"stopped",reason:"missing_account"});continue;}
        if(!acctCache.has(aid)){const a=await getAccount(aid);if(!a){await stop(en.id,`Account ${aid} not found`);stopped++;results.push({id:en.id,status:"stopped",reason:"account_not_found"});continue;}acctCache.set(aid,a);}
        const ia=acctCache.get(aid)!;
        const state=await loadRunState(ia,stateCache);

        const {data:sq}=await supabase.from("sequences").select("stop_on_reply").eq("id",en.sequence_id).maybeSingle();
        if(sq?.stop_on_reply!==false){
          let em:string|null=null;
          if(!isCtx&&en.candidate_id){const{data:cd}=await supabase.from("candidates").select("email").eq("id",en.candidate_id).maybeSingle();em=cd?.email??null;}
          else if(isCtx&&en.contact_id){const{data:cd}=await supabase.from("contacts").select("email").eq("id",en.contact_id).maybeSingle();em=cd?.email??null;}
          const since=en.enrolled_at??en.created_at??"2000-01-01T00:00:00Z";
          if(await hasReplied(en.candidate_id??null,en.contact_id??null,em,since)){await stop(en.id,"reply_received");stopped++;results.push({id:en.id,status:"stopped",reason:"reply_received"});continue;}
        }

        let cand:Candidate|null=null;
        if(!isCtx&&en.candidate_id) cand=await getCandidate(en.candidate_id);
        else if(isCtx&&en.contact_id) cand=await getContactAsCandidate(en.contact_id);
        if(!cand){await stop(en.id,isCtx?"Contact not found":"Candidate not found");stopped++;results.push({id:en.id,status:"stopped",reason:isCtx?"no_contact":"no_candidate"});continue;}

        const cId=isCtx?null:en.candidate_id;
        const ctId=isCtx?en.contact_id:null;

        // EMAIL
        if(step.channel==="email"){
          if(!cand.email){await logExec({eid:en.id,seqId:en.sequence_id,entityId:eid!,isContact:isCtx,step,status:"skipped",err:"no_email"});await advance(en.id,en.sequence_id,step,now);results.push({id:en.id,status:"skipped",reason:"no_email"});skipped++;continue;}
          const lim=ia.daily_send_limit??EMAIL_DAILY_MAX;
          if(state.emailSentToday+state.emailSentThisRun>=lim){results.push({id:en.id,status:"queued",reason:"email_limit"});skipped++;continue;}
          const ns=nextEmail(state);
          if(ns&&ns.getTime()>now.getTime()+30000){await supabase.from("sequence_enrollments").update({next_step_at:ns.toISOString(),staggered_at:now.toISOString(),updated_at:now.toISOString()}).eq("id",en.id);state.lastEmailSentAt=ns;results.push({id:en.id,status:"scheduled"});skipped++;continue;}
          const rs=renderTemplate(step.subject,cand), rb=renderTemplate(step.body,cand);
          const isFup=!step.subject||step.subject.trim()==="";
          const tsubj=en.email_thread_subject as string|null, lastMid=en.email_last_message_id as string|null;
          const fsubj=isFup?(tsubj?(tsubj.startsWith("Re:")?tsubj:`Re: ${tsubj}`):"(follow up)"):rs;
          const sig=await getSignature(ia.owner_user_id);
          const bws=appendSig(rb,sig);
          const er=await sendEmail({toEmail:cand.email,subject:fsubj,body:bws,account:ia,replyTo:isFup?lastMid:null,threadSubj:isFup?tsubj:null});
          if(!er.ok){await logExec({eid:en.id,seqId:en.sequence_id,entityId:eid!,isContact:isCtx,step,status:"failed",err:er.error});failed++;results.push({id:en.id,status:"failed",error:er.error});continue;}
          const convId=isFup&&en.email_thread_subject?(en.email_conversation_id??crypto.randomUUID()):crypto.randomUUID();
          await insertEmailMsg({cId,ctId,iaId:ia.id,from:ia.email_address!,to:cand.email,subj:fsubj,body:bws,convId});
          await logExec({eid:en.id,seqId:en.sequence_id,entityId:eid!,isContact:isCtx,step,status:"sent"});
          const tu:Record<string,unknown>={updated_at:now.toISOString()};
          if(!isFup){tu.email_thread_subject=fsubj;tu.email_conversation_id=convId;}
          if(er.msgId) tu.email_last_message_id=er.msgId;
          await supabase.from("sequence_enrollments").update(tu).eq("id",en.id);
          state.emailSentThisRun++;state.lastEmailSentAt=now;
          await advance(en.id,en.sequence_id,step,now);
          sent++;results.push({id:en.id,status:"sent",channel:"email",to:cand.email});continue;
        }

        // SMS
        if(isSms){
          if(!cand.phone){await logExec({eid:en.id,seqId:en.sequence_id,entityId:eid!,isContact:isCtx,step,status:"skipped",err:"no_phone"});await advance(en.id,en.sequence_id,step,now);results.push({id:en.id,status:"skipped",reason:"no_phone"});skipped++;continue;}
          const rca=ia.auth_provider==="ringcentral"?ia:(ia.owner_user_id?await getRCForUser(ia.owner_user_id):null);
          if(!rca?.rc_phone_number||!rca?.rc_jwt){results.push({id:en.id,status:"skipped",reason:"no_rc"});skipped++;continue;}
          const rs=await loadRunState(rca,stateCache);
          if(rs.smsSentToday+rs.smsSentThisRun>=(rca.daily_send_limit??SMS_DAILY_MAX)){results.push({id:en.id,status:"queued",reason:"sms_limit"});skipped++;continue;}
          const nb=nextSms(rs,now);
          if(nb&&nb.getTime()>now.getTime()+30000){await supabase.from("sequence_enrollments").update({next_step_at:nb.toISOString(),staggered_at:now.toISOString(),updated_at:now.toISOString()}).eq("id",en.id);results.push({id:en.id,status:"scheduled",reason:"sms_batch"});skipped++;continue;}
          const sb=renderTemplate(step.body,cand);
          const sr=await sendSMS({from:rca.rc_phone_number,to:cand.phone,text:sb,jwt:rca.rc_jwt});
          if(!sr.ok){await logExec({eid:en.id,seqId:en.sequence_id,entityId:eid!,isContact:isCtx,step,status:"failed",err:sr.error});failed++;results.push({id:en.id,status:"failed",error:sr.error});continue;}
          await insertSmsMsg({cId,ctId,iaId:rca.id,from:rca.rc_phone_number,to:cand.phone,body:sb,id:sr.id});
          await logExec({eid:en.id,seqId:en.sequence_id,entityId:eid!,isContact:isCtx,step,status:"sent"});
          rs.smsSentThisRun++;rs.lastSmsSentAt=now;
          if(!rs.smsBatchStartAt||(now.getTime()-rs.smsBatchStartAt.getTime())>=SMS_BATCH_INTERVAL_MIN*60000){rs.smsSentThisBatch=1;rs.smsBatchStartAt=now;}else{rs.smsSentThisBatch++;}
          await advance(en.id,en.sequence_id,step,now);
          sent++;results.push({id:en.id,status:"sent",channel:"sms",to:cand.phone});continue;
        }

        // CALL
        if(step.channel==="call"||step.step_type==="call"){
          const name=cand.full_name||[cand.first_name,cand.last_name].filter(Boolean).join(" ")||"Candidate";
          await createCallTask({cId,ctId,eid:en.id,assignTo:ia.owner_user_id,name,phone:cand.phone,body:step.body});
          await logExec({eid:en.id,seqId:en.sequence_id,entityId:eid!,isContact:isCtx,step,status:"sent",err:"call_task"});
          await advance(en.id,en.sequence_id,step,now);
          sent++;results.push({id:en.id,status:"sent",channel:"call"});continue;
        }

        // LINKEDIN
        if(isLI){
          if(!ia.unipile_account_id){results.push({id:en.id,status:"skipped",reason:"no_unipile_account"});skipped++;continue;}
          const cap=ia.linkedin_capability??"sales_nav";
          const stored=cap==="recruiter"?cand.unipile_recruiter_id:cap==="classic"?cand.unipile_classic_id:cand.unipile_sales_nav_id;
          if(!cand.linkedin_url&&!stored){await logExec({eid:en.id,seqId:en.sequence_id,entityId:eid!,isContact:isCtx,step,status:"skipped",err:"no_linkedin"});await advance(en.id,en.sequence_id,step,now);results.push({id:en.id,status:"skipped",reason:"no_linkedin"});skipped++;continue;}
          if(!isConn&&liLimit.has(ia.id)){results.push({id:en.id,status:"queued",reason:"li_limit"});skipped++;continue;}

          if(isConn){
            const cl=ia.linkedin_daily_connection_limit??LI_CONNECTION_DAILY_MAX;
            if(state.liConnectionsSentToday+state.liConnectionsSentThisRun>=cl){results.push({id:en.id,status:"queued",reason:"conn_limit"});skipped++;continue;}
            const nc=nextLiConn(state);
            if(nc&&nc.getTime()>now.getTime()+30000){await supabase.from("sequence_enrollments").update({next_step_at:nc.toISOString(),staggered_at:now.toISOString(),updated_at:now.toISOString()}).eq("id",en.id);state.lastLiConnectionAt=nc;results.push({id:en.id,status:"scheduled"});skipped++;continue;}
            const rid=await resolveRecipientId(ia,cand,isCtx);
            if(!rid){results.push({id:en.id,status:"skipped",reason:"no_recipient"});skipped++;continue;}
            const cs=await connStatus(ia,rid);
            if(cs==="connected"){await supabase.from("sequence_enrollments").update({linkedin_connection_status:"already_connected",linkedin_connection_accepted_at:now.toISOString(),waiting_for_connection_acceptance:false,updated_at:now.toISOString()}).eq("id",en.id);await logExec({eid:en.id,seqId:en.sequence_id,entityId:eid!,isContact:isCtx,step,status:"skipped",err:"already_connected"});await advance(en.id,en.sequence_id,step,now);results.push({id:en.id,status:"skipped",reason:"already_connected"});skipped++;continue;}
            if(cs==="pending"){await supabase.from("sequence_enrollments").update({waiting_for_connection_acceptance:true,next_step_at:null,updated_at:now.toISOString()}).eq("id",en.id);results.push({id:en.id,status:"queued",reason:"conn_pending"});skipped++;continue;}
            const cb=renderTemplate(step.body,cand);
            const cr=await sendConnReq(ia,rid,cb||undefined);
            if(!cr.ok){if(isCreditError(cr.error)){liLimit.add(ia.id);await backoff(en.id,6);}else{await backoff(en.id,0.5);}await logExec({eid:en.id,seqId:en.sequence_id,entityId:eid!,isContact:isCtx,step,status:"failed",err:cr.error});failed++;results.push({id:en.id,status:"failed",error:cr.error});continue;}
            await supabase.from("sequence_enrollments").update({linkedin_connection_requested_at:now.toISOString(),linkedin_connection_status:"requested",waiting_for_connection_acceptance:true,next_step_at:null,updated_at:now.toISOString()}).eq("id",en.id);
            await logExec({eid:en.id,seqId:en.sequence_id,entityId:eid!,isContact:isCtx,step,status:"sent"});
            state.liConnectionsSentThisRun++;state.lastLiConnectionAt=now;
            sent++;results.push({id:en.id,status:"sent",channel:"linkedin",type:"connection_request"});continue;
          }

          if(isInMail){
            if(liLimit.has(ia.id)){results.push({id:en.id,status:"queued",reason:"li_limit"});skipped++;continue;}
            const nm=nextLiMsg(state);
            if(nm&&nm.getTime()>now.getTime()+30000){await supabase.from("sequence_enrollments").update({next_step_at:nm.toISOString(),staggered_at:now.toISOString(),updated_at:now.toISOString()}).eq("id",en.id);state.lastLiSentAt=nm;results.push({id:en.id,status:"scheduled"});skipped++;continue;}
            const rid=await resolveRecipientId(ia,cand,isCtx);
            if(!rid){results.push({id:en.id,status:"skipped",reason:"no_recipient"});skipped++;continue;}
            const im=await sendInMail(ia,rid,renderTemplate(step.subject,cand),renderTemplate(step.body,cand));
            if(!im.ok){
              if(isCreditError(im.error)){liLimit.add(ia.id);await backoff(en.id,6);await logExec({eid:en.id,seqId:en.sequence_id,entityId:eid!,isContact:isCtx,step,status:"failed",err:im.error});failed++;results.push({id:en.id,status:"failed",error:im.error,backoff:6});continue;}
              await backoff(en.id,0.5);await logExec({eid:en.id,seqId:en.sequence_id,entityId:eid!,isContact:isCtx,step,status:"failed",err:im.error});failed++;results.push({id:en.id,status:"failed",error:im.error});continue;
            }
            await insertLiMsg({cId,ctId,iaId:ia.id,channel:step.channel,body:renderTemplate(step.body,cand),chatId:im.chatId??null,convId:im.chatId??crypto.randomUUID()});
            if(im.chatId) await supabase.from("sequence_enrollments").update({unipile_chat_id:im.chatId,updated_at:now.toISOString()}).eq("id",en.id);
            await logExec({eid:en.id,seqId:en.sequence_id,entityId:eid!,isContact:isCtx,step,status:"sent"});
            state.liMessagesSentThisRun++;state.lastLiSentAt=now;
            await advance(en.id,en.sequence_id,step,now,{jitter:true});
            sent++;results.push({id:en.id,status:"sent",channel:step.channel,type:"inmail"});continue;
          }

          if(en.waiting_for_connection_acceptance){results.push({id:en.id,status:"queued",reason:"awaiting_conn"});skipped++;continue;}
          const ml=ia.linkedin_daily_message_limit??LI_MESSAGE_DAILY_MAX;
          if(state.liMessagesSentToday+state.liMessagesSentThisRun>=ml){results.push({id:en.id,status:"queued",reason:"li_msg_limit"});skipped++;continue;}
          const nm2=nextLiMsg(state);
          if(nm2&&nm2.getTime()>now.getTime()+30000){await supabase.from("sequence_enrollments").update({next_step_at:nm2.toISOString(),staggered_at:now.toISOString(),updated_at:now.toISOString()}).eq("id",en.id);state.lastLiSentAt=nm2;results.push({id:en.id,status:"scheduled"});skipped++;continue;}
          const rid2=await resolveRecipientId(ia,cand,isCtx);
          if(!rid2){results.push({id:en.id,status:"skipped",reason:"no_recipient"});skipped++;continue;}
          const cs2=await connStatus(ia,rid2);
          if(cs2!=="connected"){results.push({id:en.id,status:"skipped",reason:"not_connected"});skipped++;continue;}
          const mb=renderTemplate(step.body,cand);
          const mr=await sendLiMsg(ia,rid2,mb,en.unipile_chat_id??null);
          if(!mr.ok){
            if(isCreditError(mr.error)){liLimit.add(ia.id);await backoff(en.id,6);}else{await backoff(en.id,0.5);}
            await logExec({eid:en.id,seqId:en.sequence_id,entityId:eid!,isContact:isCtx,step,status:"failed",err:mr.error});failed++;results.push({id:en.id,status:"failed",error:mr.error});continue;
          }
          await insertLiMsg({cId,ctId,iaId:ia.id,channel:step.channel,body:mb,chatId:mr.chatId,msgId:mr.msgId,convId:mr.chatId??crypto.randomUUID()});
          if(mr.chatId&&!en.unipile_chat_id) await supabase.from("sequence_enrollments").update({unipile_chat_id:mr.chatId,updated_at:now.toISOString()}).eq("id",en.id);
          await logExec({eid:en.id,seqId:en.sequence_id,entityId:eid!,isContact:isCtx,step,status:"sent"});
          state.liMessagesSentThisRun++;state.lastLiSentAt=now;
          await advance(en.id,en.sequence_id,step,now,{jitter:true});
          sent++;results.push({id:en.id,status:"sent",channel:step.channel,type:"message"});continue;
        }

        results.push({id:en.id,status:"skipped",reason:`unsupported_${step.channel}`});skipped++;
      } catch(err) {
        console.error(`[error] ${en.id}:`,err);
        failed++;results.push({id:en.id,status:"error",error:err instanceof Error?err.message:String(err)});
      }
    }

    console.log(`[done] sent=${sent} skipped=${skipped} failed=${failed} stopped=${stopped}`);
    return json({ok:true,processed:enrollments?.length??0,sent,skipped,failed,stopped,liLimitHit:[...liLimit],results});
  } catch(err) {
    console.error("[fatal]",err); return json({ok:false,error:err instanceof Error?err.message:String(err)},500);
  }
});
