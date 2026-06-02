import { NextResponse } from "next/server";
import { getWorld } from "@workflow/core/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Deep peek into the open-workflow Redis world. Shows:
//   - which world / Redis transport is loaded
//   - schedule size (jobs due now)
//   - the 5 most recent runs across all statuses
//   - events for the most recent run (or ?run=<runId> to inspect a specific one)
//   - drains the schedule once and returns the count dispatched
//
//   curl http://localhost:3001/api/debug
//   curl 'http://localhost:3001/api/debug?run=wrun_xxxxxxx'
export async function GET(req: Request) {
  const startedAt = Date.now();
  const target = process.env.WORKFLOW_TARGET_WORLD ?? null;
  const baseUrl = process.env.WORKFLOW_BASE_URL ?? null;
  const prefix = process.env.WORKFLOW_REDIS_KEY_PREFIX ?? "owf";
  const wantRunId = new URL(req.url).searchParams.get("run");

  let label: string | null = null;
  let scheduleSize: number | null = null;
  let dispatched: number | string = "no drainOnce";
  let recentRuns: Array<{
    runId: string;
    status: string;
    workflowName: string;
    createdAt: string;
  }> = [];
  let inspectedRun: string | null = null;
  let runEvents: Array<{
    eventType: string;
    correlationId?: string;
    eventId: string;
    createdAt: string;
  }> = [];
  let error: string | null = null;

  try {
    const w: any = await getWorld();
    label = w?.redis?.label ?? "(unknown)";

    if (typeof w?.redis?.zcard === "function") {
      scheduleSize = await w.redis.zcard(`${prefix}:sched`).catch(() => null);
    }

    // Recent runs (works against the live Redis state regardless of dashboard).
    try {
      const page = await w.runs.list({
        pagination: { limit: 5, sortOrder: "desc" },
        resolveData: "none",
      });
      recentRuns = (page.data ?? []).map((r: any) => ({
        runId: r.runId,
        status: r.status,
        workflowName: r.workflowName,
        createdAt:
          r.createdAt instanceof Date
            ? r.createdAt.toISOString()
            : String(r.createdAt),
      }));
    } catch (err) {
      console.error("[debug] runs.list failed", err);
    }

    inspectedRun = wantRunId ?? recentRuns[0]?.runId ?? null;
    if (inspectedRun) {
      try {
        const page = await w.events.list({
          runId: inspectedRun,
          pagination: { sortOrder: "asc", limit: 50 },
          resolveData: "none",
        });
        runEvents = (page.data ?? []).map((e: any) => ({
          eventType: e.eventType,
          correlationId: e.correlationId,
          eventId: e.eventId,
          createdAt:
            e.createdAt instanceof Date
              ? e.createdAt.toISOString()
              : String(e.createdAt),
        }));
      } catch (err) {
        console.error("[debug] events.list failed", err);
      }
    }

    if (typeof w.drainOnce === "function") {
      dispatched = await w.drainOnce();
    }
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  return NextResponse.json({
    target,
    baseUrl,
    prefix,
    label,
    scheduleSize,
    dispatched,
    recentRuns,
    inspectedRun,
    runEvents,
    error,
    elapsedMs: Date.now() - startedAt,
  });
}

// POST /api/debug — direct probe of world.queue() with a synthetic payload.
// Proves whether the queue write actually reaches Upstash, and what the
// error is if it doesn't.
//
//   curl -X POST http://localhost:3000/api/debug
export async function POST() {
  const prefix = process.env.WORKFLOW_REDIS_KEY_PREFIX ?? "owf";
  const queueName = "__wkf_workflow_workflow//./debug-probe//probe";
  let label: string | null = null;
  let scheduleBefore: number | null = null;
  let scheduleAfter: number | null = null;
  let messageId: string | null = null;
  let queueError: string | null = null;
  let queueStack: string | null = null;
  let jobHash: Record<string, string> | null = null;
  let runRecovery = false;

  try {
    const w: any = await getWorld();
    label = w?.redis?.label ?? "(unknown)";

    scheduleBefore = await w.redis.zcard(`${prefix}:sched`).catch(() => null);

    try {
      const res = await w.queue(
        queueName,
        { runId: "wrun_debugprobe", traceCarrier: {} },
        {}
      );
      messageId = String(res?.messageId ?? "(no id returned)");
    } catch (err) {
      queueError =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      queueStack = err instanceof Error ? err.stack ?? null : null;
    }

    scheduleAfter = await w.redis.zcard(`${prefix}:sched`).catch(() => null);

    // If queue() claims a messageId, peek at the job hash.
    if (messageId) {
      jobHash = await w.redis
        .hgetAll(`${prefix}:job:${messageId}`)
        .catch(() => null);
    }

    // Also drain immediately so any side effects show up.
    if (typeof w.drainOnce === "function") {
      await w.drainOnce();
      runRecovery = true;
    }
  } catch (err) {
    queueError =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  return NextResponse.json({
    label,
    scheduleBefore,
    scheduleAfter,
    messageId,
    queueError,
    queueStack,
    jobHashKeys: jobHash ? Object.keys(jobHash) : null,
    jobHashAttempt: jobHash?.attempt ?? null,
    jobHashRoute: jobHash?.route ?? null,
    drainCalled: runRecovery,
  });
}
