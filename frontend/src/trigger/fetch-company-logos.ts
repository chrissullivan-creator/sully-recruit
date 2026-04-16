import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";

export const fetchCompanyLogos = task({
  id: "fetch-company-logos",
  retry: { maxAttempts: 2 },
  run: async () => {
    const supabase = getSupabaseAdmin();

    // Get companies with a domain but no logo_url
    const { data: companies, error } = await supabase
      .from("companies")
      .select("id, domain, logo_url")
      .not("domain", "is", null)
      .neq("domain", "")
      .or("logo_url.is.null,logo_url.eq.");

    if (error || !companies) throw new Error(error?.message || "No companies");
    logger.info(`Checking logos for ${companies.length} companies`);

    let updated = 0;
    for (const company of companies) {
      const domain = company.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim();
      if (!domain) continue;

      try {
        const resp = await fetch(`https://logo.clearbit.com/${domain}`, { method: "HEAD" });
        if (resp.ok) {
          await supabase.from("companies").update({
            logo_url: `https://logo.clearbit.com/${domain}`
          }).eq("id", company.id);
          updated++;
        }
      } catch { /* skip */ }
    }

    logger.info(`Updated logos for ${updated} companies`);
    return { updated };
  },
});
