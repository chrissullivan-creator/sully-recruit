import nancy from '@/assets/recruiters/nancy.jpeg';
import chris from '@/assets/recruiters/chris.png';

// Recruiter headshots keyed by email (lowercased). Returns the bundled asset
// URL for a known recruiter, else undefined → callers fall back to initials.
// Add a row here when a new recruiter has a photo.
const RECRUITER_AVATARS: Record<string, string> = {
  'nancy.eberlein@emeraldrecruit.com': nancy,
  'chris.sullivan@emeraldrecruit.com': chris,
};

export function recruiterAvatar(email?: string | null): string | undefined {
  if (!email) return undefined;
  return RECRUITER_AVATARS[email.trim().toLowerCase()];
}
