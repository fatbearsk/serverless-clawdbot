// Shim for @workflow/world-vercel. The Workflow Next.js integration emits a
// bundle that imports this package by name even when WORKFLOW_TARGET_WORLD
// points elsewhere (in our case @open-workflow/world-redis). On Vercel that
// import is fine because the package is in the runtime; on EdgeOne / any
// non-Vercel platform the import is missing and the function fails to load.
//
// We redirect everything to @open-workflow/world-redis so the import resolves
// and the world that actually gets used (via getWorld() reading
// WORKFLOW_TARGET_WORLD) is ours.

import {
  createRedisWorld,
  createWorld,
  NodeRedisClient,
  UpstashRedisClient,
} from "@open-workflow/world-redis";

// Upstream world-vercel exports createVercelWorld(); alias to our createWorld
// so any code path that names it directly still resolves.
export const createVercelWorld = createWorld;

export { createRedisWorld, createWorld, NodeRedisClient, UpstashRedisClient };

export default createWorld;
