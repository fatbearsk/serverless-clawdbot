import { getStore } from "@/app/lib/store";
import type { Channel } from "@/app/lib/identity";

export type PrimaryTarget = { channel: Channel; sessionId: string };

const KEY_PRIMARY = "autopilot:primary";
const KEY_ENABLED = "autopilot:enabled";
const KEY_INTERVAL = "autopilot:interval_seconds";

export async function getPrimary(): Promise<PrimaryTarget | null> {
  const store = getStore();
  return (await store.get<PrimaryTarget>(KEY_PRIMARY)) ?? null;
}

export async function setPrimary(target: PrimaryTarget): Promise<void> {
  const store = getStore();
  await store.set(KEY_PRIMARY, target);
}

export async function isAutopilotEnabled(): Promise<boolean> {
  const store = getStore();
  return (await store.get<string>(KEY_ENABLED)) === "1";
}

export async function setAutopilotEnabled(enabled: boolean): Promise<void> {
  const store = getStore();
  await store.set(KEY_ENABLED, enabled ? "1" : "0");
}

export async function getIntervalSeconds(): Promise<number> {
  const store = getStore();
  const v = await store.get<string>(KEY_INTERVAL);
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 300; // default 5 minutes
}

export async function setIntervalSeconds(seconds: number): Promise<void> {
  const store = getStore();
  await store.set(KEY_INTERVAL, String(seconds));
}
