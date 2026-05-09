// Inngest v4 dropped the `./vercel` adapter; the express handler is
// what their Vercel-on-Vite setup guide currently recommends. Express
// serve takes (req, res) which @vercel/node's VercelRequest /
// VercelResponse satisfy — they're Express-shaped extensions of Node's
// IncomingMessage / ServerResponse with body parsing baked in.
import { serve } from "inngest/express";
import { inngest } from "../src/inngest/client";
import { functions } from "../src/inngest/functions";

/**
 * Vercel serverless route serving Inngest functions.
 *
 * - GET    /api/inngest      → introspection (Inngest dashboard / dev server polls this)
 * - POST   /api/inngest      → function execution (Inngest invokes us once per step)
 * - PUT    /api/inngest      → registration (deploy hook syncs functions to Inngest)
 *
 * Each Inngest "step" runs in its own invocation, so individual steps
 * must fit under maxDuration. Pro plan caps at 300s; long-running work
 * is broken into multiple step.run() chunks so each chunk fits.
 */
export const config = {
  maxDuration: 300,
};

export default serve({
  client: inngest,
  functions,
  // INNGEST_SIGNING_KEY (validation) and INNGEST_EVENT_KEY (sending)
  // are read from process.env automatically.
});
