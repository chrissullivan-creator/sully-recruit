import { supabase } from '@/integrations/supabase/client';

/**
 * Returns headers including Content-Type and the current Supabase
 * Bearer token. All /api/* routes that require auth (the trigger-*
 * endpoints and AI endpoints) verify this token via api/lib/auth.ts.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
