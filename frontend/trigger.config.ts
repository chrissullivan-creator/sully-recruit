import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_gfgncbvsppickgyffaat",
  runtime: "node",
  logLevel: "log",
  maxDuration: 300, // 5 minutes max per task run
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
