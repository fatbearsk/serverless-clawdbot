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

// Disable @workflow/next's deferred (lazy) route discovery. Lazy mode tells
// Next "this route exists, find it on demand" instead of emitting a real
// route.js — that works on Vercel but on OpenNext-based platforms (EdgeOne)
// the transformation that converts Next output to Functions doesn't preserve
// the deferred mechanism, and the deployed bundle is missing
// .well-known/workflow/v1/flow/route.js entirely (Cannot find module … 500).
// Eager mode materialises the routes into source so they survive the build.
process.env.WORKFLOW_NEXT_LAZY_DISCOVERY = "0";

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
  // OpenNext / EdgeOne strip .well-known/ directories from the deployed
  // function bundle, so the eager-generated flow + webhook route files at
  // app/.well-known/workflow/v1/* are missing at runtime. Mirror routes at
  // app/api/wf/* re-export the same handlers under a non-dot path; these
  // rewrites translate the canonical Workflow SDK URLs to those mirrors so
  // the dispatcher and external webhook callers don't need to change.
  async rewrites() {
    return [
      {
        source: "/.well-known/workflow/v1/flow",
        destination: "/api/wf/flow",
      },
      {
        source: "/.well-known/workflow/v1/webhook/:token",
        destination: "/api/wf/webhook/:token",
      },
    ];
  },
};

export default withWorkflow(nextConfig);
