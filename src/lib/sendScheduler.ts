/**
 * Send Scheduler — Per-Channel Dispatch Rules
 * ────────────────────────────────────────────
 * Source of truth: channel_dispatch_config table in Supabase.
 * All scheduling logic runs server-side via DB functions.
 *
 * ┌─────────────────────────┬───────────────────────────────────────────────┐
 * │ Channel                 │ Rules                                         │
 * ├─────────────────────────┼───────────────────────────────────────────────┤
 * │ SMS                     │ Fire immediately. No cap, no window, no       │
 * │                         │ jitter. Batch send all at once.               │
 * ├─────────────────────────┼───────────────────────────────────────────────┤
 * │ Email                   │ 100/day cap per company (all campaigns)       │
 * │                         │ 8/hr max per company                          │
 * │                         │ Random minute+second jitter                   │
 * │                         │ Send window: 6am–9pm (per step config)        │
 * │                         │ Call: allocate_send_time()                    │
 * ├─────────────────────────┼───────────────────────────────────────────────┤
 * │ LinkedIn Connection     │ 40 connection requests/day (hard cap)         │
 * │                         │ Random send order within the day              │
 * │                         │ Via Unipile API                               │
 * │                         │ Call: allocate_linkedin_connection()          │
 * ├─────────────────────────┼───────────────────────────────────────────────┤
 * │ LinkedIn Message        │ Only fires after connection is accepted       │
 * │                         │ Hold: 4 hours after acceptance                │
 * │                         │ Jitter: +2 to +30 minutes (random)           │
 * │                         │ send_at = accepted_at + 4hr + rand(2–30min)  │
 * │                         │ Call: schedule_linkedin_first_message()       │
 * └─────────────────────────┴───────────────────────────────────────────────┘
 *
 * Scheduler edge function usage:
 *
 *   // Email
 *   const { data: sendAt } = await supabase.rpc('allocate_send_time', {
 *     p_user_id:      userId,
 *     p_company_name: candidate.company,
 *     p_send_date:    '2025-03-15',
 *     p_window_start: step.sendWindowStart,  // default 6
 *     p_window_end:   step.sendWindowEnd,    // default 21
 *     p_tz_offset:    userTimezoneOffsetHours,
 *   });
 *   if (!sendAt) { // cap hit → push to next business day }
 *
 *   // LinkedIn connection
 *   const { data: granted } = await supabase.rpc('allocate_linkedin_connection', {
 *     p_user_id: userId,
 *     p_send_date: today,
 *   });
 *   if (!granted) { // 40/day cap hit → push to tomorrow }
 *
 *   // LinkedIn first message (called by webhook when connection accepted)
 *   const { data: sendAt } = await supabase.rpc('schedule_linkedin_first_message', {
 *     p_queue_id: connectionQueueId,
 *   });
 *
 *   // SMS — no scheduling needed, fire directly via RingCentral
 */

export {};
