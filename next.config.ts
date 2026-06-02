import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

// EdgeOne Pages (and other OpenNext-based platforms) sometimes set
// VERCEL_DEPLOYMENT_ID / VERCEL=1 in the build environment for Next
// compatibility. withWorkflow uses those as the signal to switch to its
// Vercel build path, which produces an output that references a hashed
// `@workflow/world-vercel-<hash>` package that only resolves at runtime on
// real Vercel. Clear them before withWorkflow runs so we get the
// platform-agnostic build that resolves WORKFLOW_TARGET_WORLD at runtime.
delete process.env.VERCEL_DEPLOYMENT_ID;
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;
delete process.env.VERCEL_URL;
delete process.env.VERCEL_PROJECT_ID;

// Force the vendor-agnostic Redis world (not `||=` — we want this even if
// some env var inherited from the platform pointed at something else).
process.env.WORKFLOW_TARGET_WORLD = "@open-workflow/world-redis";

// Reuse the Upstash REST credentials this app already configures for other
// purposes. Our world reads WORKFLOW_REDIS_REST_URL / WORKFLOW_REDIS_REST_TOKEN.
if (
  !process.env.WORKFLOW_REDIS_REST_URL &&
  process.env.UPSTASH_REDIS_REST_URL
) {
  process.env.WORKFLOW_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
}
if (
  !process.env.WORKFLOW_REDIS_REST_TOKEN &&
  process.env.UPSTASH_REDIS_REST_TOKEN
) {
  process.env.WORKFLOW_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
}

// The 307 dispatcher posts back to this server.
process.env.WORKFLOW_BASE_URL ||=
  process.env.APP_BASE_URL ||
  `http://localhost:${process.env.PORT ?? 3000}`;

const nextConfig: NextConfig = {
  reactStrictMode: false,
   typescript: {
    // Dangerously allow production builds to successfully complete even if
    // your project has type errors.
    ignoreBuildErrors: true,
  },
  // world-redis (and its node-redis dep) run on the server only.
  serverExternalPackages: ["@open-workflow/world-redis"],
};

export default withWorkflow(nextConfig);
