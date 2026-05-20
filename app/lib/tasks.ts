import crypto from "crypto";
import { getStore } from "@/app/lib/store";
import type { Channel } from "@/app/lib/identity";

export type Task =
  | {
      id: string;
      type: "send";
      dueAt: number; // epoch ms
      channel: Channel;
      sessionId: string;
      text: string;
      createdAt: number;
      createdBy: "agent" | "system" | "user";
    }
  | {
      id: string;
      type: "noop";
      dueAt: number;
      createdAt: number;
      createdBy: "agent" | "system" | "user";
    };

const ZKEY = "tasks:due"; // sorted set of task IDs by dueAt
const HKEY = "tasks:data"; // hash of taskId -> Task JSON

export async function createSendTask(args: Omit<Extract<Task, { type: "send" }>, "id" | "createdAt">) {
  const store = getStore();
  const id = crypto.randomUUID();
  const task: Task = { ...args, id, createdAt: Date.now() } as any;

  await store.hset(HKEY, id, task);
  await store.zadd(ZKEY, task.dueAt, id);
  return id;
}

export async function fetchDueTaskIds(nowMs: number, limit = 25): Promise<string[]> {
  const store = getStore();
  return await store.zrangebyscore(ZKEY, 0, nowMs, { limit });
}

export async function getTask(id: string): Promise<Task | null> {
  const store = getStore();
  return await store.hget<Task>(HKEY, id);
}

export async function deleteTask(id: string): Promise<void> {
  const store = getStore();
  await store.zrem(ZKEY, id);
  await store.hdel(HKEY, id);
}
