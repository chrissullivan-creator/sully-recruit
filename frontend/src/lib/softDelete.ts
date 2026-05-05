import { supabase } from '@/integrations/supabase/client';

/**
 * Soft-delete one or more rows. Sets deleted_at = now() and stamps the
 * actor on deleted_by_user_id so the Trash page can show "deleted by X".
 * The row stays in the database for 30 days, then gets hard-purged by a
 * pg_cron job. Frontend list queries should filter `deleted_at.is.null`
 * to hide soft-deleted rows.
 *
 * Currently soft-deletable: people, jobs, send_outs, companies.
 */
export type SoftDeletable = 'people' | 'jobs' | 'send_outs' | 'companies';

export async function softDelete(
  table: SoftDeletable,
  idOrIds: string | string[],
): Promise<{ error: { message: string } | null }> {
  const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
  if (ids.length === 0) return { error: null };

  const { data: { user } } = await supabase.auth.getUser();
  const patch = {
    deleted_at: new Date().toISOString(),
    deleted_by_user_id: user?.id ?? null,
  } as any;

  const { error } = await supabase.from(table).update(patch).in('id', ids);
  return { error: error ? { message: error.message } : null };
}

/**
 * Restore a soft-deleted row. Clears deleted_at + deleted_by_user_id.
 * Idempotent — calling on a non-deleted row is a no-op.
 */
export async function restoreSoftDeleted(
  table: SoftDeletable,
  idOrIds: string | string[],
): Promise<{ error: { message: string } | null }> {
  const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
  if (ids.length === 0) return { error: null };

  const { error } = await supabase
    .from(table)
    .update({ deleted_at: null, deleted_by_user_id: null } as any)
    .in('id', ids);
  return { error: error ? { message: error.message } : null };
}
