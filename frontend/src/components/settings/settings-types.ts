// Shared types for the Settings page + its extracted section components.

export interface IntegrationConfig {
  [key: string]: string;
}

export interface IntegrationRow {
  integration_type: string;
  config: IntegrationConfig;
  is_active: boolean;
}

export interface LinkedinSeat {
  account_label: string | null;
  account_type: string;
  email_address: string | null;
  id: string;
  is_active: boolean;
  linkedin_capabilities: string[] | null;
  linkedin_capability: string | null;
  metadata: Record<string, any> | null;
  owner_user_id: string | null;
  unipile_account_id: string | null;
  updated_at: string;
}

export type EnrichmentKey =
  | 'APOLLO_API_KEY'
  | 'BETTERCONTACT_API_KEY'
  | 'FULLENRICH_API_KEY'
  | 'PDL_API_KEY'
  | 'ZEROBOUNCE_API_KEY';

export type WorkingWindow = { start: string; end: string };
export type SchedulingLink = {
  id: string;
  slug: string;
  title: string | null;
  duration_min: number;
  meeting_type: 'phone' | 'teams' | 'in_person';
  location: string | null;
  timezone: string;
  working_hours: Record<string, WorkingWindow[]>;
  buffer_min: number;
  min_notice_hours: number;
  max_days_out: number;
  active: boolean;
};
