/**
 * Resolve a recipient/sender address (email, phone, LinkedIn provider ID)
 * to an existing person in the CRM. Used by:
 *  - webhook handlers to gate inbound persistence
 *  - send-message to attach outbound to a known person (or auto-create)
 *  - sequence runner
 *
 * Returns null when no match.
 */

type ResolvedPerson = {
  id: string;
  type: "candidate" | "contact";
  /**
   * Column to use in messages/conversations inserts. Mirrors the
   * historical entityColumn convention.
   */
  entityColumn: "candidate_id" | "contact_id";
};

type Channel = "email" | "sms" | "linkedin" | "linkedin_recruiter";

function normalizeEmail(input: string): string {
  return input.trim().toLowerCase().replace(/\+[^@]*@/, "@");
}

function normalizePhone(input: string): string {
  // Naive: strip everything except digits and a leading +.
  const trimmed = input.trim();
  return trimmed.startsWith("+") ? "+" + trimmed.slice(1).replace(/\D/g, "") : trimmed.replace(/\D/g, "");
}

export async function resolveCounterparty(
  supabase: any,
  args: { channel: Channel; address: string },
): Promise<ResolvedPerson | null> {
  const { channel, address } = args;
  if (!address) return null;

  // Build the predicate per channel.
  let candidateQuery: any;
  let contactQuery: any;

  if (channel === "email") {
    const normalized = normalizeEmail(address);
    candidateQuery = supabase
      .from("candidate_channels")
      .select("candidate_id, provider_id")
      .eq("channel", "email")
      .or(`provider_id.ilike.${normalized},unipile_id.ilike.${normalized}`)
      .limit(1);
    contactQuery = supabase
      .from("contact_channels")
      .select("contact_id, provider_id")
      .eq("channel", "email")
      .or(`provider_id.ilike.${normalized},unipile_id.ilike.${normalized}`)
      .limit(1);
  } else if (channel === "sms") {
    const normalized = normalizePhone(address);
    candidateQuery = supabase
      .from("candidate_channels")
      .select("candidate_id, provider_id")
      .eq("channel", "sms")
      .or(`provider_id.eq.${normalized},unipile_id.eq.${normalized}`)
      .limit(1);
    contactQuery = supabase
      .from("contact_channels")
      .select("contact_id, provider_id")
      .eq("channel", "sms")
      .or(`provider_id.eq.${normalized},unipile_id.eq.${normalized}`)
      .limit(1);
  } else {
    // LinkedIn / LinkedIn Recruiter — match by Unipile provider_id /
    // attendee_id. Address may be the bare ID or a profile URL; do a
    // contains match against both possible columns.
    candidateQuery = supabase
      .from("candidate_channels")
      .select("candidate_id, provider_id")
      .in("channel", ["linkedin", "linkedin_recruiter"])
      .or(`provider_id.eq.${address},unipile_id.eq.${address}`)
      .limit(1);
    contactQuery = supabase
      .from("contact_channels")
      .select("contact_id, provider_id")
      .in("channel", ["linkedin", "linkedin_recruiter"])
      .or(`provider_id.eq.${address},unipile_id.eq.${address}`)
      .limit(1);
  }

  const [{ data: candHit }, { data: contHit }] = await Promise.all([candidateQuery, contactQuery]);

  if (candHit && candHit.length > 0) {
    return { id: candHit[0].candidate_id, type: "candidate", entityColumn: "candidate_id" };
  }
  if (contHit && contHit.length > 0) {
    return { id: contHit[0].contact_id, type: "contact", entityColumn: "contact_id" };
  }
  // Also try the legacy direct columns on people (primary_email / phone /
  // linkedin_url) for rows that don't have a candidate_channels entry yet.
  if (channel === "email") {
    const normalized = normalizeEmail(address);
    const { data } = await supabase
      .from("people")
      .select("id, type")
      .ilike("primary_email", normalized)
      .limit(1);
    if (data && data.length > 0) {
      return {
        id: data[0].id,
        type: (data[0].type ?? "candidate") as "candidate" | "contact",
        entityColumn: data[0].type === "contact" ? "contact_id" : "candidate_id",
      };
    }
  } else if (channel === "sms") {
    const normalized = normalizePhone(address);
    const { data } = await supabase
      .from("people")
      .select("id, type")
      .eq("phone", normalized)
      .limit(1);
    if (data && data.length > 0) {
      return {
        id: data[0].id,
        type: (data[0].type ?? "candidate") as "candidate" | "contact",
        entityColumn: data[0].type === "contact" ? "contact_id" : "candidate_id",
      };
    }
  }

  return null;
}

interface AutoCreateArgs {
  channel: Channel;
  address: string;
  /** Best-guess full name (e.g. from email signature, or local-part). */
  name?: string | null;
  ownerUserId: string;
  /** Where the auto-add was triggered from — populates auto_added_source. */
  source:
    | "outbound_email"
    | "outbound_linkedin"
    | "outbound_recruiter"
    | "outbound_sms"
    | "group_thread";
}

/**
 * Auto-create a person from an outbound send to an unknown recipient.
 * Defaults to type='candidate' with needs_classification=true so it
 * surfaces in the Data Cleanup view for the user to confirm or flip
 * to client. The `person.created` Supabase trigger handles backfill
 * downstream — no manual event fire needed.
 */
export async function autoCreatePersonFromOutbound(
  supabase: any,
  args: AutoCreateArgs,
): Promise<ResolvedPerson | null> {
  const { channel, address, name, ownerUserId, source } = args;
  if (!address) return null;

  const fullName =
    name?.trim() ||
    (channel === "email" ? deriveNameFromEmail(address) : null) ||
    "Unknown recipient";
  const nowIso = new Date().toISOString();

  // People insert — minimal payload. The trigger on `people` (see
  // 20260511030000_person_created_webhook_trigger.sql) fires the
  // backfill via the person-created webhook.
  const personRow: Record<string, unknown> = {
    full_name: fullName,
    type: "candidate",
    needs_classification: true,
    auto_added_at: nowIso,
    auto_added_source: source,
    owner_user_id: ownerUserId,
    created_by_user_id: ownerUserId,
  };
  if (channel === "email") personRow.primary_email = normalizeEmail(address);
  if (channel === "sms") personRow.phone = normalizePhone(address);
  if (channel === "linkedin" || channel === "linkedin_recruiter") {
    // The address here is a provider_id / Unipile attendee id. Stash it
    // on candidate_channels (below) — leave linkedin_url empty for the
    // enrichment pass to populate properly.
  }

  const { data, error } = await supabase
    .from("people")
    .insert(personRow as any)
    .select("id")
    .single();

  if (error || !data) {
    return null;
  }
  const personId: string = data.id;

  // Mirror the address into candidate_channels so future webhook
  // recognition (resolveCounterparty above) lands as a hard match.
  const ch: string = channel;
  await supabase.from("candidate_channels").insert({
    candidate_id: personId,
    channel: ch === "linkedin_recruiter" ? "linkedin" : ch,
    provider_id: channel === "email" ? normalizeEmail(address) : channel === "sms" ? normalizePhone(address) : address,
  } as any);

  return { id: personId, type: "candidate", entityColumn: "candidate_id" };
}

function deriveNameFromEmail(email: string): string | null {
  const local = email.split("@")[0];
  if (!local) return null;
  // "first.last+tag" → "First Last"
  const cleaned = local.replace(/\+.*$/, "").replace(/[._-]+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned
    .split(/\s+/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}
