import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// Shapes returned by the command_center_summary() RPC (one round-trip).
export interface ReadyToMovePerson { id: string; name: string | null; title: string | null; company: string | null; sentiment: string | null; avatar: string | null; company_domain: string | null; company_logo: string | null }
export interface BelowMarketPerson { id: string; name: string | null; title: string | null; company: string | null; cur: number | null; tgt: number | null; avatar: string | null; company_domain: string | null; company_logo: string | null }
export interface AtRiskSearch { id: string; title: string | null; company: string | null; last_sourced_at: string | null; company_domain: string | null; company_logo: string | null }
export interface JoeRec { id: string; entity_type: string | null; entity_id: string | null; category: string | null; headline: string | null; rationale: string | null; score: number | null }

export interface CommandCenterData {
  calls_today: number;
  interviews_next7: number;
  offers_out: number;
  placements_mtd: number;
  revenue_mtd: number;
  open_searches: number;
  avg_days_to_fill: number | null;
  followups_due: number;
  ready_to_move_count: number;
  below_market_count: number;
  searches_at_risk_count: number;
  joe_briefings_count: number;
  forecast_pipeline: number;
  ready_to_move: ReadyToMovePerson[];
  below_market: BelowMarketPerson[];
  at_risk: AtRiskSearch[];
  joe_recs: JoeRec[];
}

// AI Command Center — the morning intelligence view. Pulls every KPI + preview
// list in a single SECURITY DEFINER RPC so the dashboard is one fast round-trip
// instead of a dozen client queries.
export function useCommandCenter() {
  return useQuery({
    queryKey: ['command_center_summary'],
    staleTime: 60_000,
    queryFn: async (): Promise<CommandCenterData> => {
      const { data, error } = await supabase.rpc('command_center_summary' as any);
      if (error) throw error;
      return data as unknown as CommandCenterData;
    },
  });
}
