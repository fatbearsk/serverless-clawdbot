// app/lib/store.ts
import { env } from "@/app/lib/env";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export interface Store {
  get<T = JsonValue>(key: string): Promise<T | null>;
  set<T = JsonValue>(key: string, value: T, opts?: { exSeconds?: number; nx?: boolean }): Promise<boolean>;
  del(key: string): Promise<void>;

  // Hash helpers
  hset<T = JsonValue>(key: string, field: string, value: T): Promise<void>;
  hget<T = JsonValue>(key: string, field: string): Promise<T | null>;
  hdel(key: string, field: string): Promise<void>;

  // Sorted set helpers
  zadd(key: string, score: number, member: string): Promise<void>;
  zrangebyscore(key: string, min: number, max: number, opts?: { limit?: number }): Promise<string[]>;
  zrem(key: string, member: string): Promise<void>;
}

function ensureEventTargetPolyfill() {
  const g: any = globalThis;

  if (typeof g.EventTarget === "undefined") {
    class MiniEventTarget {
      private _listeners = new Map<string, Set<(evt: any) => void>>();

      addEventListener(type: string, cb: (evt: any) => void) {
        if (!cb) return;
        const set = this._listeners.get(type) ?? new Set();
        set.add(cb);
        this._listeners.set(type, set);
      }

      removeEventListener(type: string, cb: (evt: any) => void) {
        this._listeners.get(type)?.delete(cb);
      }

      dispatchEvent(evt: any) {
        const type = evt?.type;
        if (!type) return true;
        const set = this._listeners.get(type);
        if (!set) return true;
        for (const cb of set) cb(evt);
        return true;
      }
    }

    g.EventTarget = MiniEventTarget;
  }

  if (typeof (globalThis as any).Event === "undefined") {
    (globalThis as any).Event = class {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    };
  }
}

class MemoryStore implements Store {
  private map = new Map<string, any>();
  private hmap = new Map<string, Map<string, any>>();
  private zmap = new Map<string, Array<{ score: number; member: string }>>();

  async get<T>(key: string): Promise<T | null> {
    return this.map.has(key) ? (this.map.get(key) as T) : null;
  }
  async set<T>(key: string, value: T, _opts?: { exSeconds?: number; nx?: boolean }): Promise<boolean> {
    this.map.set(key, value);
    return true;
  }
  async del(key: string): Promise<void> {
    this.map.delete(key);
    this.hmap.delete(key);
    this.zmap.delete(key);
  }

  async hset<T>(key: string, field: string, value: T): Promise<void> {
    const h = this.hmap.get(key) ?? new Map<string, any>();
    h.set(field, value);
    this.hmap.set(key, h);
  }
  async hget<T>(key: string, field: string): Promise<T | null> {
    const h = this.hmap.get(key);
    if (!h) return null;
    return h.has(field) ? (h.get(field) as T) : null;
  }
  async hdel(key: string, field: string): Promise<void> {
    const h = this.hmap.get(key);
    if (!h) return;
    h.delete(field);
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    const z = this.zmap.get(key) ?? [];
    z.push({ score, member });
    z.sort((a, b) => a.score - b.score);
    this.zmap.set(key, z);
  }
  async zrangebyscore(key: string, min: number, max: number, opts?: { limit?: number }): Promise<string[]> {
    const z = this.zmap.get(key) ?? [];
    const filtered = z.filter((x) => x.score >= min && x.score <= max).map((x) => x.member);
    if (opts?.limit != null) return filtered.slice(0, opts.limit);
    return filtered;
  }
  async zrem(key: string, member: string): Promise<void> {
    const z = this.zmap.get(key) ?? [];
    this.zmap.set(key, z.filter((x) => x.member !== member));
  }
}

/**
 * Lazy Upstash store:
 * - No top-level import of @upstash/redis (critical for Workflow VM)
 * - Polyfills EventTarget before dynamic import
 * - Keeps getStore() synchronous while all ops remain async
 */
class UpstashStore implements Store {
  private url: string;
  private token: string;
  private redisPromise: Promise<any> | null = null;

  constructor() {
    const url = env("KV_REST_API_URL") ?? env("UPSTASH_REDIS_REST_URL");
    const token = env("KV_REST_API_TOKEN") ?? env("UPSTASH_REDIS_REST_TOKEN");

    if (!url || !token) {
      throw new Error("Missing Redis env vars. Set KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN.");
    }

    this.url = url;
    this.token = token;
  }

  private async redis() {
    if (this.redisPromise) return this.redisPromise;

    this.redisPromise = (async () => {
      ensureEventTargetPolyfill();
      const mod = await import("@upstash/redis");
      const RedisCtor = (mod as any).Redis;
      return new RedisCtor({ url: this.url, token: this.token });
    })();

    return this.redisPromise;
  }

  async get<T>(key: string): Promise<T | null> {
    const r = await this.redis();
    const v = await r.get(key);
    return (v as T) ?? null;
  }

  async set<T>(key: string, value: T, opts?: { exSeconds?: number; nx?: boolean }): Promise<boolean> {
    const r = await this.redis();
    const res = await r.set(key, value as any, {
      ex: opts?.exSeconds,
      nx: opts?.nx,
    } as any);
    return res === "OK" || res === true;
  }

  async del(key: string): Promise<void> {
    const r = await this.redis();
    await r.del(key);
  }

  async hset<T>(key: string, field: string, value: T): Promise<void> {
    const r = await this.redis();
    await r.hset(key, { [field]: value as any } as any);
  }
  async hget<T>(key: string, field: string): Promise<T | null> {
    const r = await this.redis();
    const v = await r.hget(key, field);
    return (v as T) ?? null;
  }
  async hdel(key: string, field: string): Promise<void> {
    const r = await this.redis();
    await r.hdel(key, field);
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    const r = await this.redis();
    await r.zadd(key, { score, member } as any);
  }

  async zrangebyscore(
    key: string,
    min: number,
    max: number,
    opts?: { limit?: number }
  ): Promise<string[]> {
    const r: any = await this.redis();
    const limit = opts?.limit;

    let v: unknown;

    if (typeof r.zrange === "function") {
      v = await r.zrange(key, min, max, {
        byScore: true,
        ...(limit != null ? { offset: 0, count: limit } : {}),
      });
    } else if (typeof r.zrangebyscore === "function") {
      v = await r.zrangebyscore(
        key,
        min,
        max,
        ...(limit != null ? ["LIMIT", 0, limit] : [])
      );
    } else {
      throw new TypeError("Redis client does not support zrange/zrangebyscore");
    }

    if (!Array.isArray(v)) return [];

    if (v.length > 0 && Array.isArray(v[0])) {
      return v.map((row: any) => String(row[0]));
    }

    return v.map((x: any) => String(x));
  }

  async zrem(key: string, member: string): Promise<void> {
    const r = await this.redis();
    await r.zrem(key, member);
  }
}

let _store: Store | null = null;

export function getStore(): Store {
  if (_store) return _store;
  try {
    _store = new UpstashStore();
  } catch {
    _store = new MemoryStore();
  }
  return _store;
}
