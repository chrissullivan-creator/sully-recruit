import type { EnrichmentKey, WorkingWindow } from './settings-types';

// Pure, state-independent constants + helpers hoisted out of Settings.tsx.

export const ADMIN_EMAILS = [
  'chris.sullivan@emeraldrecruit.com',
  'emeraldrecruit@theemeraldrecruitinggroup.com',
];

export const ENRICHMENT_KEY_META: Record<EnrichmentKey, { label: string; help: string; signupUrl: string }> = {
  APOLLO_API_KEY: {
    label: 'Apollo',
    help: 'People match + organization enrich + person_id capture',
    signupUrl: 'https://app.apollo.io/#/settings/integrations/api',
  },
  BETTERCONTACT_API_KEY: {
    label: 'BetterContact',
    help: 'Waterfall for work email + mobile (verifies upstream)',
    signupUrl: 'https://bettercontact.rocks/api',
  },
  FULLENRICH_API_KEY: {
    label: 'FullEnrich',
    help: 'Primary for personal email, secondary for work email',
    signupUrl: 'https://app.fullenrich.com/settings/api',
  },
  PDL_API_KEY: {
    label: 'People Data Labs',
    help: 'Personal email + mobile fallback; company job postings',
    signupUrl: 'https://dashboard.peopledatalabs.com/api-keys',
  },
  ZEROBOUNCE_API_KEY: {
    label: 'ZeroBounce',
    help: 'Verifies Apollo + PDL emails before writing',
    signupUrl: 'https://www.zerobounce.net/members/settings/api/',
  },
};

export const SCHEDULE_DAYS: { key: string; label: string }[] = [
  { key: 'monday', label: 'Mon' },
  { key: 'tuesday', label: 'Tue' },
  { key: 'wednesday', label: 'Wed' },
  { key: 'thursday', label: 'Thu' },
  { key: 'friday', label: 'Fri' },
  { key: 'saturday', label: 'Sat' },
  { key: 'sunday', label: 'Sun' },
];

export const COMMON_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'Europe/London',
];

// Default working-hours shape used before a link exists (Mon–Fri 9–5).
export const defaultWorkingHours: Record<string, WorkingWindow[]> = {
  monday: [{ start: '09:00', end: '17:00' }],
  tuesday: [{ start: '09:00', end: '17:00' }],
  wednesday: [{ start: '09:00', end: '17:00' }],
  thursday: [{ start: '09:00', end: '17:00' }],
  friday: [{ start: '09:00', end: '17:00' }],
  saturday: [],
  sunday: [],
};

/** Convert plain text signature to simple HTML for sending */
export const textToHtml = (text: string): string => {
  return text
    .split('\n')
    .map(line => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    .join('<br/>');
};
