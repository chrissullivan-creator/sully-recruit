/**
 * Single export list of every Inngest function. The Vercel serve
 * handler at /api/inngest passes this array to `serve({ functions })`,
 * so adding a new migration is one entry here plus the function file.
 */
import { syncInmailCredits } from "./sync-inmail-credits";
import { sequenceRun } from "./sequence-run";

export const functions = [
  syncInmailCredits,
  sequenceRun,
];
