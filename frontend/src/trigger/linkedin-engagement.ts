import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getUnipileBaseUrl, getAppSetting } from "./lib/supabase";

const DELAY_MS = 2000; // 2s between engagement actions to appear natural

/**
 * On-demand task: warm up a candidate by engaging with their LinkedIn posts.
 *
 * Before cold outreach, liking/reacting to a candidate's recent posts
 * increases familiarity and response rates. This task finds the candidate's
 * recent posts and reacts to the most recent ones.
 *
 * Triggered before sequence enrollment for linkedin channels.
 */
export const warmupCandidate = task({
  id: "warmup-candidate",
  retry: { maxAttempts: 1 },
  maxDuration: 60,
  run: async (payload: {
    candidate_id: string;
    max_engagements?: number;
    user_id?: string;
    account_id?: string;
  }) => {
    const supabase = getSupabaseAdmin();
    const baseUrl = await getUnipileBaseUrl();
    const apiKey = await getAppSetting("UNIPILE_API_KEY");
    const maxEngagements = payload.max_engagements || 2;

    // Get candidate's LinkedIn provider_id
    const { data: channel } = await supabase
      .from("candidate_channels")
      .select("provider_id, account_id")
      .eq("candidate_id", payload.candidate_id)
      .eq("channel", "linkedin")
      .maybeSingle();

    if (!channel?.provider_id) {
      // Try resolving from candidate's linkedin_url
      const { data: candidate } = await supabase
        .from("candidates")
        .select("linkedin_url, full_name, unipile_provider_id")
        .eq("id", payload.candidate_id)
        .single();

      if (!candidate?.unipile_provider_id && !candidate?.linkedin_url) {
        logger.warn("No LinkedIn info for candidate", { candidateId: payload.candidate_id });
        return { engaged: 0, reason: "no_linkedin" };
      }
    }

    const providerId = channel?.provider_id || (
      await supabase.from("candidates").select("unipile_provider_id").eq("id", payload.candidate_id).single()
    ).data?.unipile_provider_id;

    if (!providerId) {
      return { engaged: 0, reason: "no_provider_id" };
    }

    // Fetch candidate's recent posts
    const postsResp = await fetch(
      `${baseUrl}/users/${encodeURIComponent(providerId)}/posts?limit=5`,
      {
        headers: { "X-API-KEY": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!postsResp.ok) {
      logger.warn("Failed to fetch candidate posts", { providerId, status: postsResp.status });
      return { engaged: 0, reason: "posts_fetch_failed" };
    }

    const postsData = await postsResp.json();
    const posts = (postsData.items || postsData || []).slice(0, maxEngagements);

    let engaged = 0;

    for (const post of posts) {
      const postId = post.id || post.provider_id;
      if (!postId) continue;

      try {
        // React to the post with a contextually appropriate reaction
        const reaction = selectReaction(post.text || "");

        const reactResp = await fetch(`${baseUrl}/posts/${encodeURIComponent(postId)}/reactions`, {
          method: "POST",
          headers: {
            "X-API-KEY": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ reaction_type: reaction }),
          signal: AbortSignal.timeout(5_000),
        });

        if (reactResp.ok) {
          engaged++;
          logger.info("Engaged with candidate post", {
            candidateId: payload.candidate_id,
            postId,
            reaction,
          });
        }

        await delay(DELAY_MS);
      } catch (err: any) {
        logger.warn("Failed to engage with post", { postId, error: err.message });
      }
    }

    // Log the engagement activity
    if (engaged > 0) {
      await supabase.from("candidate_activity_log").insert({
        candidate_id: payload.candidate_id,
        activity_type: "linkedin_warmup",
        description: `Engaged with ${engaged} LinkedIn post(s)`,
        metadata: { engaged, posts_checked: posts.length },
      } as any).then(() => {}).catch(() => {});
    }

    logger.info("Candidate warmup complete", { candidateId: payload.candidate_id, engaged });
    return { engaged };
  },
});

function selectReaction(postText: string): string {
  const text = postText.toLowerCase();
  if (text.includes("congratul") || text.includes("promoted") || text.includes("new role") || text.includes("new job")) {
    return "CELEBRATE";
  }
  if (text.includes("insight") || text.includes("learn") || text.includes("data") || text.includes("research")) {
    return "INSIGHTFUL";
  }
  if (text.includes("challenge") || text.includes("help") || text.includes("support")) {
    return "SUPPORT";
  }
  return "LIKE";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
