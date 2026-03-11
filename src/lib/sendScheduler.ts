/**
 * Send Scheduler — Email Delivery Rules
 * ─────────────────────────────────────
 * All email dispatch MUST go through `allocate_send_time()` in Postgres.
 * This enforces:
 *
 *   • Max 100 emails per company (current_company) per day, across ALL campaigns
 *   • Max 8 emails per company per hour within the send window
 *   • Random minute+second jitter per send — looks human, not batch
 *   • Send window: 6am–9pm (configurable per step, stored as sendWindowStart/End)
 *   • Email channel ONLY — LinkedIn/SMS are not throttled by this system
 *
 * Usage (from the scheduler edge function):
 *
 *   const { data: sendAt } = await supabase.rpc('allocate_send_time', {
 *     p_user_id:      userId,
 *     p_company_name: candidate.current_company,
 *     p_send_date:    '2025-03-15',
 *     p_window_start: step.sendWindowStart,  // default 6
 *     p_window_end:   step.sendWindowEnd,    // default 21
 *     p_tz_offset:    userTimezoneOffsetHours,
 *   });
 *
 *   if (!sendAt) {
 *     // Daily cap hit — push execution to next business day
 *   }
 *
 * Tables:
 *   sequence_enrollments        — who is enrolled in what sequence
 *   sequence_step_executions    — individual send jobs with send_at timestamps
 *   account_daily_send_quota    — running counter per company per day
 */

export {}; // module placeholder until scheduler edge function is built
