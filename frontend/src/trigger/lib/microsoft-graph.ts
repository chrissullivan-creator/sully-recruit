import { logger } from "@trigger.dev/sdk/v3";
import { getMicrosoftGraphCredentials } from "./supabase";
import { unipileSendEmail, shouldUseUnipileEmail } from "./unipile-email";
import { getSupabaseAdmin } from "./supabase";

/**
 * Shared Microsoft Graph helpers.
 * Used by send-channels.ts (email) and sync-outlook-contact.ts (contact sync).
 */

// ─────────────────────────────────────────────────────────────────────────────
// AUTH — client credentials token
// ─────────────────────────────────────────────────────────────────────────────

export async function getMicrosoftAccessToken(): Promise<string> {
  const { clientId, clientSecret, tenantId } = await getMicrosoftGraphCredentials();

  const resp = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    },
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Microsoft token error: ${errText}`);
  }

  const data = await resp.json();
  return data.access_token;
}

// ─────────────────────────────────────────────────────────────────────────────
// SIMPLE INTERNAL EMAIL — fire-and-forget summary mails (e.g. reconcile run
// reports). Skips silently when sender/recipients aren't configured.
// ─────────────────────────────────────────────────────────────────────────────

export async function sendInternalEmail(
  fromEmail: string,
  toEmails: string[],
  subject: string,
  htmlBody: string,
): Promise<void> {
  if (!fromEmail || toEmails.length === 0) return;

  // Phase 2 of the Unipile-everywhere migration: when the kill-switch
  // USE_UNIPILE_EMAIL is on, route through Unipile Outlook. Falls back
  // to Graph on any error so a misconfigured Unipile account never
  // silently drops alerts/digests.
  if (await shouldUseUnipileEmail()) {
    try {
      await unipileSendEmail(getSupabaseAdmin(), {
        fromEmail,
        to: toEmails,
        subject,
        htmlBody,
      });
      return;
    } catch (err: any) {
      logger.warn("sendInternalEmail: Unipile failed, falling back to Graph", {
        fromEmail, error: err.message,
      });
    }
  }

  const accessToken = await getMicrosoftAccessToken();
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/sendMail`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "HTML", content: htmlBody },
          toRecipients: toEmails.map((addr) => ({ emailAddress: { address: addr } })),
        },
        saveToSentItems: true,
      }),
    },
  );
  if (!resp.ok) {
    const err = await resp.text();
    logger.warn("sendInternalEmail failed", { fromEmail, toEmails, error: err.slice(0, 200) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTACTS — create or update Outlook contact
// ─────────────────────────────────────────────────────────────────────────────

export interface CandidateContactData {
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  current_title: string | null;
  current_company: string | null;
  linkedin_url: string | null;
}

function buildContactPayload(candidate: CandidateContactData) {
  const payload: Record<string, any> = {
    categories: ["Sully Recruit"],
  };

  if (candidate.first_name) payload.givenName = candidate.first_name;
  if (candidate.last_name) payload.surname = candidate.last_name;
  if (candidate.full_name) payload.displayName = candidate.full_name;
  if (candidate.current_title) payload.jobTitle = candidate.current_title;
  if (candidate.current_company) payload.companyName = candidate.current_company;

  if (candidate.email) {
    payload.emailAddresses = [
      { address: candidate.email, name: candidate.full_name || candidate.email },
    ];
  }

  if (candidate.phone) {
    payload.businessPhones = [candidate.phone];
  }

  if (candidate.linkedin_url) {
    payload.businessHomePage = candidate.linkedin_url;
  }

  return payload;
}

/**
 * Create or update an Outlook contact for a candidate.
 * Returns the Graph contact resource ID.
 */
export async function createOrUpdateOutlookContact(
  accessToken: string,
  ownerEmail: string,
  candidate: CandidateContactData,
  existingContactId?: string | null,
): Promise<string> {
  const payload = buildContactPayload(candidate);
  const userPath = `/users/${encodeURIComponent(ownerEmail)}/contacts`;

  if (existingContactId) {
    // Update existing contact
    const resp = await fetch(
      `https://graph.microsoft.com/v1.0${userPath}/${existingContactId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (resp.ok) {
      const data = await resp.json();
      logger.info("Outlook contact updated", { ownerEmail, contactId: existingContactId });
      return data.id;
    }

    // If 404, contact was deleted in Outlook — fall through to create
    if (resp.status === 404) {
      logger.warn("Outlook contact not found, re-creating", { contactId: existingContactId });
    } else {
      const errText = await resp.text();
      throw new Error(`Graph PATCH contact error (${resp.status}): ${errText}`);
    }
  }

  // Create new contact
  const resp = await fetch(`https://graph.microsoft.com/v1.0${userPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Graph POST contact error (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  logger.info("Outlook contact created", { ownerEmail, contactId: data.id });
  return data.id;
}
