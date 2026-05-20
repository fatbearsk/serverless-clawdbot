// app/steps/sessionStateSteps.ts
import type { ModelMessage } from "ai";

const historyKey = (sessionId: string) => `sess:${sessionId}:history`;

export async function loadHistoryStep(sessionId: string): Promise<ModelMessage[]> {
  "use step";

  const { Redis } = await import("@upstash/redis");

  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) return [];

  const redis = new Redis({ url, token });
  return (await redis.get(historyKey(sessionId))) ?? [];
}

export async function saveHistoryStep(sessionId: string, history: ModelMessage[]) {
  "use step";

  const { Redis } = await import("@upstash/redis");

  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) return;

  const redis = new Redis({ url, token });
  await redis.set(historyKey(sessionId), history);
}
