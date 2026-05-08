import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import { unipileFetch } from "./lib/unipile-v2";

/**
 * Pull inbound LinkedIn connection requests per active LinkedIn account
 * and persist them to `linkedin_invitations`. Try to match each
 * inviter to an existing person by provider_id / linkedin URL; create
 * a new candidate when no match is found so the recruiter sees a warm
 * lead in the inbox without manual entry.
 *
 * v2 path:
 *   GET /api/v2/{account_id}/users/invitations/received
 *
 * (Some Unipile builds expose this as
 *  /api/v2/{account_id}/linkedin/users/invitations/received — the
 *  task tries both.)
 *
 * Schedule: every 30 minutes. Recruiters check inbound throughout
 * the day; faster than that risks Unipile rate limits.
 *
 * Why this lives outside the existing webhook handler: webhooks fire
 * on new invites only after the account has been live; the periodic
 * pull catches anything missed during downtime AND keeps the
 * `linkedin_invitations` table authoritative.
 */
export const syncLinkedinInvitations = schedules.task({
  id: "sync-linkedin-invitations",
  cron: "*/30 * * * *",
  maxDuration: 240,
  run: async () => {
    const supabase = getSupabaseAdmin();

    const { data: accounts } = await supabase
      .from("integration_accounts")
      .select("id, unipile_account_id, owner_user_id, account_type, account_label")
      .or("account_type.eq.linkedin,account_type.eq.linkedin_classic,account_type.eq.linkedin_recruiter")
      .eq("is_active", true)
      .not("unipile_account_id", "is", null);

    if (!accounts?.length) {
      logger.info("No active LinkedIn accounts — skipping invitations sync");
      return { checked: 0, new_invitations: 0, candidates_created: 0 };
    }

    let totalNew = 0;
    let candidatesCreated = 0;
    const perAccount: Array<{ label: string; pulled: number; new: number }> = [];

    for (const acct of accounts) {
      try {
        // Per Unipile v2 docs, LinkedIn-specific endpoints sit under
        // /linkedin/. Try that path first; older builds may still
        // expose the legacy unprefixed shape, hence the fallback.
        let data: any;
        try {
          data = await unipileFetch(
            supabase,
            acct.unipile_account_id!,
            `linkedin/users/invitations/received`,
            { method: "GET", query: { limit: 50 } },
          );
        } catch {
          data = await unipileFetch(
            supabase,
            acct.unipile_account_id!,
            `users/invitations/received`,
            { method: "GET", query: { limit: 50 } },
          );
        }

        const invites = data.items ?? data.invitations ?? data ?? [];
        let pulled = invites.length;
        let newOnAccount = 0;

        for (const inv of invites) {
          const invitationId = inv.id ?? inv.invitation_id;
          if (!invitationId) continue;

          const { data: existing } = await supabase
            .from("linkedin_invitations")
            .select("id, candidate_id")
            .eq("invitation_id", invitationId)
            .maybeSingle();
          if (existing) continue;

          const inviter = inv.inviter ?? inv.from ?? inv.user ?? {};
          const providerId = inviter.provider_id ?? inviter.id ?? null;
          const publicId = inviter.public_id ?? inviter.public_identifier ?? null;
          const inviterName =
            (inviter.first_name && inviter.last_name)
              ? `${inviter.first_name} ${inviter.last_name}`.trim()
              : inviter.name ?? inviter.display_name ?? null;
          const headline = inviter.headline ?? inviter.title ?? null;
          const avatar = inviter.profile_picture_url ?? inviter.picture_url ?? null;
          const message = inv.message ?? inv.text ?? inv.body ?? null;
          const linkedinUrl = inviter.public_profile_url
            ?? (publicId ? `https://www.linkedin.com/in/${publicId}` : null);
          const invitedAt = inv.created_at ?? inv.invited_at ?? inv.timestamp ?? null;

          // Try to match an existing person by provider_id or LI URL.
          let candidateId: string | null = null;
          if (providerId) {
            const { data: byProvider } = await supabase
              .from("people")
              .select("id")
              .or(
                `unipile_recruiter_id.eq.${providerId},unipile_classic_id.eq.${providerId},unipile_provider_id.eq.${providerId}`,
              )
              .maybeSingle();
            if (byProvider) candidateId = byProvider.id;
          }
          if (!candidateId && linkedinUrl) {
            const { data: byUrl } = await supabase
              .from("people")
              .select("id")
              .ilike("linkedin_url", `%${(publicId ?? "").toString()}%`)
              .maybeSingle();
            if (byUrl) candidateId = byUrl.id;
          }

          // No match → create the candidate so the recruiter sees an
          // actionable lead. Mark source so they're easy to triage.
          if (!candidateId && inviterName) {
            const [first = "", ...rest] = inviterName.split(/\s+/);
            const last = rest.join(" ");
            const { data: created } = await supabase
              .from("people")
              .insert({
                first_name: first,
                last_name: last,
                linkedin_url: linkedinUrl,
                avatar_url: avatar,
                current_title: headline,
                source: "linkedin_inbound_invite",
                status: "new",
                owner_user_id: acct.owner_user_id ?? null,
                unipile_provider_id: providerId,
                unipile_classic_id: acct.account_type === "linkedin_recruiter" ? null : providerId,
                unipile_recruiter_id: acct.account_type === "linkedin_recruiter" ? providerId : null,
              } as any)
              .select("id")
              .single();
            if (created) {
              candidateId = created.id;
              candidatesCreated++;
            }
          }

          await supabase.from("linkedin_invitations").insert({
            integration_account_id: acct.id,
            unipile_account_id: acct.unipile_account_id,
            invitation_id: invitationId,
            inviter_provider_id: providerId,
            inviter_public_id: publicId,
            inviter_name: inviterName,
            inviter_headline: headline,
            inviter_avatar_url: avatar,
            message,
            candidate_id: candidateId,
            matched_at: candidateId ? new Date().toISOString() : null,
            invited_at: invitedAt,
            status: "pending",
          } as any);

          newOnAccount++;
          totalNew++;
        }

        perAccount.push({
          label: acct.account_label || acct.id,
          pulled,
          new: newOnAccount,
        });
      } catch (err: any) {
        logger.warn("Invitation sync error (non-fatal)", {
          account: acct.account_label,
          error: err.message,
        });
      }
    }

    logger.info("LinkedIn invitations sync complete", {
      new_invitations: totalNew,
      candidates_created: candidatesCreated,
      per_account: perAccount,
    });
    return {
      checked: accounts.length,
      new_invitations: totalNew,
      candidates_created: candidatesCreated,
      per_account: perAccount,
    };
  },
});
