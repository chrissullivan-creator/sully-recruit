import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  // Replace with your Trigger.dev project ref from the dashboard
  project: "proj_gfgncbvsppickgyffaat",
  runtime: "node",
  logLevel: "log",
  dirs: ["src/trigger"],
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
    },
  },
});
