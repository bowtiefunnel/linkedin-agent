import { defineConfig } from "@trigger.dev/sdk";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";

// Env vars the task reads at runtime (see `grep process.env agent/`). The deployed
// prod runtime does NOT read the local .env, so we forward these from process.env
// at deploy time. Excludes TRIGGER_SECRET_KEY (managed per-env automatically).
// Use `npm run deploy` (pinned CLI from devDependencies), NOT `npx trigger.dev@latest`
// — the CLI aborts when its version differs from the installed @trigger.dev/* packages.
const RUNTIME_ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "OPENROUTER_FALLBACK_MODEL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "REPORTS_BUCKET",
  "REPORT_URL_TTL_SECONDS",
  "SLACK_BOT_TOKEN",
  "SLACK_REVIEW_CHANNEL",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_HOST",
  "BRAND_NAME",
  "BRAND_RULES_JSON",
];

export default defineConfig({
  // Unlinked — set TRIGGER_PROJECT_REF once you create a Trigger.dev project for this repo.
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_replace_me",
  // node-22 (not the default node 21.7.3): @supabase/realtime-js needs native
  // WebSocket, which Node 21 doesn't expose — on Node 21 createClient() throws
  // and crashes report/asset uploads. Node 22 has native WebSocket.
  runtime: "node-22",
  logLevel: "info",
  build: {
    extensions: [
      syncEnvVars(() =>
        RUNTIME_ENV_KEYS.filter((k) => process.env[k]).map((k) => ({
          name: k,
          value: process.env[k] as string,
        })),
      ),
    ],
  },
  maxDuration: 3600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      factor: 1.8,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 30_000,
      randomize: true,
    },
  },
  dirs: ["./agent"],
});
