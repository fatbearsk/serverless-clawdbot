/* agentTurn.ts */
// app/steps/agentTurn.ts
import {
  generateText,
  streamText,
  stepCountIs,
  tool,
  zodSchema,
  type ToolSet,
  type ModelMessage,
} from "ai";
import { openai } from "@ai-sdk/openai";
import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import { z } from "zod/v4";

import { env } from "@/app/lib/env";
import type { Channel } from "@/app/lib/identity";
import { createSendTask } from "@/app/lib/tasks";
import { sshExec } from "@/app/steps/sshExec";

import {
  telegramSendMessage,
  telegramEditMessageText,
  telegramStartChatActionLoop,
  telegramSendPhoto,
  telegramSendDocument,
  telegramSendAudio,
  telegramSendVoice,
} from "@/app/lib/providers/telegram";

// ============================================================
// Composio client
// ============================================================
const composioProvider = new VercelProvider();

type ComposioToolkitSelection = string[] | { enable?: string[]; disable?: string[] };
type ComposioToolSelection = Record<string, string[] | { enable?: string[]; disable?: string[] }>;

type ComposioSessionOverrides = {
  toolkits?: ComposioToolkitSelection;
  tools?: ComposioToolSelection;
  authConfigs?: Record<string, string>;
  connectedAccounts?: Record<string, string>;
  manageConnections?: boolean | { callbackUrl?: string };
  workbench?: { enable?: boolean };
  experimental?: Record<string, unknown>;
};

type AgentTurnComposioConfig = {
  projectApiKey?: string;
  orgApiKey?: string;
  apiBaseUrl?: string;
  session?: ComposioSessionOverrides;
};

// ============================================================
// Upstash Redis-backed VFS
// ============================================================
type RedisClient = any;

type VfsNode =
  | {
      type: "file";
      path: string;
      content: string;
      createdAt: string;
      updatedAt: string;
    }
  | {
      type: "dir";
      path: string;
      createdAt: string;
      updatedAt: string;
    };

type VirtualRuntime = {
  cwd: string;
  sessionId: string;
  userId: string;
  channel: Channel;
  redis: RedisClient;
};

let redisClientPromise: Promise<RedisClient | null> | null = null;

async function getRedisClient(): Promise<RedisClient | null> {
  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
      const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

      if (!url || !token) return null;

      const { Redis } = await import("@upstash/redis");
      return new Redis({ url, token });
    })().catch(() => null);
  }

  return redisClientPromise;
}

function vfsNamespace(userId: string, sessionId: string): string {
  return `vfs:${userId}:${sessionId}`;
}

function vfsPathsKey(userId: string, sessionId: string): string {
  return `${vfsNamespace(userId, sessionId)}:paths`;
}

function vfsNodeKey(userId: string, sessionId: string, path: string): string {
  return `${vfsNamespace(userId, sessionId)}:node:${sanitizePath(path)}`;
}

function vfsMetaKey(userId: string, sessionId: string): string {
  return `${vfsNamespace(userId, sessionId)}:meta`;
}

// ============================================================
// Small helpers
// ============================================================
function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function parseIntOr(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampNonEmptyText(text: string): string {
  const t = String(text ?? "").trimEnd();
  return t.length ? t : "…";
}

function truncateText(text: unknown, max: number): string {
  const s = typeof text === "string" ? text : String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s;
}

function truncateForModelContext(text: unknown, max: number): string {
  const s = typeof text === "string" ? text : String(text ?? "");
  if (s.length <= max) return s;
  if (max <= 80) return s.slice(-max);

  const head = Math.max(20, Math.floor(max * 0.6));
  const tail = Math.max(20, max - head - 32);
  const omitted = s.length - head - tail;

  if (omitted <= 0) return s.slice(0, max);

  return `${s.slice(0, head)}\n...[omitted ${omitted} chars]...\n${s.slice(-tail)}`;
}

function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(String(text ?? ""));
}

function toWebCryptoBufferSource(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

function createNamedUploadBlob(filename: string, mimeType: string, base64: string): Blob | File {
  if (typeof Blob === "undefined") {
    throw new Error("Blob is not available in this runtime");
  }

  const safeName = safeFilenameSegment(filename || "asset.bin");
  const safeMime = String(mimeType || "application/octet-stream").trim() || "application/octet-stream";
  const bytes = base64ToBytes(base64);
  const blob = new Blob([toWebCryptoBufferSource(bytes)], { type: safeMime });

  if (typeof File !== "undefined") {
    try {
      return new File([blob], safeName, { type: safeMime });
    } catch {
      // fall through to a named Blob
    }
  }

  try {
    Object.defineProperty(blob, "name", {
      value: safeName,
      enumerable: true,
      configurable: true,
    });
  } catch {
    // best effort only
  }

  return blob;
}

function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function utf8ByteLength(text: string): number {
  return utf8ToBytes(text).byteLength;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    let chunkBinary = "";
    for (let j = 0; j < chunk.length; j++) {
      chunkBinary += String.fromCharCode(chunk[j]);
    }
    binary += chunkBinary;
  }

  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const clean = String(base64 ?? "").replace(/\s+/g, "");

  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(clean, "base64"));
  }

  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function utf8ToBase64(text: string): string {
  return bytesToBase64(utf8ToBytes(text));
}

function base64ToUtf8(base64: string): string {
  return bytesToUtf8(base64ToBytes(base64));
}

function hexFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto subtle API is not available in this runtime");
  }

  const key = await subtle.importKey(
    "raw",
    toWebCryptoBufferSource(utf8ToBytes(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await subtle.sign("HMAC", key, toWebCryptoBufferSource(utf8ToBytes(message)));
  return hexFromBytes(new Uint8Array(sig));
}

async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto subtle API is not available in this runtime");
  }

  const key = await subtle.importKey(
    "raw",
    toWebCryptoBufferSource(utf8ToBytes(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await subtle.sign("HMAC", key, toWebCryptoBufferSource(utf8ToBytes(message)));
  return bytesToBase64(new Uint8Array(sig));
}

function constantTimeEquals(a: string, b: string): boolean {
  const aBytes = utf8ToBytes(a);
  const bBytes = utf8ToBytes(b);

  if (aBytes.length !== bBytes.length) return false;

  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

function parseWebhookTimestampSeconds(value: string): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) {
    return asNumber > 1_000_000_000_000 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
  }

  const asDate = Date.parse(raw);
  return Number.isFinite(asDate) ? Math.floor(asDate / 1000) : null;
}

function extractWebhookSignatureValue(signatureHeader: string): string {
  const raw = String(signatureHeader ?? "").trim();
  if (!raw) return "";

  const commaParts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  const candidate = commaParts.length > 1 ? commaParts[commaParts.length - 1] : raw;

  if (candidate.includes("=")) {
    return candidate.split("=").slice(1).join("=").trim();
  }

  return candidate.trim();
}

function detectComposioWebhookVersion(payload: unknown): string {
  const obj: any = payload;
  if (!obj || typeof obj !== "object") return "unknown";
  if (obj.type && obj.metadata && Object.prototype.hasOwnProperty.call(obj, "data")) return "V3";
  if (Object.prototype.hasOwnProperty.call(obj, "payload") && Object.prototype.hasOwnProperty.call(obj, "triggerName")) return "V2";
  if (Object.prototype.hasOwnProperty.call(obj, "trigger")) return "V1";
  return "unknown";
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeHistory(history: ModelMessage[]): ModelMessage[] {
  return (history ?? []).map((m) => {
    const c: any = (m as any).content;
    if (typeof c === "string") {
      return { ...m, content: [{ type: "text" as const, text: c }] } as any;
    }
    return m;
  });
}

function extractRecentUserText(history: ModelMessage[]): string {
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  if (!lastUser) return "";
  const c: any = (lastUser as any).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const textParts = c.filter((p) => p?.type === "text" && typeof p?.text === "string").map((p) => p.text);
    return textParts.join("\n").trim();
  }
  return "";
}

function parseSlashCommand(text: string): { cmd: string; arg: string } | null {
  const t = (text ?? "").trim();
  if (!t.startsWith("/")) return null;
  const [cmd, ...rest] = t.split(/\s+/);
  return { cmd: cmd.toLowerCase(), arg: rest.join(" ").trim() };
}

function toSafeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function normalizeSkillName(raw: string): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, "_")
    .replace(/[^a-z0-9_-]/g, "");
}

function normalizeToolkitKey(raw: string): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function sanitizePath(inputPath: string): string {
  let p = String(inputPath ?? "").trim();
  if (!p) p = "/workspace";
  if (!p.startsWith("/")) p = `/workspace/${p}`;
  p = p.replace(/\/+/g, "/");

  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }

  return `/${out.join("/")}`;
}

function dirname(p: string): string {
  const s = sanitizePath(p);
  const idx = s.lastIndexOf("/");
  if (idx <= 0) return "/";
  return s.slice(0, idx);
}

function basename(p: string): string {
  const s = sanitizePath(p);
  if (s === "/") return "";
  const idx = s.lastIndexOf("/");
  return idx >= 0 ? s.slice(idx + 1) : s;
}

function parentDirs(p: string): string[] {
  const s = sanitizePath(p);
  const parts = s.split("/").filter(Boolean);
  const out = ["/"];
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc += `/${parts[i]}`;
    out.push(acc);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function isProbablyUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function isDataUrl(value: unknown): value is string {
  return typeof value === "string" && /^data:/i.test(value.trim());
}

function safeFilenameSegment(value: string): string {
  const s = String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "asset";
}

function inferExtensionFromMime(mimeType: string): string {
  const mime = String(mimeType ?? "").toLowerCase().split(";")[0].trim();
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/svg+xml": "svg",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
    "audio/mp4": "m4a",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "video/x-msvideo": "avi",
    "application/pdf": "pdf",
    "application/json": "json",
    "text/plain": "txt",
    "text/markdown": "md",
    "text/csv": "csv",
    "application/zip": "zip",
  };
  return map[mime] ?? "bin";
}

function inferMimeFromFilename(name: string): string {
  const ext = String(name ?? "").split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    heic: "image/heic",
    heif: "image/heif",
    svg: "image/svg+xml",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
    webm: "video/webm",
    mp4: "video/mp4",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    pdf: "application/pdf",
    json: "application/json",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    zip: "application/zip",
  };
  return map[ext] ?? "application/octet-stream";
}

function guessMimeTypeFromKind(kind: SessionAssetKind): string {
  switch (kind) {
    case "image":
      return "image/*";
    case "audio":
      return "audio/*";
    case "video":
      return "video/*";
    default:
      return "application/octet-stream";
  }
}

function extractMimeTypeFromDataUrl(dataUrl: string): string {
  const match = String(dataUrl ?? "").match(/^data:([^;,]+)(;base64)?,/i);
  return match?.[1]?.toLowerCase() ?? "application/octet-stream";
}

function stripDataUrlPrefix(dataUrl: string): string {
  return String(dataUrl ?? "").replace(/^data:[^,]*,/, "");
}

function estimateBase64Bytes(base64: string): number | null {
  const s = String(base64 ?? "").trim();
  if (!s) return 0;
  const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - padding);
}

function tryUtf8FromBase64(base64: string): string | null {
  try {
    return base64ToUtf8(base64);
  } catch {
    return null;
  }
}


function inferMimeTypeFromBytes(bytes: Uint8Array, fallback = "application/octet-stream"): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.slice(0, 6));
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }

  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }

  if (bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-") return "application/pdf";

  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WAVE"
  ) {
    return "audio/wav";
  }

  if (bytes.length >= 4 && String.fromCharCode(...bytes.slice(0, 4)) === "OggS") return "audio/ogg";
  if (bytes.length >= 3 && String.fromCharCode(...bytes.slice(0, 3)) === "ID3") return "audio/mpeg";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";

  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return "application/zip";
  }

  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(4, 8)) === "ftyp"
  ) {
    const brand = String.fromCharCode(...bytes.slice(8, 12)).toLowerCase();
    if (brand.startsWith("heic") || brand.startsWith("heix") || brand.startsWith("hevc") || brand.startsWith("mif1")) {
      return "image/heic";
    }
    return "video/mp4";
  }

  return fallback;
}

function looksLikeBinaryBase64String(value: string): boolean {
  const clean = String(value ?? "").replace(/\s+/g, "");
  if (clean.length < 64 || clean.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return false;

  try {
    const bytes = base64ToBytes(clean);
    if (bytes.length < 16) return false;

    const inferred = inferMimeTypeFromBytes(bytes, "");
    if (inferred) return true;

    let printable = 0;
    const sample = bytes.slice(0, Math.min(bytes.length, 256));
    for (const byte of sample) {
      if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)) printable += 1;
    }
    return printable / sample.length < 0.75;
  } catch {
    return false;
  }
}

function isTextLikeFilename(filename: string): boolean {
  const ext = String(filename ?? "").split(".").pop()?.toLowerCase() ?? "";
  return [
    "txt","md","markdown","json","jsonl","csv","ts","tsx","js","jsx","mjs","cjs",
    "py","rb","go","java","kt","swift","php","rs","cpp","cc","cxx","c","h","hpp",
    "cs","html","css","scss","less","xml","yaml","yml","ini","conf","toml","env",
    "log","sql","sh","bash","zsh","ps1","dockerfile",
  ].includes(ext);
}

function shouldTreatTextPayloadAsBinaryBase64(args: {
  value: string;
  kind: SessionAssetKind;
  mimeType: string;
  filename: string;
}): boolean {
  if (!looksLikeBinaryBase64String(args.value)) return false;
  if (args.kind === "image" || args.kind === "audio" || args.kind === "video") return true;
  if (args.kind === "file") {
    if (isTextualMimeType(args.mimeType) || isTextLikeFilename(args.filename)) return false;
    return true;
  }
  return false;
}

function tryInferMimeTypeFromBase64(base64: string, fallback: string): string {
  try {
    return inferMimeTypeFromBytes(base64ToBytes(base64), fallback);
  } catch {
    return fallback;
  }
}

function isGenericOrPlaceholderMimeType(mimeType: string): boolean {
  const mime = String(mimeType ?? "").toLowerCase().trim();
  return !mime || mime === "application/octet-stream" || mime.endsWith("/*");
}

function coerceLoadedAssetMimeType(loaded: LoadedSessionAsset): LoadedSessionAsset {
  const nextMimeType = tryInferMimeTypeFromBase64(loaded.base64, loaded.mimeType);
  if (!nextMimeType || nextMimeType === loaded.mimeType) return loaded;
  if (!isGenericOrPlaceholderMimeType(loaded.mimeType) && isTextualMimeType(loaded.mimeType)) return loaded;

  return {
    ...loaded,
    mimeType: nextMimeType,
    dataUrl: loaded.dataUrl ? `data:${nextMimeType};base64,${loaded.base64}` : loaded.dataUrl,
  };
}

function isInspectQuestion(text: string): boolean {
  const q = String(text ?? "").trim().toLowerCase();
  if (!q) return false;
  return /\b(what(?:'s| is)? (?:this|that|in|on)|describe|read|ocr|extract|inspect|analy[sz]e|summari[sz]e|tell me what you see|what do you see|caption)\b/.test(q);
}

function latestUserMessageHasAsset(history: ModelMessage[]): boolean {
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const content: any = (lastUser as any)?.content;
  if (!Array.isArray(content)) return false;
  return content.some((part: any) => isRichMediaPartType(String(part?.type ?? "")));
}


function isTextualMimeType(mimeType: string): boolean {
  const mime = String(mimeType ?? "").toLowerCase();
  return (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("xml") ||
    mime.includes("yaml") ||
    mime.includes("javascript") ||
    mime.includes("typescript") ||
    mime.includes("csv")
  );
}

function pickFirstDefined<T>(...values: Array<T | undefined | null>): T | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

// ============================================================
// Session asset model
// ============================================================
type SessionAssetKind = "image" | "audio" | "video" | "file";
type SessionAssetSource = "url" | "data_url" | "base64" | "text" | "unknown";

type SessionAsset = {
  id: string;
  kind: SessionAssetKind;
  role: string;
  messageIndex: number;
  partIndex: number;
  partType: string;
  filename: string;
  mimeType: string;
  extension: string;
  source: SessionAssetSource;
  url?: string;
  dataUrl?: string;
  base64?: string;
  text?: string;
  sizeBytes?: number | null;
};

type LoadedSessionAsset = {
  base64: string;
  mimeType: string;
  filename: string;
  sizeBytes: number | null;
  source: SessionAssetSource | "fetched_url";
  textPreview?: string | null;
  dataUrl?: string;
};

function isRichMediaPartType(type: string): boolean {
  return ["image", "audio", "video", "file"].includes(String(type ?? "").toLowerCase());
}

function historyHasRichMedia(history: ModelMessage[]): boolean {
  for (const msg of history) {
    const c: any = (msg as any).content;
    if (!Array.isArray(c)) continue;
    if (c.some((p) => isRichMediaPartType(String(p?.type ?? "")))) return true;
  }
  return false;
}

function assetKindFromPart(part: any): SessionAssetKind | null {
  const type = String(part?.type ?? "").toLowerCase();
  if (["image", "audio", "video", "file"].includes(type)) return type as SessionAssetKind;
  if (part?.image || part?.image_url) return "image";
  if (part?.audio || part?.input_audio) return "audio";
  if (part?.video) return "video";
  if (part?.file || part?.filename || part?.mimeType || part?.mediaType) return "file";
  return null;
}

function rawAssetPayloadFromPart(part: any, kind: SessionAssetKind): unknown {
  switch (kind) {
    case "image":
      return pickFirstDefined(part?.image, part?.image_url, part?.url, part?.uri, part?.data);
    case "audio":
      return pickFirstDefined(part?.audio, part?.input_audio?.data, part?.url, part?.uri, part?.data);
    case "video":
      return pickFirstDefined(part?.video, part?.url, part?.uri, part?.data);
    default:
      return pickFirstDefined(part?.file, part?.url, part?.uri, part?.data, part?.bytes, part?.content);
  }
}

function coerceAssetSource(payload: unknown): {
  source: SessionAssetSource;
  url?: string;
  dataUrl?: string;
  base64?: string;
  text?: string;
  sizeBytes?: number | null;
} {
  if (payload == null) return { source: "unknown", sizeBytes: null };

  if (typeof payload === "string") {
    if (isProbablyUrl(payload)) return { source: "url", url: payload.trim(), sizeBytes: null };
    if (isDataUrl(payload)) {
      const base64 = stripDataUrlPrefix(payload);
      return { source: "data_url", dataUrl: payload, base64, sizeBytes: estimateBase64Bytes(base64) };
    }
    return { source: "text", text: payload, sizeBytes: utf8ByteLength(payload) };
  }

  if (payload instanceof Uint8Array) {
    const base64 = bytesToBase64(payload);
    return { source: "base64", base64, sizeBytes: payload.byteLength };
  }

  if (Array.isArray(payload) && payload.every((x) => typeof x === "number")) {
    const bytes = new Uint8Array(payload as ArrayLike<number>);
    const base64 = bytesToBase64(bytes);
    return { source: "base64", base64, sizeBytes: payload.length };
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(payload)) {
    const bytes = new Uint8Array(payload as ArrayLike<number>);
    const base64 = bytesToBase64(bytes);
    return { source: "base64", base64, sizeBytes: bytes.byteLength };
  }

  if (typeof payload === "object") {
    const obj: any = payload;
    const nested = pickFirstDefined(obj?.url, obj?.uri, obj?.href, obj?.data, obj?.base64, obj?.content);
    if (nested !== undefined) return coerceAssetSource(nested);
  }

  return { source: "unknown", text: truncateText(payload, 2000), sizeBytes: null };
}

function buildSessionAsset(part: any, role: string, messageIndex: number, partIndex: number): SessionAsset | null {
  const kind = assetKindFromPart(part);
  if (!kind) return null;

  const partType = String(part?.type ?? kind).toLowerCase();
  const payload = rawAssetPayloadFromPart(part, kind);
  let sourceInfo = coerceAssetSource(payload);

  let mimeType =
    String(
      pickFirstDefined(
        part?.mimeType,
        part?.mediaType,
        part?.contentType,
        part?.input_audio?.format ? `audio/${String(part.input_audio.format).toLowerCase()}` : undefined,
        sourceInfo.dataUrl ? extractMimeTypeFromDataUrl(sourceInfo.dataUrl) : undefined
      ) ?? ""
    ).toLowerCase() || guessMimeTypeFromKind(kind);

  const explicitFilename = String(
    pickFirstDefined(part?.filename, part?.name, part?.fileName, part?.title, part?.metadata?.filename) ?? ""
  ).trim();

  const extension = explicitFilename.includes(".")
    ? explicitFilename.split(".").pop()!.toLowerCase()
    : inferExtensionFromMime(mimeType);

  const filename = explicitFilename || `asset_${messageIndex + 1}_${partIndex + 1}.${extension}`;

  if (
    sourceInfo.source === "text" &&
    shouldTreatTextPayloadAsBinaryBase64({
      value: sourceInfo.text ?? "",
      kind,
      mimeType,
      filename,
    })
  ) {
    const clean = String(sourceInfo.text ?? "").replace(/\s+/g, "");
    sourceInfo = {
      source: "base64",
      base64: clean,
      sizeBytes: estimateBase64Bytes(clean),
    };
  }

  if (!mimeType || mimeType === "application/octet-stream") {
    mimeType = inferMimeFromFilename(filename) || mimeType;
  }

  if (sourceInfo.base64 && (isGenericOrPlaceholderMimeType(mimeType) || mimeType === "text/plain")) {
    mimeType = tryInferMimeTypeFromBase64(sourceInfo.base64, mimeType);
  }

  return {
    id: `asset_m${messageIndex + 1}_p${partIndex + 1}`,
    kind,
    role,
    messageIndex,
    partIndex,
    partType,
    filename: safeFilenameSegment(filename),
    mimeType,
    extension: extension || inferExtensionFromMime(mimeType),
    source: sourceInfo.source,
    url: sourceInfo.url,
    dataUrl: sourceInfo.dataUrl,
    base64: sourceInfo.base64,
    text: sourceInfo.text,
    sizeBytes: sourceInfo.sizeBytes ?? null,
  };
}

function collectSessionAssets(history: ModelMessage[]): SessionAsset[] {
  const assets: SessionAsset[] = [];
  for (let messageIndex = 0; messageIndex < history.length; messageIndex++) {
    const msg: any = history[messageIndex];
    const content = msg?.content;
    if (!Array.isArray(content)) continue;

    for (let partIndex = 0; partIndex < content.length; partIndex++) {
      const asset = buildSessionAsset(content[partIndex], String(msg?.role ?? "user"), messageIndex, partIndex);
      if (asset) assets.push(asset);
    }
  }
  return assets;
}

// ============================================================
// Prompt-safe message sanitization
// ============================================================
function mediaPartToTextPlaceholder(part: any): { type: "text"; text: string } {
  const type = String(part?.type ?? "file").toLowerCase();
  const filename = String(part?.filename ?? part?.name ?? part?.fileName ?? "").trim();
  const mimeType = String(part?.mimeType ?? part?.mediaType ?? part?.contentType ?? "").trim();

  const label = [type, filename || undefined, mimeType || undefined].filter(Boolean).join(" | ");
  return {
    type: "text",
    text: `[${label || "media attachment"} omitted from prompt context; use session asset tools]`,
  };
}

type SanitizeHistoryOptions = {
  maxMessages?: number;
  maxTextChars?: number;
  maxTotalChars?: number;
  maxAssistantMessages?: number;
};

function approximateModelMessageChars(message: ModelMessage): number {
  const content: any = (message as any).content;

  if (typeof content === "string") return content.length;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part?.text === "string") return part.text.length;
        return JSON.stringify(part ?? "").length;
      })
      .reduce((sum, n) => sum + n, 0);
  }

  return 0;
}

function sanitizeMessagesForModel(history: ModelMessage[], opts?: SanitizeHistoryOptions): ModelMessage[] {
  const maxMessages = Math.max(2, opts?.maxMessages ?? parseIntOr(env("AGENT_MAX_HISTORY_MESSAGES"), 8));
  const maxTextChars = Math.max(500, opts?.maxTextChars ?? parseIntOr(env("AGENT_MAX_TEXT_PART_CHARS"), 4000));
  const maxTotalChars = Math.max(
    maxTextChars,
    opts?.maxTotalChars ?? parseIntOr(env("AGENT_MAX_TOTAL_CONTEXT_CHARS"), 24000)
  );
  const maxAssistantMessages = Math.max(
    0,
    opts?.maxAssistantMessages ?? parseIntOr(env("AGENT_MAX_ASSISTANT_HISTORY_MESSAGES"), 3)
  );

  const trimmed = history.slice(-maxMessages);
  const selected: ModelMessage[] = [];
  let totalChars = 0;
  let assistantCount = 0;

  for (let i = trimmed.length - 1; i >= 0; i--) {
    const msg = trimmed[i];
    const role = String((msg as any).role ?? "");

    if (role === "tool") continue;
    if (role === "assistant" && assistantCount >= maxAssistantMessages) continue;

    const content: any = (msg as any).content;
    let candidate: ModelMessage | null = null;

    if (typeof content === "string") {
      if (role === "system" || role === "user" || role === "assistant") {
        candidate = {
          ...msg,
          content: clampNonEmptyText(truncateForModelContext(content, maxTextChars)),
        } as any;
      }
    } else if (Array.isArray(content)) {
      const safeParts: any[] = [];
      for (const part of content) {
        const type = String(part?.type ?? "");

        if (type === "text") {
          safeParts.push({
            type: "text",
            text: clampNonEmptyText(truncateForModelContext(String(part?.text ?? ""), maxTextChars)),
          });
          continue;
        }

        if (type === "image" || type === "audio" || type === "video" || type === "file") {
          safeParts.push(mediaPartToTextPlaceholder(part));
          continue;
        }
      }

      if (!safeParts.length) {
        safeParts.push({ type: "text", text: "…" });
      }

      if (role === "user" || role === "assistant") {
        candidate = { ...msg, content: safeParts } as any;
      } else if (role === "system") {
        candidate = {
          role: "system",
          content: clampNonEmptyText(
            truncateForModelContext(
              safeParts.map((part) => part.text).join("\n"),
              maxTextChars
            )
          ),
        } as any;
      }
    }

    if (!candidate) continue;

    const candidateChars = approximateModelMessageChars(candidate);
    if (selected.length > 0 && totalChars + candidateChars > maxTotalChars) continue;

    if (role === "assistant") assistantCount += 1;
    totalChars += candidateChars;
    selected.push(candidate);
  }

  return selected.reverse();
}

function splitForTelegram(text: string, maxChars: number): string[] {
  const t = String(text ?? "");
  const max = Math.max(500, Math.min(4096, Math.floor(maxChars)));
  const out: string[] = [];
  let i = 0;

  while (i < t.length) {
    let end = Math.min(t.length, i + max);

    if (end < t.length) {
      const windowStart = Math.max(i, end - 250);
      const window = t.slice(windowStart, end);
      const nl = window.lastIndexOf("\n");
      const sp = window.lastIndexOf(" ");
      const cut = Math.max(nl, sp);
      if (cut > 0) end = windowStart + cut;
    }

    if (end <= i) end = Math.min(t.length, i + max);

    const chunk = t.slice(i, end).trim();
    if (chunk) out.push(chunk);
    i = end;
  }

  return out.length ? out : ["…"];
}

function truncateForTelegramLive(text: string, maxChars: number): string {
  const t = clampNonEmptyText(text);
  if (t.length <= maxChars) return t;
  const keep = Math.max(80, maxChars - 24);
  return `${t.slice(0, keep)}\n...[live truncated]`;
}

function singleLineStatus(text: unknown, maxChars = 220): string {
  return truncateText(String(text ?? "").replace(/\s+/g, " ").trim(), maxChars);
}

function summarizeToolPayloadForTelegram(value: unknown, maxChars = 220): string {
  if (value == null) return "";
  const raw = typeof value === "string" ? value : toSafeJson(value);
  return singleLineStatus(raw, maxChars);
}

type TelegramLiveToolState = {
  toolCallId: string;
  toolName: string;
  status: "running" | "done";
  argsPreview?: string;
  resultPreview?: string;
};

function renderTelegramStatus(args: {
  stepNumber: number;
  sawReasoning: boolean;
  tools: TelegramLiveToolState[];
}): string {
  const active = args.tools.filter((tool) => tool.status === "running");
  const done = args.tools.filter((tool) => tool.status === "done").slice(-2);

  const lines: string[] = [args.sawReasoning ? "Thinking…" : "Working…"];

  if (args.stepNumber > 0) {
    lines.push(`Step ${args.stepNumber}`);
  }

  if (active.length) {
    for (const tool of active) {
      lines.push(`⏳ ${tool.toolName}`);
      if (tool.argsPreview) lines.push(`↳ ${tool.argsPreview}`);
    }
    return lines.join("\n");
  }

  if (done.length) {
    for (const tool of done) {
      lines.push(`✅ ${tool.toolName}`);
    }
    return lines.join("\n");
  }

  lines.push("Preparing response…");
  return lines.join("\n");
}

function renderTelegramLiveText(args: {
  fullText: string;
  stepNumber: number;
  sawReasoning: boolean;
  tools: TelegramLiveToolState[];
  maxChars: number;
}): string {
  const statusText = renderTelegramStatus({
    stepNumber: args.stepNumber,
    sawReasoning: args.sawReasoning,
    tools: args.tools,
  });

  const hasActiveTools = args.tools.some((tool) => tool.status === "running");

  if (!args.fullText.trim()) {
    return truncateForTelegramLive(statusText, args.maxChars);
  }

  if (!hasActiveTools) {
    return truncateForTelegramLive(args.fullText, args.maxChars);
  }

  return truncateForTelegramLive(`${args.fullText}\n\n—\n${statusText}`, args.maxChars);
}

// ============================================================
// Inline skill system
// ============================================================
type InlineSkill = {
  name: string;
  whenToUse: string;
  guidance: string[];
  examples?: string[];
};

const INLINE_SKILLS: Record<string, InlineSkill> = {
  routing: {
    name: "routing",
    whenToUse: "Use first when deciding whether to answer directly, use virtual files, SSH, scheduling, or Composio tools.",
    guidance: [
      "Prefer direct answer if no tool is required.",
      "Prefer virtual filesystem tools for drafting, transforming, analyzing, and staging content.",
      "Prefer ssh_exec only for real host-side execution the user explicitly wants.",
      "Prefer Composio tools for external apps/services and auth flows.",
      "Never claim success for a tool-backed action unless the tool returned success.",
    ],
  },
  composio: {
    name: "composio",
    whenToUse: "Use when the user wants to act on external services through Composio or connect a toolkit.",
    guidance: [
      "Namespace all Composio actions to the user ID passed into this agent turn.",
      "Use the Composio session meta tools for discovery, authentication, and execution at runtime.",
      "Let the active Composio project/session determine available toolkits, auth configs, and connected accounts.",
      "Do not pre-route toolkits with keyword scoring or hard-coded auth-config lookups.",
      "Do not fabricate external side effects.",
    ],
  },
  ssh: {
    name: "ssh",
    whenToUse: "Use when the user explicitly wants a real host command or remote inspection.",
    guidance: [
      "Prefer virtual files/tools first for planning and preparation.",
      "Only use ssh_exec for real host actions.",
      "If blocked, instruct the user to use /ssh <command>.",
    ],
  },
  scheduling: {
    name: "scheduling",
    whenToUse: "Use when the user explicitly asks for a delayed reminder or follow-up.",
    guidance: [
      "Use schedule_message only for explicit delayed messaging.",
      "Keep scheduled text concise and action-oriented.",
    ],
  },
  filesystem: {
    name: "filesystem",
    whenToUse: "Use for scratch files, reports, prompt staging, payload generation, and safe transforms.",
    guidance: [
      "Use read_virtual_file for exact file reads.",
      "Use write_virtual_file for drafts, JSON, markdown, scripts, configs, and reports.",
      "Use virtual_shell for listing/searching/moving/copying/deleting files.",
      "Filesystem is persisted in Upstash Redis and scoped to the current user + session.",
      "Prefer keeping work under /workspace.",
    ],
  },
  modalities: {
    name: "modalities",
    whenToUse: "Use when the user message includes images, audio, video, or files that need staging or upload.",
    guidance: [
      "Use list_session_assets to inspect available assets.",
      "Use prepare_session_asset first for metadata and upload hints.",
      "Use asset references like asset://asset_m6_p2 when calling external tools.",
      "The tool execution wrapper resolves asset references deterministically before the external tool runs.",
      "Do not assume all Composio upload tools use the same schema.",
    ],
  },
};

function renderSingleSkill(skill: InlineSkill): string {
  return [
    `# ${skill.name}`,
    `When to use: ${skill.whenToUse}`,
    "",
    "Guidance:",
    ...skill.guidance.map((g) => `- ${g}`),
    ...(skill.examples?.length ? ["", "Examples:", ...skill.examples.map((e) => `- ${e}`)] : []),
  ].join("\n");
}

// ============================================================
// Redis VFS primitives
// ============================================================
async function vfsAllPaths(rt: VirtualRuntime): Promise<string[]> {
  const raw = (await rt.redis.smembers(vfsPathsKey(rt.userId, rt.sessionId))) ?? [];
  return (Array.isArray(raw) ? raw : []).map((x) => sanitizePath(String(x))).sort();
}

async function vfsGetNode(rt: VirtualRuntime, path: string): Promise<VfsNode | undefined> {
  const p = sanitizePath(path);
  const node = await rt.redis.get(vfsNodeKey(rt.userId, rt.sessionId, p));
  if (!node) return undefined;
  return node as VfsNode;
}

async function vfsPutNode(rt: VirtualRuntime, node: VfsNode): Promise<void> {
  const p = sanitizePath(node.path);
  await rt.redis.set(vfsNodeKey(rt.userId, rt.sessionId, p), { ...node, path: p });
  await rt.redis.sadd(vfsPathsKey(rt.userId, rt.sessionId), p);
}

async function vfsRemoveNode(rt: VirtualRuntime, path: string): Promise<void> {
  const p = sanitizePath(path);
  await rt.redis.del(vfsNodeKey(rt.userId, rt.sessionId, p));
  await rt.redis.srem(vfsPathsKey(rt.userId, rt.sessionId), p);
}

async function vfsEnsureDir(rt: VirtualRuntime, path: string): Promise<void> {
  const p = sanitizePath(path);
  const existing = await vfsGetNode(rt, p);

  if (existing) {
    if (existing.type !== "dir") throw new Error(`Path exists and is not a directory: ${p}`);
    return;
  }

  for (const dir of parentDirs(p)) {
    const parent = await vfsGetNode(rt, dir);
    if (!parent) {
      await vfsPutNode(rt, {
        type: "dir",
        path: dir,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    } else if (parent.type !== "dir") {
      throw new Error(`Path exists and is not a directory: ${dir}`);
    }
  }

  await vfsPutNode(rt, {
    type: "dir",
    path: p,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
}

async function vfsWriteFile(rt: VirtualRuntime, path: string, content: string): Promise<void> {
  const p = sanitizePath(path);

  for (const dir of parentDirs(p)) {
    await vfsEnsureDir(rt, dir);
  }

  const existing = await vfsGetNode(rt, p);
  if (existing && existing.type === "dir") {
    throw new Error(`Cannot write file over directory: ${p}`);
  }

  await vfsPutNode(rt, {
    type: "file",
    path: p,
    content,
    createdAt: existing?.type === "file" ? existing.createdAt : nowIso(),
    updatedAt: nowIso(),
  });
}

async function vfsReadFile(rt: VirtualRuntime, path: string): Promise<string> {
  const p = sanitizePath(path);
  const node = await vfsGetNode(rt, p);
  if (!node) throw new Error(`No such file: ${p}`);
  if (node.type !== "file") throw new Error(`Not a file: ${p}`);
  return node.content;
}

async function vfsList(rt: VirtualRuntime, path: string, recursive = false): Promise<string[]> {
  const p = sanitizePath(path);
  const node = await vfsGetNode(rt, p);
  if (!node) throw new Error(`No such path: ${p}`);

  const keys = await vfsAllPaths(rt);

  if (node.type === "file") return [p];

  if (!recursive) {
    return keys.filter((k) => dirname(k) === p && k !== p).sort();
  }

  return keys.filter((k) => k === p || k.startsWith(p === "/" ? "/" : `${p}/`)).sort();
}

async function vfsDelete(rt: VirtualRuntime, path: string, recursive = false): Promise<void> {
  const p = sanitizePath(path);
  const node = await vfsGetNode(rt, p);
  if (!node) throw new Error(`No such path: ${p}`);

  if (node.type === "file") {
    await vfsRemoveNode(rt, p);
    return;
  }

  const keys = await vfsAllPaths(rt);
  const children = keys.filter((k) => k !== p && k.startsWith(`${p}/`));

  if (children.length && !recursive) {
    throw new Error(`Directory not empty: ${p}`);
  }

  for (const child of children.sort((a, b) => b.length - a.length)) {
    await vfsRemoveNode(rt, child);
  }

  await vfsRemoveNode(rt, p);
}

async function vfsMove(rt: VirtualRuntime, fromPath: string, toPath: string): Promise<void> {
  const from = sanitizePath(fromPath);
  const to = sanitizePath(toPath);

  const node = await vfsGetNode(rt, from);
  if (!node) throw new Error(`No such path: ${from}`);
  if (from === "/" || from === "/workspace") throw new Error(`Refusing to move protected path: ${from}`);
  if (to.startsWith(`${from}/`)) throw new Error(`Cannot move a path into itself: ${from} -> ${to}`);

  const keys = await vfsAllPaths(rt);
  const entries = keys.filter((p) => p === from || p.startsWith(`${from}/`)).sort((a, b) => a.length - b.length);

  if (node.type === "file") {
    await vfsWriteFile(rt, to, node.content);
    await vfsRemoveNode(rt, from);
    return;
  }

  for (const oldPath of entries) {
    const oldNode = await vfsGetNode(rt, oldPath);
    if (!oldNode) continue;

    const suffix = oldPath === from ? "" : oldPath.slice(from.length);
    const newPath = sanitizePath(`${to}${suffix}`);

    if (oldNode.type === "dir") {
      await vfsEnsureDir(rt, newPath);
    } else {
      await vfsWriteFile(rt, newPath, oldNode.content);
    }
  }

  for (const oldPath of entries.sort((a, b) => b.length - a.length)) {
    await vfsRemoveNode(rt, oldPath);
  }
}

async function vfsCopy(rt: VirtualRuntime, fromPath: string, toPath: string): Promise<void> {
  const from = sanitizePath(fromPath);
  const to = sanitizePath(toPath);

  const node = await vfsGetNode(rt, from);
  if (!node) throw new Error(`No such path: ${from}`);
  if (to.startsWith(`${from}/`)) throw new Error(`Cannot copy a path into itself: ${from} -> ${to}`);

  const keys = await vfsAllPaths(rt);
  const entries = keys.filter((p) => p === from || p.startsWith(`${from}/`)).sort((a, b) => a.length - b.length);

  if (node.type === "file") {
    await vfsWriteFile(rt, to, node.content);
    return;
  }

  for (const oldPath of entries) {
    const oldNode = await vfsGetNode(rt, oldPath);
    if (!oldNode) continue;

    const suffix = oldPath === from ? "" : oldPath.slice(from.length);
    const newPath = sanitizePath(`${to}${suffix}`);

    if (oldNode.type === "dir") {
      await vfsEnsureDir(rt, newPath);
    } else {
      await vfsWriteFile(rt, newPath, oldNode.content);
    }
  }
}

async function vfsFind(rt: VirtualRuntime, path: string, needle: string): Promise<string[]> {
  const base = sanitizePath(path);
  const all = await vfsList(rt, base, true);
  const q = needle.toLowerCase();
  return all.filter((p) => p.toLowerCase().includes(q));
}

async function vfsGrep(
  rt: VirtualRuntime,
  path: string,
  query: string
): Promise<Array<{ path: string; line: number; text: string }>> {
  const base = sanitizePath(path);
  const all = await vfsList(rt, base, true);
  const q = query.toLowerCase();
  const out: Array<{ path: string; line: number; text: string }> = [];

  for (const p of all) {
    const node = await vfsGetNode(rt, p);
    if (!node || node.type !== "file") continue;

    const lines = node.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(q)) {
        out.push({ path: p, line: i + 1, text: lines[i] });
      }
    }
  }

  return out;
}

async function createVirtualRuntime(args: {
  sessionId: string;
  userId: string;
  channel: Channel;
  userText: string;
  history: ModelMessage[];
  sessionAssets?: SessionAsset[];
}): Promise<VirtualRuntime> {
  const redis = await getRedisClient();
  if (!redis) {
    throw new Error(
      "Upstash Redis is not configured. Set KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN."
    );
  }

  const rt: VirtualRuntime = {
    cwd: "/workspace",
    sessionId: args.sessionId,
    userId: args.userId,
    channel: args.channel,
    redis,
  };

  await vfsEnsureDir(rt, "/");
  await vfsEnsureDir(rt, "/workspace");
  await vfsEnsureDir(rt, "/workspace/context");
  await vfsEnsureDir(rt, "/workspace/skills");
  await vfsEnsureDir(rt, "/workspace/assets");

  await rt.redis.set(vfsMetaKey(args.userId, args.sessionId), {
    sessionId: args.sessionId,
    userId: args.userId,
    channel: args.channel,
    cwd: "/workspace",
    updatedAt: nowIso(),
  });

  await vfsWriteFile(
    rt,
    "/workspace/README.agent.txt",
    [
      "Virtual agent workspace.",
      "",
      "This filesystem is persisted in Upstash Redis and scoped to the current user + session.",
      "Use it for scratch files, reports, payloads, drafts, and analysis artifacts.",
      "",
      `sessionId=${args.sessionId}`,
      `userId=${args.userId}`,
      `channel=${args.channel}`,
      `updatedAt=${nowIso()}`,
    ].join("\n")
  );

  await vfsWriteFile(
    rt,
    "/workspace/context/request.json",
    toSafeJson({
      sessionId: args.sessionId,
      userId: args.userId,
      channel: args.channel,
      userText: truncateText(args.userText, 4000),
      historyCount: args.history.length,
      sessionAssetCount: args.sessionAssets?.length ?? 0,
      createdAt: nowIso(),
    })
  );

  await vfsWriteFile(
    rt,
    "/workspace/context/skills.index.json",
    toSafeJson({
      skills: Object.keys(INLINE_SKILLS),
    })
  );

  await vfsWriteFile(
    rt,
    "/workspace/context/session_assets.index.json",
    toSafeJson({
      assets:
        args.sessionAssets?.map((asset) => ({
          id: asset.id,
          kind: asset.kind,
          role: asset.role,
          filename: asset.filename,
          mimeType: asset.mimeType,
          source: asset.source,
          sizeBytes: asset.sizeBytes ?? null,
          hasUrl: Boolean(asset.url),
          hasInlineData: Boolean(asset.base64 || asset.dataUrl || asset.text),
        })) ?? [],
    })
  );

  for (const skill of Object.values(INLINE_SKILLS)) {
    await vfsWriteFile(rt, `/workspace/skills/${skill.name}.md`, renderSingleSkill(skill));
  }

  return rt;
}

function virtualShellHelp() {
  return [
    "Supported commands:",
    "- pwd",
    "- ls [path]",
    "- tree [path]",
    "- cat <path>",
    "- mkdir <path>",
    "- write <path> <<<TEXT>>>",
    "- rm <path>",
    "- rm -r <path>",
    "- mv <from> <to>",
    "- cp <from> <to>",
    "- find <path> <needle>",
    "- grep <path> <needle>",
    "",
    "Notes:",
    "- This shell operates on the persisted Redis-backed virtual filesystem only.",
    "- Paths default under /workspace when relative.",
    "- For exact file writes/reads, prefer write_virtual_file/read_virtual_file.",
  ].join("\n");
}

function parseVirtualShell(input: string): { ok: true; result: any } | { ok: false; error: string } {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, error: "Empty command" };

  if (raw === "help" || raw === "--help") {
    return { ok: true, result: { command: raw, mode: "help" } };
  }

  const writeMatch = raw.match(/^write\s+(\S+)\s+<<<([\s\S]*)>>>$/);
  if (writeMatch) {
    return {
      ok: true,
      result: {
        command: "write",
        path: writeMatch[1],
        content: writeMatch[2],
      },
    };
  }

  const parts = raw.match(/"[^"]*"|'[^']*'|\S+/g)?.map((s) => s.replace(/^['"]|['"]$/g, "")) ?? [];
  if (!parts.length) return { ok: false, error: "Unable to parse command" };

  const [command, ...rest] = parts;
  return {
    ok: true,
    result: {
      command,
      args: rest,
    },
  };
}

async function execVirtualShell(rt: VirtualRuntime, input: string) {
  const parsed = parseVirtualShell(input);
  if (parsed.ok === false) {
    const parseError = parsed.error;
    return {
      ok: false,
      stdout: "",
      stderr: parseError,
      exitCode: 2,
    };
  }

  const spec = parsed.result;

  try {
    if (spec.mode === "help") {
      return {
        ok: true,
        stdout: virtualShellHelp(),
        stderr: "",
        exitCode: 0,
      };
    }

    if (spec.command === "write") {
      await vfsWriteFile(rt, spec.path, spec.content);
      return {
        ok: true,
        stdout: `Wrote ${sanitizePath(spec.path)}`,
        stderr: "",
        exitCode: 0,
      };
    }

    const args = spec.args ?? [];

    switch (spec.command) {
      case "pwd":
        return { ok: true, stdout: rt.cwd, stderr: "", exitCode: 0 };

      case "ls": {
        const target = args[0] ?? rt.cwd;
        const items = await vfsList(rt, target, false);
        return { ok: true, stdout: items.join("\n"), stderr: "", exitCode: 0 };
      }

      case "tree": {
        const target = args[0] ?? rt.cwd;
        const items = await vfsList(rt, target, true);
        return { ok: true, stdout: items.join("\n"), stderr: "", exitCode: 0 };
      }

      case "cat": {
        if (!args[0]) throw new Error("cat requires a path");
        const content = await vfsReadFile(rt, args[0]);
        return { ok: true, stdout: content, stderr: "", exitCode: 0 };
      }

      case "mkdir": {
        if (!args[0]) throw new Error("mkdir requires a path");
        await vfsEnsureDir(rt, args[0]);
        return { ok: true, stdout: `Created ${sanitizePath(args[0])}`, stderr: "", exitCode: 0 };
      }

      case "rm": {
        if (!args.length) throw new Error("rm requires a path");
        const recursive = args[0] === "-r";
        const target = recursive ? args[1] : args[0];
        if (!target) throw new Error("rm requires a path");
        await vfsDelete(rt, target, recursive);
        return { ok: true, stdout: `Removed ${sanitizePath(target)}`, stderr: "", exitCode: 0 };
      }

      case "mv": {
        if (args.length < 2) throw new Error("mv requires <from> <to>");
        await vfsMove(rt, args[0], args[1]);
        return {
          ok: true,
          stdout: `Moved ${sanitizePath(args[0])} -> ${sanitizePath(args[1])}`,
          stderr: "",
          exitCode: 0,
        };
      }

      case "cp": {
        if (args.length < 2) throw new Error("cp requires <from> <to>");
        await vfsCopy(rt, args[0], args[1]);
        return {
          ok: true,
          stdout: `Copied ${sanitizePath(args[0])} -> ${sanitizePath(args[1])}`,
          stderr: "",
          exitCode: 0,
        };
      }

      case "find": {
        if (args.length < 2) throw new Error("find requires <path> <needle>");
        const items = await vfsFind(rt, args[0], args.slice(1).join(" "));
        return { ok: true, stdout: items.join("\n"), stderr: "", exitCode: 0 };
      }

      case "grep": {
        if (args.length < 2) throw new Error("grep requires <path> <needle>");
        const items = await vfsGrep(rt, args[0], args.slice(1).join(" "));
        return {
          ok: true,
          stdout: items.map((x) => `${x.path}:${x.line}:${x.text}`).join("\n"),
          stderr: "",
          exitCode: 0,
        };
      }

      default:
        return {
          ok: false,
          stdout: "",
          stderr: `Unsupported virtual command "${spec.command}".\n\n${virtualShellHelp()}`,
          exitCode: 2,
        };
    }
  } catch (error: any) {
    return {
      ok: false,
      stdout: "",
      stderr: String(error?.message ?? error ?? "Virtual shell error"),
      exitCode: 1,
    };
  }
}

// ============================================================
// Session asset preparation / materialization
// ============================================================
function describeSessionAsset(asset: SessionAsset) {
  return {
    id: asset.id,
    kind: asset.kind,
    role: asset.role,
    messageIndex: asset.messageIndex,
    partIndex: asset.partIndex,
    partType: asset.partType,
    filename: asset.filename,
    mimeType: asset.mimeType,
    extension: asset.extension,
    source: asset.source,
    sizeBytes: asset.sizeBytes ?? null,
    hasUrl: Boolean(asset.url),
    hasInlineData: Boolean(asset.base64 || asset.dataUrl || asset.text),
    url: asset.url ?? null,
  };
}

async function loadSessionAssetContent(
  asset: SessionAsset,
  opts?: { fetchRemote?: boolean; maxBytes?: number }
): Promise<LoadedSessionAsset> {
  const fetchRemote = opts?.fetchRemote ?? true;
  const maxBytes = Math.max(1024, opts?.maxBytes ?? parseIntOr(env("SESSION_ASSET_MAX_BYTES"), 25 * 1024 * 1024));

  if (asset.base64) {
    const textPreview = isTextualMimeType(asset.mimeType) ? tryUtf8FromBase64(asset.base64) : null;
    return coerceLoadedAssetMimeType({
      base64: asset.base64,
      mimeType: asset.mimeType,
      filename: asset.filename,
      sizeBytes: asset.sizeBytes ?? estimateBase64Bytes(asset.base64),
      source: asset.source,
      textPreview,
      dataUrl: asset.dataUrl ?? `data:${asset.mimeType};base64,${asset.base64}`,
    });
  }

  if (asset.dataUrl) {
    const base64 = stripDataUrlPrefix(asset.dataUrl);
    const textPreview = isTextualMimeType(asset.mimeType) ? tryUtf8FromBase64(base64) : null;
    return coerceLoadedAssetMimeType({
      base64,
      mimeType: asset.mimeType,
      filename: asset.filename,
      sizeBytes: asset.sizeBytes ?? estimateBase64Bytes(base64),
      source: asset.source,
      textPreview,
      dataUrl: asset.dataUrl,
    });
  }

  if (asset.text != null) {
    const base64 = utf8ToBase64(asset.text);
    return {
      base64,
      mimeType: asset.mimeType || "text/plain",
      filename: asset.filename,
      sizeBytes: utf8ByteLength(asset.text),
      source: asset.source,
      textPreview: asset.text,
      dataUrl: `data:${asset.mimeType || "text/plain"};base64,${base64}`,
    };
  }

  if (asset.url && fetchRemote) {
    const response = await fetch(asset.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch asset URL (${response.status} ${response.statusText})`);
    }

    const arr = new Uint8Array(await response.arrayBuffer());
    if (arr.byteLength > maxBytes) {
      throw new Error(`Remote asset too large (${arr.byteLength} bytes > ${maxBytes} bytes)`);
    }

    const base64 = bytesToBase64(arr);
    const contentType =
      response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || asset.mimeType || "application/octet-stream";
    const textPreview = isTextualMimeType(contentType) ? bytesToUtf8(arr) : null;

    return coerceLoadedAssetMimeType({
      base64,
      mimeType: contentType,
      filename: asset.filename,
      sizeBytes: arr.byteLength,
      source: "fetched_url",
      textPreview,
      dataUrl: `data:${contentType};base64,${base64}`,
    });
  }

  throw new Error(`Asset ${asset.id} does not currently have retrievable inline data or an accessible URL`);
}

async function materializeSessionAssetToVfs(
  rt: VirtualRuntime,
  asset: SessionAsset,
  opts?: { fetchRemote?: boolean; includeBase64?: boolean }
) {
  const includeBase64 = opts?.includeBase64 ?? false;
  const loaded = await loadSessionAssetContent(asset, { fetchRemote: opts?.fetchRemote ?? true });
  const assetRoot = sanitizePath(`/workspace/assets/${asset.id}`);
  const metaPath = sanitizePath(`${assetRoot}/meta.json`);
  const rawBase64Path = sanitizePath(`${assetRoot}/${asset.filename}.base64.txt`);
  const textPath = sanitizePath(`${assetRoot}/${asset.filename}.txt`);
  const infoPath = sanitizePath(`${assetRoot}/composio_payload.json`);

  await vfsEnsureDir(rt, assetRoot);

  await vfsWriteFile(
    rt,
    metaPath,
    toSafeJson({
      ...describeSessionAsset(asset),
      loadedMimeType: loaded.mimeType,
      loadedSizeBytes: loaded.sizeBytes,
      loadedSource: loaded.source,
      createdAt: nowIso(),
    })
  );

  if (includeBase64) {
    await vfsWriteFile(rt, rawBase64Path, loaded.base64);
  }

  if (loaded.textPreview != null) {
    await vfsWriteFile(rt, textPath, loaded.textPreview);
  }

  await vfsWriteFile(
    rt,
    infoPath,
    toSafeJson({
      filename: loaded.filename,
      mimeType: loaded.mimeType,
      url: asset.url ?? null,
      dataUrl: includeBase64 ? loaded.dataUrl ?? null : null,
      base64Path: includeBase64 ? rawBase64Path : null,
      textPath: loaded.textPreview != null ? textPath : null,
      notes: [
        "Prefer url when a target Composio tool accepts URL-based file ingestion.",
        "Otherwise request inline content only when the target tool truly requires it.",
        "Not all Composio tools share the same schema; adapt to the declared tool input schema.",
      ],
    })
  );

  return {
    ok: true,
    assetId: asset.id,
    assetRoot,
    metaPath,
    base64Path: includeBase64 ? rawBase64Path : null,
    textPath: loaded.textPreview != null ? textPath : null,
    infoPath,
    loaded,
  };
}

function getPublicBaseUrl(): string | null {
  const value =
    env("ASSET_PUBLIC_BASE_URL") ||
    env("APP_BASE_URL") ||
    env("NEXT_PUBLIC_APP_URL") ||
    env("PUBLIC_APP_URL") ||
    "";
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : null;
}

function getAssetSigningSecret(): string | null {
  const v =
    env("VFS_URL_SIGNING_SECRET") ||
    env("ASSET_URL_SIGNING_SECRET") ||
    env("SESSION_ASSET_SIGNING_SECRET") ||
    "";
  return v.trim() || null;
}

type VfsUrlEncoding = "utf8" | "base64";

type BuildSignedVfsUrlOptions = {
  filename?: string;
  mimeType?: string;
  encoding?: VfsUrlEncoding;
  ttlSeconds?: number;
  download?: boolean;
};

function buildSignedVfsPayload(args: {
  userId: string;
  sessionId: string;
  path: string;
  expiresAt: number;
  filename: string;
  mimeType: string;
  encoding: VfsUrlEncoding;
  download: boolean;
}): string {
  return [
    "v1",
    `userId=${args.userId}`,
    `sessionId=${args.sessionId}`,
    `path=${sanitizePath(args.path)}`,
    `expires=${args.expiresAt}`,
    `filename=${args.filename}`,
    `mimeType=${args.mimeType}`,
    `encoding=${args.encoding}`,
    `download=${args.download ? "1" : "0"}`,
  ].join("\n");
}

async function buildSignedVfsUrl(args: {
  userId: string;
  sessionId: string;
  path: string;
} & BuildSignedVfsUrlOptions): Promise<string | null> {
  const baseUrl = getPublicBaseUrl();
  const secret = getAssetSigningSecret();
  const subtle = globalThis.crypto?.subtle;

  if (!baseUrl || !secret || !subtle) return null;

  const path = sanitizePath(args.path);
  const filename = safeFilenameSegment(args.filename || basename(path) || "file");
  const mimeType = String(args.mimeType || inferMimeFromFilename(filename) || "application/octet-stream")
    .trim()
    .toLowerCase();
  const encoding: VfsUrlEncoding = args.encoding === "base64" ? "base64" : "utf8";
  const download = args.download === true;
  const expiresAt = Math.floor(Date.now() / 1000) + Math.max(60, args.ttlSeconds ?? 900);
  const sig = await hmacSha256Hex(
    secret,
    buildSignedVfsPayload({
      userId: args.userId,
      sessionId: args.sessionId,
      path,
      expiresAt,
      filename,
      mimeType,
      encoding,
      download,
    })
  );

  const encodedPath = path
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  const url = new URL(`${baseUrl}/api/vfs/${encodedPath}`);
  url.searchParams.set("userId", args.userId);
  url.searchParams.set("sessionId", args.sessionId);
  url.searchParams.set("expires", String(expiresAt));
  url.searchParams.set("filename", filename);
  url.searchParams.set("mimeType", mimeType);
  url.searchParams.set("encoding", encoding);
  if (download) url.searchParams.set("download", "1");
  url.searchParams.set("sig", sig);
  return url.toString();
}

async function buildSignedVfsUrlForRuntime(
  rt: VirtualRuntime,
  path: string,
  opts?: BuildSignedVfsUrlOptions
): Promise<string | null> {
  return await buildSignedVfsUrl({
    userId: rt.userId,
    sessionId: rt.sessionId,
    path,
    ...opts,
  });
}

async function buildSignedAssetUrl(asset: SessionAsset, ttlSeconds = 900): Promise<string | null> {
  const baseUrl = getPublicBaseUrl();
  const secret = getAssetSigningSecret();
  const subtle = globalThis.crypto?.subtle;

  if (!baseUrl || !secret || !subtle) return null;

  const expiresAt = Math.floor(Date.now() / 1000) + Math.max(60, ttlSeconds);
  const payload = `${asset.id}.${expiresAt}.${asset.filename}.${asset.mimeType}`;
  const sig = await hmacSha256Hex(secret, payload);

  const url = new URL(`${baseUrl}/api/assets/${encodeURIComponent(asset.id)}`);
  url.searchParams.set("expires", String(expiresAt));
  url.searchParams.set("filename", asset.filename);
  url.searchParams.set("mimeType", asset.mimeType);
  url.searchParams.set("sig", sig);
  return url.toString();
}

function buildPreparedAssetPayload(
  asset: SessionAsset,
  opts?: {
    loaded?: LoadedSessionAsset | null;
    materialized?: {
      assetRoot: string;
      metaPath: string;
      base64Path: string | null;
      textPath: string | null;
      infoPath: string;
    } | null;
    includeInlineData?: boolean;
    signedUrl?: string | null;
  }
) {
  const loaded = opts?.loaded ?? null;
  const materialized = opts?.materialized ?? null;
  const includeInlineData = opts?.includeInlineData ?? false;
  const signedUrl = opts?.signedUrl ?? null;

  const mimeType = loaded?.mimeType ?? asset.mimeType;
  const filename = loaded?.filename ?? asset.filename;
  const sizeBytes = loaded?.sizeBytes ?? asset.sizeBytes ?? null;
  const base64 = includeInlineData ? loaded?.base64 ?? asset.base64 ?? null : null;
  const dataUrl =
    includeInlineData
      ? loaded?.dataUrl ?? asset.dataUrl ?? (base64 ? `data:${mimeType};base64,${base64}` : null)
      : null;

  return {
    asset: describeSessionAsset(asset),
    prepared: {
      filename,
      mimeType,
      sizeBytes,
      url: signedUrl ?? asset.url ?? null,
      dataUrl,
      base64,
      textPreview: includeInlineData ? loaded?.textPreview ?? asset.text ?? null : null,
    },
    composioHints: {
      commonCandidateFields: {
        filename,
        fileName: filename,
        name: filename,
        mimeType,
        mediaType: mimeType,
        contentType: mimeType,
        fileMimeType: mimeType,
        url: signedUrl ?? asset.url ?? null,
        uri: signedUrl ?? asset.url ?? null,
        dataUrl,
        contentBase64: base64,
        base64,
      },
      guidance: [
        "Inspect the target Composio tool schema first.",
        "For URL-style parameters, pass asset://<assetId> and let the execution wrapper resolve it. For upload-style Composio tools, the wrapper stages bytes and supplies the resulting s3key automatically.",
        "For inline file parameters, use asset://<assetId> or an object with assetId and the wrapper will materialize data deterministically.",
      ],
    },
    virtualPaths: materialized
      ? {
          assetRoot: materialized.assetRoot,
          metaPath: materialized.metaPath,
          base64Path: materialized.base64Path,
          textPath: materialized.textPath,
          infoPath: materialized.infoPath,
        }
      : null,
  };
}

// ============================================================
// Deterministic asset URL + tool input resolution
// ============================================================

type AssetResolutionMode = "url" | "dataUrl" | "base64" | "blob" | "file" | "s3key" | "composioFile" | "auto";

type ComposioStagedAsset = {
  s3key: string;
  key: string;
  filename: string;
  mimeType: string;
  sizeBytes: number | null;
  md5Hex: string;
  toolkitSlug: string;
  toolSlug: string;
  uploadRequestType: string | null;
  uploadRequestId: string | null;
};

const composioStagedAssetCache = new Map<string, Promise<ComposioStagedAsset>>();

function isAssetRefString(value: string): boolean {
  return /^asset:\/\/[A-Za-z0-9._:-]+$/.test(String(value ?? "").trim());
}

function assetIdFromRef(value: string): string {
  return String(value ?? "").trim().replace(/^asset:\/\//, "");
}

function maybeAssetIdFromString(value: string, sessionAssets: SessionAsset[]): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;

  if (isAssetRefString(trimmed)) {
    return assetIdFromRef(trimmed);
  }

  if (sessionAssets.some((x) => x.id === trimmed)) {
    return trimmed;
  }

  return null;
}

function isComposioUploadLikeResolutionKey(key: string | null | undefined): boolean {
  const raw = String(key ?? "").trim().toLowerCase();
  if (!raw) return false;

  if (
    /(^|_)(filename|filepath|file_path|fileid|file_id|mime|mimetype|mime_type|filetype|file_type|name|title)$/.test(
      raw
    )
  ) {
    return false;
  }

  const compact = raw.replace(/[^a-z0-9]+/g, "_");
  return (
    /(^|_)(file|files|attachment|attachments|document|documents|media|upload|uploads|image|images|audio|audios|video|videos)$/.test(
      compact
    ) ||
    /(^|_)(inputfile|inputfiles|uploadfile|uploadfiles|fileupload|fileuploads)$/.test(compact)
  );
}

function isExplicitBlobResolutionKey(key: string | null | undefined): boolean {
  const compact = String(key ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  return /(^|_)(blob|blobs|binary|binarybody|binary_body)$/.test(compact);
}

function isLikelyComposioS3KeyTool(toolSlug: string | null | undefined): boolean {
  const slug = String(toolSlug ?? "").trim().toUpperCase();
  if (!slug) return false;
  return (
    slug.includes("UPLOAD") ||
    slug.includes("ATTACH") ||
    slug.includes("SEND_EMAIL") ||
    slug.includes("SEND_DRAFT") ||
    slug.includes("MEDIA")
  );
}

function inferResolutionModeFromContext(args: {
  key?: string | null;
  toolSlug?: string | null;
}): AssetResolutionMode {
  const k = String(args.key ?? "").toLowerCase();

  if (/(^|_)(url|uri|href|link|downloadurl|sourceurl|fileurl)$/.test(k)) return "url";
  if (/(^|_)(dataurl)$/.test(k)) return "dataUrl";
  if (/(^|_)(base64|contentbase64)$/.test(k)) return "base64";
  if (/(^|_)(s3key|s3_key|storagekey|storage_key)$/.test(k)) return "s3key";
  if (isExplicitBlobResolutionKey(k)) return "blob";
  if (isComposioUploadLikeResolutionKey(k)) return "composioFile";
  if (!k && isLikelyComposioS3KeyTool(args.toolSlug)) return "composioFile";

  return "auto";
}

function resolveToolObjectAssetId(input: Record<string, any>): string | null {
  const id = pickFirstDefined(
    typeof input.assetId === "string" ? input.assetId : undefined,
    typeof input.sessionAssetId === "string" ? input.sessionAssetId : undefined,
    typeof input.sourceAssetId === "string" ? input.sourceAssetId : undefined
  );
  return id ? id.trim() : null;
}

function resolveDirectS3KeyAssetField(
  input: Record<string, any>,
  sessionAssets: SessionAsset[]
): { fieldName: string; assetId: string } | null {
  const candidates = ["s3key", "s3Key", "s3_key"];
  for (const fieldName of candidates) {
    const value = input[fieldName];
    if (typeof value !== "string") continue;
    const assetId = maybeAssetIdFromString(value, sessionAssets);
    if (assetId) return { fieldName, assetId };
  }
  return null;
}

function normalizeComposioToolSlug(toolSlug: string): string {
  return String(toolSlug ?? "").trim().toUpperCase();
}

function inferComposioToolkitSlugFromToolSlug(toolSlug: string): string {
  const normalized = normalizeComposioToolSlug(toolSlug);
  if (!normalized) {
    throw new Error("Cannot infer Composio toolkit slug from empty tool slug");
  }

  const underscoreIndex = normalized.indexOf("_");
  const prefix = underscoreIndex > 0 ? normalized.slice(0, underscoreIndex) : normalized;
  return prefix.toLowerCase();
}

function getComposioProjectApiKey(config?: AgentTurnComposioConfig): string {
  return String(config?.projectApiKey ?? env("COMPOSIO_API_KEY") ?? "").trim();
}

function getComposioOrgApiKey(config?: AgentTurnComposioConfig): string {
  return String(
    config?.orgApiKey ??
      env("COMPOSIO_ORG_API_KEY") ??
      env("COMPOSIO_X_ORG_API_KEY") ??
      env("COMPOSIO_ORGANIZATION_API_KEY") ??
      ""
  ).trim();
}

function getComposioApiBaseRoot(config?: AgentTurnComposioConfig): string {
  const raw = String(
    config?.apiBaseUrl ?? env("COMPOSIO_API_BASE_URL") ?? env("COMPOSIO_BASE_URL") ?? "https://backend.composio.dev"
  )
    .trim()
    .replace(/\/+$/, "");

  return raw.replace(/\/api\/v3$/i, "");
}

function getComposioApiBaseUrl(config?: AgentTurnComposioConfig): string {
  return `${getComposioApiBaseRoot(config)}/api/v3`;
}

function buildComposioApiUrl(pathname: string, config?: AgentTurnComposioConfig): string {
  const base = getComposioApiBaseUrl(config);
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base}${path}`;
}

function getComposioProjectCacheScope(config?: AgentTurnComposioConfig): string {
  const apiKey = getComposioProjectApiKey(config);
  return `${getComposioApiBaseRoot(config)}|${apiKey ? apiKey.slice(-12) : "default"}`;
}

function createComposioClient(config?: AgentTurnComposioConfig): Composio {
  return new Composio({
    apiKey: getComposioProjectApiKey(config),
    provider: composioProvider,
    baseUrl: getComposioApiBaseRoot(config),
  } as any);
}

function normalizeComposioApiPath(path: string, config?: AgentTurnComposioConfig): string {
  const raw = String(path ?? "").trim();
  if (!raw) {
    throw new Error("Composio API path is required");
  }

  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    const allowedOrigin = new URL(getComposioApiBaseRoot(config)).origin;
    if (url.origin !== allowedOrigin) {
      throw new Error(`Composio API request origin mismatch: expected ${allowedOrigin}, received ${url.origin}`);
    }

    const normalizedPath = url.pathname.replace(/^\/api\/v3/i, "");
    return `${normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`}${url.search}`;
  }

  const withoutPrefix = raw.replace(/^\/api\/v3/i, "");
  return withoutPrefix.startsWith("/") ? withoutPrefix : `/${withoutPrefix}`;
}

function appendComposioQueryValue(searchParams: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      appendComposioQueryValue(searchParams, key, item);
    }
    return;
  }

  if (typeof value === "object") {
    searchParams.append(key, JSON.stringify(value));
    return;
  }

  searchParams.append(key, String(value));
}

function appendComposioQueryParams(url: URL, query?: Record<string, unknown>): void {
  if (!query) return;

  for (const [key, value] of Object.entries(query)) {
    appendComposioQueryValue(url.searchParams, key, value);
  }
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

type ComposioApiRequestOptions = {
  method?: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  rawBody?: string;
  rawBodyBase64?: string;
  contentType?: string;
  headers?: Record<string, string>;
  authMode?: "project" | "org";
  config?: AgentTurnComposioConfig;
};

async function composioApiRequest(options: ComposioApiRequestOptions) {
  const authMode = options.authMode ?? "project";
  const apiKey = authMode === "org" ? getComposioOrgApiKey(options.config) : getComposioProjectApiKey(options.config);

  if (!apiKey) {
    throw new Error(authMode === "org" ? "COMPOSIO_ORG_API_KEY not set" : "COMPOSIO_API_KEY not set");
  }

  const normalizedPath = normalizeComposioApiPath(options.path, options.config);
  const [pathname, inlineQuery = ""] = normalizedPath.split("?", 2);
  const url = new URL(buildComposioApiUrl(pathname, options.config));

  if (inlineQuery) {
    const inlineParams = new URLSearchParams(inlineQuery);
    inlineParams.forEach((value, key) => {
      url.searchParams.append(key, value);
    });
  }

  appendComposioQueryParams(url, options.query);

  const method = String(
    options.method ??
      (options.body !== undefined || options.rawBody !== undefined || options.rawBodyBase64 !== undefined ? "POST" : "GET")
  )
    .trim()
    .toUpperCase();

  const headers: Record<string, string> = {
    accept: "application/json",
    ...(options.headers ?? {}),
  };

  const authHeaderName = authMode === "org" ? "x-org-api-key" : "x-api-key";
  if (!Object.keys(headers).some((key) => key.toLowerCase() === authHeaderName)) {
    headers[authHeaderName] = apiKey;
  }

  const hasContentTypeHeader = Object.keys(headers).some((key) => key.toLowerCase() === "content-type");
  let body: BodyInit | undefined;

  if (options.rawBodyBase64 !== undefined) {
    body = toWebCryptoBufferSource(base64ToBytes(options.rawBodyBase64));
    if (!hasContentTypeHeader) {
      headers["content-type"] = options.contentType || "application/octet-stream";
    }
  } else if (options.rawBody !== undefined) {
    body = options.rawBody;
    if (!hasContentTypeHeader) {
      headers["content-type"] = options.contentType || "text/plain; charset=utf-8";
    }
  } else if (options.body !== undefined && method !== "GET" && method !== "HEAD") {
    body = JSON.stringify(options.body);
    if (!hasContentTypeHeader) {
      headers["content-type"] = options.contentType || "application/json";
    }
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    body,
  });

  const responseText = await response.text();
  let parsed: unknown = null;

  try {
    parsed = responseText ? JSON.parse(responseText) : null;
  } catch {
    parsed = responseText;
  }

  return {
    ok: response.ok,
    method,
    url: url.toString(),
    status: response.status,
    statusText: response.statusText,
    headers: headersToRecord(response.headers),
    requestId: response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? null,
    data: parsed,
    error: response.ok ? null : extractComposioErrorMessage(parsed),
  };
}

function extractComposioErrorMessage(payload: unknown): string {
  const message =
    (payload as any)?.error?.message ??
    (payload as any)?.message ??
    (payload as any)?.error ??
    (payload as any)?.detail ??
    null;

  if (typeof message === "string" && message.trim()) return message.trim();

  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload ?? "Unknown Composio API error");
  }
}

function md5Add32(a: number, b: number): number {
  return (a + b) >>> 0;
}

function md5RotateLeft(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function md5Cmn(q: number, a: number, b: number, x: number, s: number, t: number): number {
  return md5Add32(md5RotateLeft(md5Add32(md5Add32(a, q), md5Add32(x, t)), s), b);
}

function md5Ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return md5Cmn((b & c) | (~b & d), a, b, x, s, t);
}

function md5Gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return md5Cmn((b & d) | (c & ~d), a, b, x, s, t);
}

function md5Hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return md5Cmn(b ^ c ^ d, a, b, x, s, t);
}

function md5Ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return md5Cmn(c ^ (b | ~d), a, b, x, s, t);
}

function setUint32LittleEndian(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function md5HexFromBytes(input: Uint8Array): string {
  const words = new Array<number>(((((input.length + 8) >>> 6) + 1) * 16)).fill(0);

  let i = 0;
  for (; i < input.length; i++) {
    words[i >> 2] |= input[i] << ((i % 4) * 8);
  }

  words[i >> 2] |= 0x80 << ((i % 4) * 8);

  const bitLength = input.length * 8;
  words[words.length - 2] = bitLength >>> 0;
  words[words.length - 1] = Math.floor(bitLength / 0x100000000) >>> 0;

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  for (let index = 0; index < words.length; index += 16) {
    const oldA = a;
    const oldB = b;
    const oldC = c;
    const oldD = d;

    a = md5Ff(a, b, c, d, words[index + 0], 7, 0xd76aa478);
    d = md5Ff(d, a, b, c, words[index + 1], 12, 0xe8c7b756);
    c = md5Ff(c, d, a, b, words[index + 2], 17, 0x242070db);
    b = md5Ff(b, c, d, a, words[index + 3], 22, 0xc1bdceee);
    a = md5Ff(a, b, c, d, words[index + 4], 7, 0xf57c0faf);
    d = md5Ff(d, a, b, c, words[index + 5], 12, 0x4787c62a);
    c = md5Ff(c, d, a, b, words[index + 6], 17, 0xa8304613);
    b = md5Ff(b, c, d, a, words[index + 7], 22, 0xfd469501);
    a = md5Ff(a, b, c, d, words[index + 8], 7, 0x698098d8);
    d = md5Ff(d, a, b, c, words[index + 9], 12, 0x8b44f7af);
    c = md5Ff(c, d, a, b, words[index + 10], 17, 0xffff5bb1);
    b = md5Ff(b, c, d, a, words[index + 11], 22, 0x895cd7be);
    a = md5Ff(a, b, c, d, words[index + 12], 7, 0x6b901122);
    d = md5Ff(d, a, b, c, words[index + 13], 12, 0xfd987193);
    c = md5Ff(c, d, a, b, words[index + 14], 17, 0xa679438e);
    b = md5Ff(b, c, d, a, words[index + 15], 22, 0x49b40821);

    a = md5Gg(a, b, c, d, words[index + 1], 5, 0xf61e2562);
    d = md5Gg(d, a, b, c, words[index + 6], 9, 0xc040b340);
    c = md5Gg(c, d, a, b, words[index + 11], 14, 0x265e5a51);
    b = md5Gg(b, c, d, a, words[index + 0], 20, 0xe9b6c7aa);
    a = md5Gg(a, b, c, d, words[index + 5], 5, 0xd62f105d);
    d = md5Gg(d, a, b, c, words[index + 10], 9, 0x02441453);
    c = md5Gg(c, d, a, b, words[index + 15], 14, 0xd8a1e681);
    b = md5Gg(b, c, d, a, words[index + 4], 20, 0xe7d3fbc8);
    a = md5Gg(a, b, c, d, words[index + 9], 5, 0x21e1cde6);
    d = md5Gg(d, a, b, c, words[index + 14], 9, 0xc33707d6);
    c = md5Gg(c, d, a, b, words[index + 3], 14, 0xf4d50d87);
    b = md5Gg(b, c, d, a, words[index + 8], 20, 0x455a14ed);
    a = md5Gg(a, b, c, d, words[index + 13], 5, 0xa9e3e905);
    d = md5Gg(d, a, b, c, words[index + 2], 9, 0xfcefa3f8);
    c = md5Gg(c, d, a, b, words[index + 7], 14, 0x676f02d9);
    b = md5Gg(b, c, d, a, words[index + 12], 20, 0x8d2a4c8a);

    a = md5Hh(a, b, c, d, words[index + 5], 4, 0xfffa3942);
    d = md5Hh(d, a, b, c, words[index + 8], 11, 0x8771f681);
    c = md5Hh(c, d, a, b, words[index + 11], 16, 0x6d9d6122);
    b = md5Hh(b, c, d, a, words[index + 14], 23, 0xfde5380c);
    a = md5Hh(a, b, c, d, words[index + 1], 4, 0xa4beea44);
    d = md5Hh(d, a, b, c, words[index + 4], 11, 0x4bdecfa9);
    c = md5Hh(c, d, a, b, words[index + 7], 16, 0xf6bb4b60);
    b = md5Hh(b, c, d, a, words[index + 10], 23, 0xbebfbc70);
    a = md5Hh(a, b, c, d, words[index + 13], 4, 0x289b7ec6);
    d = md5Hh(d, a, b, c, words[index + 0], 11, 0xeaa127fa);
    c = md5Hh(c, d, a, b, words[index + 3], 16, 0xd4ef3085);
    b = md5Hh(b, c, d, a, words[index + 6], 23, 0x04881d05);
    a = md5Hh(a, b, c, d, words[index + 9], 4, 0xd9d4d039);
    d = md5Hh(d, a, b, c, words[index + 12], 11, 0xe6db99e5);
    c = md5Hh(c, d, a, b, words[index + 15], 16, 0x1fa27cf8);
    b = md5Hh(b, c, d, a, words[index + 2], 23, 0xc4ac5665);

    a = md5Ii(a, b, c, d, words[index + 0], 6, 0xf4292244);
    d = md5Ii(d, a, b, c, words[index + 7], 10, 0x432aff97);
    c = md5Ii(c, d, a, b, words[index + 14], 15, 0xab9423a7);
    b = md5Ii(b, c, d, a, words[index + 5], 21, 0xfc93a039);
    a = md5Ii(a, b, c, d, words[index + 12], 6, 0x655b59c3);
    d = md5Ii(d, a, b, c, words[index + 3], 10, 0x8f0ccc92);
    c = md5Ii(c, d, a, b, words[index + 10], 15, 0xffeff47d);
    b = md5Ii(b, c, d, a, words[index + 1], 21, 0x85845dd1);
    a = md5Ii(a, b, c, d, words[index + 8], 6, 0x6fa87e4f);
    d = md5Ii(d, a, b, c, words[index + 15], 10, 0xfe2ce6e0);
    c = md5Ii(c, d, a, b, words[index + 6], 15, 0xa3014314);
    b = md5Ii(b, c, d, a, words[index + 13], 21, 0x4e0811a1);
    a = md5Ii(a, b, c, d, words[index + 4], 6, 0xf7537e82);
    d = md5Ii(d, a, b, c, words[index + 11], 10, 0xbd3af235);
    c = md5Ii(c, d, a, b, words[index + 2], 15, 0x2ad7d2bb);
    b = md5Ii(b, c, d, a, words[index + 9], 21, 0xeb86d391);

    a = md5Add32(a, oldA);
    b = md5Add32(b, oldB);
    c = md5Add32(c, oldC);
    d = md5Add32(d, oldD);
  }

  const out = new Uint8Array(16);
  setUint32LittleEndian(out, 0, a);
  setUint32LittleEndian(out, 4, b);
  setUint32LittleEndian(out, 8, c);
  setUint32LittleEndian(out, 12, d);
  return hexFromBytes(out);
}

async function requestComposioStorageUpload(args: {
  toolkitSlug: string;
  toolSlug: string;
  filename: string;
  mimeType: string;
  md5Hex: string;
  composioConfig?: AgentTurnComposioConfig;
}) {
  const response = await composioApiRequest({
    authMode: "project",
    config: args.composioConfig,
    method: "POST",
    path: "/files/upload/request",
    body: {
      toolkit_slug: args.toolkitSlug,
      tool_slug: normalizeComposioToolSlug(args.toolSlug),
      filename: args.filename,
      mimetype: args.mimeType,
      md5: args.md5Hex,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Composio upload request failed (${response.status} ${response.statusText}): ${response.error ?? "Unknown Composio API error"}`
    );
  }

  const payload: any = response.data;
  const key = String(payload?.key ?? payload?.s3key ?? "").trim();
  if (!key) {
    throw new Error("Composio upload request did not return a storage key");
  }

  return {
    key,
    requestId: payload?.id ? String(payload.id) : null,
    uploadUrl: String(payload?.new_presigned_url ?? payload?.newPresignedUrl ?? "").trim() || null,
    type: payload?.type ? String(payload.type) : null,
    raw: payload,
  };
}

async function uploadBytesToComposioPresignedUrl(args: {
  uploadUrl: string;
  bytes: Uint8Array;
  mimeType: string;
}) {
  const headers: Record<string, string> = {};
  if (args.mimeType) headers["content-type"] = args.mimeType;

  const response = await fetch(args.uploadUrl, {
    method: "PUT",
    headers,
    body: toWebCryptoBufferSource(args.bytes),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Composio presigned upload failed (${response.status} ${response.statusText})${body ? `: ${truncateText(body, 1000)}` : ""}`
    );
  }
}

async function stageAssetToComposioStorageForTool(args: {
  asset: SessionAsset;
  toolkitSlug: string;
  toolSlug: string;
  fetchRemote?: boolean;
  composioConfig?: AgentTurnComposioConfig;
}): Promise<ComposioStagedAsset> {
  const loaded = await loadSessionAssetContent(args.asset, { fetchRemote: args.fetchRemote ?? true });
  const bytes = base64ToBytes(loaded.base64);
  const md5Hex = md5HexFromBytes(bytes);
  const cacheKey = [
    getComposioProjectCacheScope(args.composioConfig),
    args.toolkitSlug,
    normalizeComposioToolSlug(args.toolSlug),
    loaded.filename,
    loaded.mimeType,
    md5Hex,
  ].join("|");

  const existing = composioStagedAssetCache.get(cacheKey);
  if (existing) return await existing;

  const promise = (async () => {
    const request = await requestComposioStorageUpload({
      toolkitSlug: args.toolkitSlug,
      toolSlug: args.toolSlug,
      filename: loaded.filename,
      mimeType: loaded.mimeType,
      md5Hex,
      composioConfig: args.composioConfig,
    });

    if (request.uploadUrl) {
      await uploadBytesToComposioPresignedUrl({
        uploadUrl: request.uploadUrl,
        bytes,
        mimeType: loaded.mimeType,
      });
    }

    return {
      s3key: request.key,
      key: request.key,
      filename: loaded.filename,
      mimeType: loaded.mimeType,
      sizeBytes: loaded.sizeBytes,
      md5Hex,
      toolkitSlug: args.toolkitSlug,
      toolSlug: normalizeComposioToolSlug(args.toolSlug),
      uploadRequestType: request.type,
      uploadRequestId: request.requestId,
    };
  })();

  composioStagedAssetCache.set(cacheKey, promise);

  try {
    return await promise;
  } catch (error) {
    composioStagedAssetCache.delete(cacheKey);
    throw error;
  }
}

function buildMinimalComposioStagedFilePayload(staged: ComposioStagedAsset) {
  return {
    s3key: staged.s3key,
    name: staged.filename,
    mimetype: staged.mimeType,
  };
}

async function resolveAssetForToolExecution(args: {
  asset: SessionAsset;
  mode: AssetResolutionMode;
  toolSlug?: string | null;
  toolkitSlug?: string | null;
  fetchRemote?: boolean;
  composioConfig?: AgentTurnComposioConfig;
}): Promise<{
  filename: string;
  mimeType: string;
  url: string | null;
  dataUrl: string | null;
  base64: string | null;
  blob: Blob | File | null;
  staged: ComposioStagedAsset | null;
  sizeBytes: number | null;
}> {
  const mode = args.mode;
  const asset = args.asset;
  const signedUrl = await buildSignedAssetUrl(asset);
  const toolSlug = normalizeComposioToolSlug(args.toolSlug ?? "");
  const toolkitSlug = String(args.toolkitSlug ?? "").trim().toLowerCase() || (toolSlug ? inferComposioToolkitSlugFromToolSlug(toolSlug) : "");

  if (mode === "url") {
    if (signedUrl || asset.url) {
      return {
        filename: asset.filename,
        mimeType: asset.mimeType,
        url: signedUrl ?? asset.url ?? null,
        dataUrl: null,
        base64: null,
        blob: null,
        staged: null,
        sizeBytes: asset.sizeBytes ?? null,
      };
    }

    const loaded = await loadSessionAssetContent(asset, { fetchRemote: args.fetchRemote ?? true });
    return {
      filename: loaded.filename,
      mimeType: loaded.mimeType,
      url: null,
      dataUrl: loaded.dataUrl ?? `data:${loaded.mimeType};base64,${loaded.base64}`,
      base64: loaded.base64,
      blob: null,
      staged: null,
      sizeBytes: loaded.sizeBytes,
    };
  }

  if (mode === "base64") {
    const loaded = await loadSessionAssetContent(asset, { fetchRemote: args.fetchRemote ?? true });
    return {
      filename: loaded.filename,
      mimeType: loaded.mimeType,
      url: signedUrl ?? asset.url ?? null,
      dataUrl: loaded.dataUrl ?? null,
      base64: loaded.base64,
      blob: null,
      staged: null,
      sizeBytes: loaded.sizeBytes,
    };
  }

  if (mode === "dataUrl") {
    const loaded = await loadSessionAssetContent(asset, { fetchRemote: args.fetchRemote ?? true });
    return {
      filename: loaded.filename,
      mimeType: loaded.mimeType,
      url: signedUrl ?? asset.url ?? null,
      dataUrl: loaded.dataUrl ?? `data:${loaded.mimeType};base64,${loaded.base64}`,
      base64: loaded.base64,
      blob: null,
      staged: null,
      sizeBytes: loaded.sizeBytes,
    };
  }

  if (mode === "blob" || mode === "file") {
    const loaded = await loadSessionAssetContent(asset, { fetchRemote: args.fetchRemote ?? true });
    return {
      filename: loaded.filename,
      mimeType: loaded.mimeType,
      url: signedUrl ?? asset.url ?? null,
      dataUrl: loaded.dataUrl ?? `data:${loaded.mimeType};base64,${loaded.base64}`,
      base64: loaded.base64,
      blob: createNamedUploadBlob(loaded.filename, loaded.mimeType, loaded.base64),
      staged: null,
      sizeBytes: loaded.sizeBytes,
    };
  }

  if (mode === "s3key" || mode === "composioFile") {
    if (!toolSlug || !toolkitSlug) {
      throw new Error("Composio asset staging requires a target tool slug and toolkit slug");
    }

    const staged = await stageAssetToComposioStorageForTool({
      asset,
      toolSlug,
      toolkitSlug,
      fetchRemote: args.fetchRemote ?? true,
      composioConfig: args.composioConfig,
    });

    return {
      filename: staged.filename,
      mimeType: staged.mimeType,
      url: signedUrl ?? asset.url ?? null,
      dataUrl: null,
      base64: null,
      blob: null,
      staged,
      sizeBytes: staged.sizeBytes,
    };
  }

  if (signedUrl || asset.url) {
    return {
      filename: asset.filename,
      mimeType: asset.mimeType,
      url: signedUrl ?? asset.url ?? null,
      dataUrl: null,
      base64: null,
      blob: null,
      staged: null,
      sizeBytes: asset.sizeBytes ?? null,
    };
  }

  const loaded = await loadSessionAssetContent(asset, { fetchRemote: args.fetchRemote ?? true });
  return {
    filename: loaded.filename,
    mimeType: loaded.mimeType,
    url: null,
    dataUrl: loaded.dataUrl ?? `data:${loaded.mimeType};base64,${loaded.base64}`,
    base64: loaded.base64,
    blob: null,
    staged: null,
    sizeBytes: loaded.sizeBytes,
  };
}

function isComposioMetaToolSlug(toolSlug: string | null | undefined): boolean {
  return normalizeComposioToolSlug(toolSlug ?? "").startsWith("COMPOSIO_");
}

function isComposioExecutionMetaTool(toolSlug: string | null | undefined): boolean {
  const slug = normalizeComposioToolSlug(toolSlug ?? "");
  return slug === "COMPOSIO_MULTI_EXECUTE_TOOL" || slug === "COMPOSIO_EXECUTE_TOOL";
}

function normalizePotentialToolSlug(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const normalized = normalizeComposioToolSlug(raw);
  return normalized || null;
}

function extractTargetToolSlugFromExecutionPayload(input: Record<string, any>): string | null {
  const direct = pickFirstDefined(
    typeof input.tool === "string" ? input.tool : undefined,
    typeof input.toolSlug === "string" ? input.toolSlug : undefined,
    typeof input.tool_slug === "string" ? input.tool_slug : undefined,
    typeof input.slug === "string" ? input.slug : undefined
  );

  const directSlug = normalizePotentialToolSlug(direct);
  if (directSlug && !isComposioMetaToolSlug(directSlug)) {
    return directSlug;
  }

  for (const key of ["tools", "calls", "executions", "requests", "operations"] as const) {
    const list = input[key];
    if (!Array.isArray(list)) continue;

    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const nested = extractTargetToolSlugFromExecutionPayload(item as Record<string, any>);
      if (nested) return nested;
    }
  }

  return null;
}

function resolveEffectiveAssetContext(
  input: Record<string, any>,
  ctx: {
    sessionAssets: SessionAsset[];
    currentKey?: string;
    toolSlug?: string;
    toolkitSlug?: string;
    fetchRemote?: boolean;
  }
): { toolSlug?: string; toolkitSlug?: string } {
  if (!isComposioExecutionMetaTool(ctx.toolSlug)) {
    return {
      toolSlug: ctx.toolSlug,
      toolkitSlug: ctx.toolkitSlug,
    };
  }

  const targetToolSlug = extractTargetToolSlugFromExecutionPayload(input);
  if (!targetToolSlug || isComposioMetaToolSlug(targetToolSlug)) {
    return {
      toolSlug: ctx.toolSlug,
      toolkitSlug: ctx.toolkitSlug,
    };
  }

  return {
    toolSlug: targetToolSlug,
    toolkitSlug: inferComposioToolkitSlugFromToolSlug(targetToolSlug),
  };
}

async function transformToolInputAssets(
  value: unknown,
  ctx: {
    sessionAssets: SessionAsset[];
    currentKey?: string;
    toolSlug?: string;
    toolkitSlug?: string;
    fetchRemote?: boolean;
    composioConfig?: AgentTurnComposioConfig;
  }
): Promise<unknown> {
  if (typeof value === "string") {
    const assetId = maybeAssetIdFromString(value, ctx.sessionAssets);
    if (assetId) {
      const asset = ctx.sessionAssets.find((x) => x.id === assetId);
      if (!asset) return value;

      const mode = inferResolutionModeFromContext({
        key: ctx.currentKey,
        toolSlug: ctx.toolSlug,
      });

      const resolved = await resolveAssetForToolExecution({
        asset,
        mode,
        toolSlug: ctx.toolSlug,
        toolkitSlug: ctx.toolkitSlug,
        fetchRemote: ctx.fetchRemote ?? true,
        composioConfig: ctx.composioConfig,
      });

      if (mode === "s3key") return resolved.staged?.s3key ?? value;
      if (mode === "composioFile") return resolved.staged ? buildMinimalComposioStagedFilePayload(resolved.staged) : value;
      if (mode === "base64") return resolved.base64 ?? value;
      if (mode === "dataUrl") return resolved.dataUrl ?? value;
      if (mode === "blob" || mode === "file") return resolved.blob ?? resolved.dataUrl ?? resolved.base64 ?? value;
      if (mode === "url") return resolved.url ?? resolved.dataUrl ?? resolved.base64 ?? value;

      return resolved.url ?? resolved.dataUrl ?? resolved.base64 ?? value;
    }
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      out.push(await transformToolInputAssets(item, ctx));
    }
    return out;
  }

  if (value && typeof value === "object") {
    const input = value as Record<string, any>;
    const effectiveContext = resolveEffectiveAssetContext(input, ctx);
    const nextCtxBase = {
      ...ctx,
      toolSlug: effectiveContext.toolSlug,
      toolkitSlug: effectiveContext.toolkitSlug,
    };

    const directS3KeyAsset = resolveDirectS3KeyAssetField(input, ctx.sessionAssets);
    if (directS3KeyAsset) {
      const asset = ctx.sessionAssets.find((x) => x.id === directS3KeyAsset.assetId);
      if (!asset) return value;

      const resolved = await resolveAssetForToolExecution({
        asset,
        mode: "s3key",
        toolSlug: nextCtxBase.toolSlug,
        toolkitSlug: nextCtxBase.toolkitSlug,
        fetchRemote: nextCtxBase.fetchRemote ?? true,
        composioConfig: nextCtxBase.composioConfig,
      });

      if (!resolved.staged) return value;

      const next: Record<string, any> = {
        ...input,
        [directS3KeyAsset.fieldName]: resolved.staged.s3key,
      };

      if (
        next.name == null &&
        next.filename == null &&
        next.fileName == null &&
        next.title == null
      ) {
        next.name = resolved.staged.filename;
      }

      if (
        next.mimetype == null &&
        next.mimeType == null &&
        next.contentType == null &&
        next.mediaType == null
      ) {
        next.mimetype = resolved.staged.mimeType;
      }

      const transformedEntries = await Promise.all(
        Object.entries(next).map(async ([k, v]) => [
          k,
          await transformToolInputAssets(v, {
            ...nextCtxBase,
            currentKey: k,
          }),
        ])
      );
      return Object.fromEntries(transformedEntries);
    }

    const objectAssetId = resolveToolObjectAssetId(input);

    if (objectAssetId) {
      const asset = ctx.sessionAssets.find((x) => x.id === objectAssetId);
      if (!asset) return value;

      const explicitMode = String(input._assetMode ?? "").trim() as AssetResolutionMode;
      const inferredMode = inferResolutionModeFromContext({
        key: ctx.currentKey,
        toolSlug: nextCtxBase.toolSlug,
      });

      const mode: AssetResolutionMode =
        explicitMode === "url" ||
        explicitMode === "dataUrl" ||
        explicitMode === "base64" ||
        explicitMode === "blob" ||
        explicitMode === "file" ||
        explicitMode === "s3key" ||
        explicitMode === "composioFile" ||
        explicitMode === "auto"
          ? explicitMode
          : inferredMode;

      const resolved = await resolveAssetForToolExecution({
        asset,
        mode,
        toolSlug: nextCtxBase.toolSlug,
        toolkitSlug: nextCtxBase.toolkitSlug,
        fetchRemote: nextCtxBase.fetchRemote ?? true,
        composioConfig: nextCtxBase.composioConfig,
      });

      const next: Record<string, any> = { ...input };
      delete next.assetId;
      delete next.sessionAssetId;
      delete next.sourceAssetId;
      delete next._assetMode;

      if (mode === "s3key" || mode === "composioFile") {
        if (resolved.staged) {
          if (next.s3key == null && next.s3Key == null && next.s3_key == null) {
            next.s3key = resolved.staged.s3key;
          }

          if (
            next.name == null &&
            next.filename == null &&
            next.fileName == null &&
            next.title == null
          ) {
            next.name = resolved.staged.filename;
          }

          if (
            next.mimetype == null &&
            next.mimeType == null &&
            next.contentType == null &&
            next.mediaType == null
          ) {
            next.mimetype = resolved.staged.mimeType;
          }
        }
      } else {
        if (next.filename == null && next.fileName == null && next.name == null) {
          next.filename = resolved.filename;
        }
        if (next.mimeType == null && next.mediaType == null && next.contentType == null) {
          next.mimeType = resolved.mimeType;
        }
      }

      const wantsUrlFields =
        "url" in next ||
        "uri" in next ||
        "href" in next ||
        "link" in next ||
        "downloadUrl" in next ||
        "sourceUrl" in next ||
        mode === "url" ||
        mode === "auto";

      if (wantsUrlFields && resolved.url) {
        if (next.url == null) next.url = resolved.url;
        if (next.uri == null) next.uri = resolved.url;
      }

      if (mode === "dataUrl" || ("dataUrl" in next && next.dataUrl == null)) {
        if (resolved.dataUrl) next.dataUrl = resolved.dataUrl;
      }

      if (
        mode === "base64" ||
        ("base64" in next && next.base64 == null) ||
        ("contentBase64" in next && next.contentBase64 == null)
      ) {
        if (resolved.base64) {
          if (next.base64 == null) next.base64 = resolved.base64;
          if (next.contentBase64 == null) next.contentBase64 = resolved.base64;
        }
      }

      if (mode === "blob" || mode === "file") {
        const uploadFieldCandidates = ["file", "blob", "attachment", "document", "media"];
        const candidate = uploadFieldCandidates.find((field) => next[field] == null);
        if (candidate && resolved.blob) {
          next[candidate] = resolved.blob;
        }
      }

      const transformedEntries = await Promise.all(
        Object.entries(next).map(async ([k, v]) => [
          k,
          await transformToolInputAssets(v, {
            ...nextCtxBase,
            currentKey: k,
          }),
        ])
      );
      return Object.fromEntries(transformedEntries);
    }

    const transformedEntries = await Promise.all(
      Object.entries(input).map(async ([k, v]) => [
        k,
        await transformToolInputAssets(v, {
          ...nextCtxBase,
          currentKey: k,
        }),
      ])
    );
    return Object.fromEntries(transformedEntries);
  }

  return value;
}

function wrapComposioToolsWithAssetResolution(
  composioTools: ToolSet,
  deps: {
    sessionAssets: SessionAsset[];
    composioConfig?: AgentTurnComposioConfig;
  }
): ToolSet {
  const wrapped: Record<string, any> = {};

  for (const [toolName, toolDef] of Object.entries(composioTools as Record<string, any>)) {
    if (!toolDef || typeof toolDef !== "object" || typeof toolDef.execute !== "function") {
      wrapped[toolName] = toolDef;
      continue;
    }

    const normalizedToolSlug = normalizeComposioToolSlug(toolName);
    const toolkitSlug = isComposioMetaToolSlug(normalizedToolSlug)
      ? undefined
      : inferComposioToolkitSlugFromToolSlug(normalizedToolSlug);

    wrapped[toolName] = {
      ...toolDef,
      execute: async (input: any, ...rest: any[]) => {
        const resolvedInput = await transformToolInputAssets(input, {
          sessionAssets: deps.sessionAssets,
          toolSlug: normalizedToolSlug,
          toolkitSlug,
          fetchRemote: true,
          composioConfig: deps.composioConfig,
        });
        return await toolDef.execute(resolvedInput, ...rest);
      },
    };
  }

  return wrapped as ToolSet;
}

function isReasoningModel(modelName: string): boolean {
  const name = String(modelName ?? "").trim().toLowerCase();
  return /^gpt-5(?:[.-]|$)/.test(name) || /^o[134](?:[.-]|$)/.test(name) || name.includes("reasoning");
}

function shouldSendTemperature(modelName: string, temperature: number): boolean {
  return Number.isFinite(temperature) && !isReasoningModel(modelName);
}

function buildModelCallArgs(args: {
  modelName: string;
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  temperature: number;
  maxToolSteps: number;
}) {
  const request: any = {
    model: openai(args.modelName),
    system: args.system,
    messages: args.messages,
    tools: args.tools,
    stopWhen: stepCountIs(args.maxToolSteps),
  };

  if (shouldSendTemperature(args.modelName, args.temperature)) {
    request.temperature = args.temperature;
  }

  return request;
}

function stringifyError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return `${error.name}: ${error.message}`;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error ?? "");
  }
}

function isPromptBudgetRetryableError(error: unknown): boolean {
  const text = stringifyError(error).toLowerCase();
  return (
    text.includes("rate_limit_exceeded") ||
    text.includes("context_length_exceeded") ||
    text.includes("tokens per min") ||
    (text.includes("requested") && text.includes("tokens"))
  );
}

function buildComposioSessionOptions(overrides?: ComposioSessionOverrides): ComposioSessionOverrides {
  const callbackUrl =
    env("COMPOSIO_CALLBACK_URL") ||
    env("COMPOSIO_MANAGE_CONNECTIONS_CALLBACK_URL") ||
    undefined;

  const disableInChatAuth = (env("COMPOSIO_DISABLE_IN_CHAT_AUTH") ?? "false") === "true";

  const base: ComposioSessionOverrides = disableInChatAuth
    ? { manageConnections: false }
    : callbackUrl
      ? { manageConnections: { callbackUrl } }
      : { manageConnections: true };

  if (!overrides) return base;

  return {
    ...base,
    ...overrides,
  };
}

async function createComposioSessionForUser(
  userId: string,
  overrides?: ComposioSessionOverrides,
  composioConfig?: AgentTurnComposioConfig
) {
  if (!getComposioProjectApiKey(composioConfig)) {
    throw new Error("COMPOSIO_API_KEY not set");
  }

  const composio = createComposioClient(composioConfig);
  return await composio.create(userId, buildComposioSessionOptions(overrides) as any);
}

function coerceComposioToolsToToolSet(sessionTools: unknown): ToolSet {
  if (!sessionTools) return {};

  if (Array.isArray(sessionTools)) {
    throw new Error(
      "Composio session.tools() returned an array instead of a Vercel AI SDK ToolSet. Ensure the SDK is initialized with new VercelProvider()."
    );
  }

  if (typeof sessionTools !== "object") {
    throw new Error(
      `Composio session.tools() returned ${typeof sessionTools} instead of a Vercel AI SDK ToolSet.`
    );
  }

  return sessionTools as unknown as ToolSet;
}

async function getComposioToolsForUser(
  userId: string,
  overrides?: ComposioSessionOverrides,
  composioConfig?: AgentTurnComposioConfig
): Promise<ToolSet> {
  if (!getComposioProjectApiKey(composioConfig)) return {};

  const session = await createComposioSessionForUser(userId, overrides, composioConfig);
  const sessionTools = await session.tools();
  return coerceComposioToolsToToolSet(sessionTools);
}

// ============================================================
// Telegram streaming coalescer
// ============================================================
function createEditCoalescer(opts: {
  sessionId: string;
  messageId: number;
  throttleMs: number;
}) {
  let lastSent = "";
  let lastAt = 0;

  let inflight: Promise<void> | null = null;
  let pendingStatus: string | null = null;
  let typewriterTarget: string | null = null;
  let displayedTypewriterText = "";
  let mode: "status" | "typewriter" = "status";

  async function doEdit(text: string) {
    const t = clampNonEmptyText(text);
    if (t === lastSent) return;

    const now = Date.now();
    const wait = opts.throttleMs - (now - lastAt);
    if (wait > 0) await sleep(wait);

    try {
      await telegramEditMessageText(opts.sessionId, opts.messageId, t);
      lastSent = t;
      lastAt = Date.now();
    } catch {
      // best effort
    }
  }

  function nextTypewriterFrame(target: string): string {
    const charsPerTick = 12;

    if (!displayedTypewriterText) {
      return target.slice(0, charsPerTick);
    }
    if (!target.startsWith(displayedTypewriterText)) {
      return target;
    }
    return target.slice(0, Math.min(target.length, displayedTypewriterText.length + charsPerTick));
  }

  async function worker() {
    while (true) {
      if (mode === "typewriter" && typewriterTarget !== null) {
        const target = clampNonEmptyText(typewriterTarget);

        if (displayedTypewriterText !== target) {
          const next = nextTypewriterFrame(target);
          await doEdit(next);
          displayedTypewriterText = next;
          continue;
        }
      }

      if (pendingStatus !== null && (mode !== "typewriter" || !typewriterTarget)) {
        const t = pendingStatus;
        pendingStatus = null;
        await doEdit(t);
        continue;
      }

      break;
    }

    inflight = null;
  }

  return {
    requestStatus(text: string) {
      if (mode === "typewriter" && typewriterTarget) return;
      pendingStatus = text;
      if (!inflight) inflight = worker();
    },
    requestTypewriter(text: string) {
      mode = "typewriter";
      typewriterTarget = clampNonEmptyText(text);

      if (!displayedTypewriterText || !typewriterTarget.startsWith(displayedTypewriterText)) {
        displayedTypewriterText = "";
      }

      if (!inflight) inflight = worker();
    },
    async flush() {
      while (inflight) {
        await inflight;
      }

      if (mode === "typewriter" && typewriterTarget !== null) {
        const target = clampNonEmptyText(typewriterTarget);
        if (lastSent !== target) {
          await doEdit(target);
          displayedTypewriterText = target;
        }
        return;
      }

      if (pendingStatus !== null) {
        const t = pendingStatus;
        pendingStatus = null;
        await doEdit(t);
      }
    },
  };
}

// ============================================================
// MAIN
// ============================================================
export async function agentTurn(args: {
  sessionId: string;
  userId: string;
  channel: Channel;
  history: ModelMessage[];
  showTyping?: boolean;
  composio?: AgentTurnComposioConfig;
}) {
  "use step";

  const autonomy = env("AUTONOMOUS_MODE") ?? "assistive";

  const normalizedHistory = normalizeHistory(args.history);
  const sessionAssets = collectSessionAssets(normalizedHistory);
  const userText = String(extractRecentUserText(normalizedHistory) ?? "").trim();
  const hasRichMedia = historyHasRichMedia(normalizedHistory);

  const primaryMessages = sanitizeMessagesForModel(normalizedHistory);
  const retryMessages = sanitizeMessagesForModel(normalizedHistory, {
    maxMessages: parseIntOr(env("AGENT_RETRY_MAX_HISTORY_MESSAGES"), 4),
    maxTextChars: parseIntOr(env("AGENT_RETRY_MAX_TEXT_PART_CHARS"), 2000),
    maxTotalChars: parseIntOr(env("AGENT_RETRY_MAX_TOTAL_CONTEXT_CHARS"), 12000),
    maxAssistantMessages: parseIntOr(env("AGENT_RETRY_MAX_ASSISTANT_HISTORY_MESSAGES"), 1),
  });

  const virtualRuntime = await createVirtualRuntime({
    sessionId: args.sessionId,
    userId: args.userId,
    channel: args.channel,
    userText,
    history: primaryMessages,
    sessionAssets,
  });

  const fastModel = env("FAST_MODEL_NAME") ?? env("MODEL_NAME") ?? "gpt-4o-mini";
  const smartModel = env("SMART_MODEL_NAME") ?? env("MODEL_NAME") ?? "gpt-4o";
  const forceSmart = (env("AGENT_FORCE_SMART_MODEL") ?? "true") !== "false";
  const modelName = forceSmart ? smartModel : hasRichMedia ? smartModel : fastModel;

  const temperature = Number(env("MODEL_TEMPERATURE") ?? "0.7");
  const maxToolSteps = Math.max(1, parseIntOr(env("AGENT_MAX_TOOL_STEPS"), 11));

  const isTelegram = args.channel === "telegram";
  const telegramStreamingEnabled =
    isTelegram && (args.showTyping ?? true) && (env("TELEGRAM_STREAMING") ?? "true") !== "false";

  const editThrottleMs = 120;
  const typingIntervalMs = Math.max(1000, Number(env("TELEGRAM_TYPING_INTERVAL_MS") ?? 4000));
  const maxEditChars = Math.max(800, Math.min(3800, Number(env("TELEGRAM_STREAM_CHUNK_CHARS") ?? 3500)));

  let typingLoop: { stop: () => void } | null = null;
  let placeholderMsgId: number | null = null;

  type TelegramSendAs = "photo" | "document" | "audio" | "voice";
  type SpeechResponseFormat = "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";

  function isTelegramVoiceCompatible(mimeType: string, filename: string): boolean {
    const ext = String(filename ?? "").split(".").pop()?.toLowerCase() ?? "";
    const mime = String(mimeType ?? "").toLowerCase();
    return ["ogg", "opus", "mp3", "m4a"].includes(ext) || ["audio/ogg", "audio/opus", "audio/mpeg", "audio/mp4"].includes(mime);
  }

  function isTelegramAudioCompatible(mimeType: string, filename: string): boolean {
    const ext = String(filename ?? "").split(".").pop()?.toLowerCase() ?? "";
    const mime = String(mimeType ?? "").toLowerCase();
    return ["mp3", "m4a"].includes(ext) || ["audio/mpeg", "audio/mp4"].includes(mime);
  }

  function resolveTelegramSendAs(args: {
    mimeType: string;
    filename: string;
    sendAs?: TelegramSendAs | "auto";
    asDocument?: boolean;
  }): TelegramSendAs {
    if (args.sendAs && args.sendAs !== "auto") return args.sendAs;
    if (args.asDocument) return "document";

    const mime = String(args.mimeType ?? "").toLowerCase();
    if (mime.startsWith("image/")) return "photo";
    if (isTelegramVoiceCompatible(mime, args.filename)) return "voice";
    if (isTelegramAudioCompatible(mime, args.filename)) return "audio";
    return "document";
  }

  function mimeTypeForSpeechResponseFormat(format: SpeechResponseFormat): string {
    switch (format) {
      case "opus":
        return "audio/ogg";
      case "aac":
        return "audio/aac";
      case "flac":
        return "audio/flac";
      case "wav":
        return "audio/wav";
      case "pcm":
        return "audio/pcm";
      default:
        return "audio/mpeg";
    }
  }

  function extensionForSpeechResponseFormat(format: SpeechResponseFormat): string {
    switch (format) {
      case "opus":
        return "ogg";
      case "aac":
        return "aac";
      case "flac":
        return "flac";
      case "wav":
        return "wav";
      case "pcm":
        return "pcm";
      default:
        return "mp3";
    }
  }

  async function buildTelegramUploadableSessionAsset(asset: SessionAsset): Promise<{
    blob: Blob | File;
    filename: string;
    mimeType: string;
    sizeBytes: number | null;
    signedUrl: string | null;
  }> {
    const loaded = await loadSessionAssetContent(asset, { fetchRemote: true });
    return {
      blob: createNamedUploadBlob(loaded.filename, loaded.mimeType, loaded.base64),
      filename: loaded.filename,
      mimeType: loaded.mimeType,
      sizeBytes: loaded.sizeBytes,
      signedUrl: await buildSignedAssetUrl(asset),
    };
  }

  async function synthesizeSpeechForTelegram(input: {
    text: string;
    voice?: string;
    instructions?: string;
    model?: string;
    responseFormat?: SpeechResponseFormat;
    speed?: number;
  }): Promise<{
    blob: Blob | File;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    model: string;
    voice: string;
    responseFormat: SpeechResponseFormat;
  }> {
    const apiKey = String(env("OPENAI_API_KEY") ?? process.env.OPENAI_API_KEY ?? "").trim();
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not set.");
    }

    const baseUrl = String(env("OPENAI_API_BASE_URL") ?? process.env.OPENAI_API_BASE_URL ?? "https://api.openai.com/v1")
      .trim()
      .replace(/\/+$/, "");
    const model = String(input.model ?? env("VOICE_MODEL_NAME") ?? env("TTS_MODEL_NAME") ?? "gpt-4o-mini-tts").trim();
    const voice = String(input.voice ?? env("VOICE_NAME") ?? env("TTS_VOICE") ?? "alloy").trim();
    const responseFormat: SpeechResponseFormat = input.responseFormat ?? "mp3";

    const payload: Record<string, unknown> = {
      model,
      voice,
      input: input.text,
      response_format: responseFormat,
    };

    if (input.instructions?.trim()) payload.instructions = input.instructions.trim();
    if (typeof input.speed === "number" && Number.isFinite(input.speed)) payload.speed = input.speed;

    const response = await fetch(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      throw new Error(`OpenAI audio.speech failed (${response.status} ${response.statusText})${raw ? `: ${truncateText(raw, 1000)}` : ""}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || mimeTypeForSpeechResponseFormat(responseFormat);
    const filename = `voice_message.${extensionForSpeechResponseFormat(responseFormat)}`;
    const blob = createNamedUploadBlob(filename, mimeType, bytesToBase64(bytes));

    return {
      blob,
      filename,
      mimeType,
      sizeBytes: bytes.byteLength,
      model,
      voice,
      responseFormat,
    };
  }

  // ============================================================
  // Native tools
  // ============================================================
  const scheduleMessage = tool({
    description: "Schedule a message back to this user/session after delaySeconds.",
    inputSchema: zodSchema(
      z.object({
        delaySeconds: z.number().min(1).max(60 * 60 * 24 * 14),
        text: z.string().min(1).max(2000),
      })
    ),
    execute: async (input: { delaySeconds: number; text: string }) => {
      const dueAt = Date.now() + Math.floor(input.delaySeconds * 1000);
      const id = await createSendTask({
        type: "send",
        dueAt,
        channel: args.channel,
        sessionId: args.sessionId,
        text: input.text,
        createdBy: "agent",
      } as any);
      return { ok: true, taskId: id, dueAt };
    },
  });

  const allowModelSsh = (env("SSH_TOOL_AUTONOMOUS") ?? "false") === "true";
  const sshTool = tool({
    description: allowModelSsh
      ? "Run any SSH command on the host."
      : "Run SSH only if user explicitly asked; otherwise instruct /ssh <command>.",
    inputSchema: zodSchema(z.object({ command: z.string().min(1).max(2000) })),
    execute: async (input: { command: string }) => {
      if (!allowModelSsh) {
        const explicit = userText.startsWith("/ssh") || /\bssh\b|\brun this command\b/i.test(userText);
        if (!explicit) return { ok: false, blocked: true, message: "Use /ssh <command> to run SSH." };
      }
      const output = await sshExec(input.command);
      return { ok: true, output: truncateText(output, 5000) };
    },
  });

  const listSkills = tool({
    description: "List the statically inlined agent skills available in this file.",
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      return {
        ok: true,
        skills: Object.keys(INLINE_SKILLS),
        count: Object.keys(INLINE_SKILLS).length,
      };
    },
  });

  const readSkill = tool({
    description: "Read a specific inline skill by name.",
    inputSchema: zodSchema(
      z.object({
        name: z.string().min(1),
      })
    ),
    execute: async (input: { name: string }) => {
      const key = normalizeSkillName(input.name);
      const skill = INLINE_SKILLS[key];
      if (!skill) {
        return {
          ok: false,
          error: `Unknown skill "${input.name}"`,
          available: Object.keys(INLINE_SKILLS),
        };
      }
      return {
        ok: true,
        skill: key,
        content: renderSingleSkill(skill),
        virtualPath: `/workspace/skills/${key}.md`,
      };
    },
  });

  const readVirtualFile = tool({
    description: "Read a file from the Redis-backed virtual filesystem. Prefer paths under /workspace.",
    inputSchema: zodSchema(
      z.object({
        path: z.string().min(1).max(4000),
      })
    ),
    execute: async (input: { path: string }) => {
      try {
        const content = await vfsReadFile(virtualRuntime, input.path);
        return {
          ok: true,
          path: sanitizePath(input.path),
          content: truncateText(content, 30000),
        };
      } catch (error: any) {
        return {
          ok: false,
          path: sanitizePath(input.path),
          error: String(error?.message ?? error ?? "Unknown read_virtual_file error"),
        };
      }
    },
  });

  const writeVirtualFile = tool({
    description: "Write content to a file in the Redis-backed virtual filesystem. Prefer /workspace paths.",
    inputSchema: zodSchema(
      z.object({
        path: z.string().min(1).max(4000),
        content: z.string().max(120_000),
      })
    ),
    execute: async (input: { path: string; content: string }) => {
      try {
        await vfsWriteFile(virtualRuntime, input.path, input.content);
        return {
          ok: true,
          path: sanitizePath(input.path),
          bytes: utf8ByteLength(input.content),
        };
      } catch (error: any) {
        return {
          ok: false,
          path: sanitizePath(input.path),
          error: String(error?.message ?? error ?? "Unknown write_virtual_file error"),
        };
      }
    },
  });

  const virtualShell = tool({
    description:
      "Run shell-like commands against the Redis-backed virtual filesystem only. Supports pwd, ls, tree, cat, mkdir, write, rm, mv, cp, find, and grep.",
    inputSchema: zodSchema(
      z.object({
        command: z.string().min(1).max(120000),
      })
    ),
    execute: async (input: { command: string }) => {
      const result = await execVirtualShell(virtualRuntime, input.command);
      return {
        ok: result.ok,
        command: truncateText(input.command, 500),
        stdout: truncateText(result.stdout, 5000),
        stderr: truncateText(result.stderr, 2000),
        exitCode: result.exitCode,
      };
    },
  });

  const listSessionAssets = tool({
    description:
      "List images, audio, video, and files detected in the current conversation history, including canonical IDs for follow-up asset preparation. Do not use this to understand asset contents; use inspect_session_asset for that.",
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      return {
        ok: true,
        count: sessionAssets.length,
        assets: sessionAssets.map((asset) => ({
          ...describeSessionAsset(asset),
          ref: `asset://${asset.id}`,
        })),
      };
    },
  });

  const prepareSessionAsset = tool({
    description:
      "Prepare a session asset for external tool usage. By default returns metadata and upload hints only. Do not use this when the user wants to know what the asset contains; use inspect_session_asset instead.",
    inputSchema: zodSchema(
      z.object({
        assetId: z.string().min(1),
        fetchRemote: z.boolean().optional(),
        includeInlineData: z.boolean().optional(),
        materializeToVfs: z.boolean().optional(),
      })
    ),
    execute: async (input: {
      assetId: string;
      fetchRemote?: boolean;
      includeInlineData?: boolean;
      materializeToVfs?: boolean;
    }) => {
      const asset = sessionAssets.find((x) => x.id === input.assetId);
      if (!asset) {
        return {
          ok: false,
          error: `Unknown assetId "${input.assetId}"`,
          availableAssetIds: sessionAssets.map((x) => x.id),
        };
      }

      const includeInlineData = input.includeInlineData ?? false;
      const fetchRemote = input.fetchRemote ?? true;

      let loaded: LoadedSessionAsset | null = null;
      let materialized:
        | {
            assetRoot: string;
            metaPath: string;
            base64Path: string | null;
            textPath: string | null;
            infoPath: string;
          }
        | null = null;

      try {
        if (includeInlineData || input.materializeToVfs) {
          loaded = await loadSessionAssetContent(asset, { fetchRemote });
        }

        if (input.materializeToVfs) {
          const result = await materializeSessionAssetToVfs(virtualRuntime, asset, {
            fetchRemote,
            includeBase64: includeInlineData,
          });
          materialized = {
            assetRoot: result.assetRoot,
            metaPath: result.metaPath,
            base64Path: result.base64Path,
            textPath: result.textPath,
            infoPath: result.infoPath,
          };
          loaded = result.loaded;
        }

        return {
          ok: true,
          ref: `asset://${asset.id}`,
          ...buildPreparedAssetPayload(asset, {
            loaded,
            materialized,
            includeInlineData,
            signedUrl: await buildSignedAssetUrl(asset),
          }),
        };
      } catch (error: any) {
        return {
          ok: false,
          asset: describeSessionAsset(asset),
          error: String(error?.message ?? error ?? "Unknown prepare_session_asset error"),
        };
      }
    },
  });

  const materializeSessionAsset = tool({
    description:
      "Persist a session asset into the Redis-backed virtual filesystem under /workspace/assets/<asset-id>/. Does not include base64 unless explicitly requested.",
    inputSchema: zodSchema(
      z.object({
        assetId: z.string().min(1),
        fetchRemote: z.boolean().optional(),
        includeBase64: z.boolean().optional(),
      })
    ),
    execute: async (input: { assetId: string; fetchRemote?: boolean; includeBase64?: boolean }) => {
      const asset = sessionAssets.find((x) => x.id === input.assetId);
      if (!asset) {
        return {
          ok: false,
          error: `Unknown assetId "${input.assetId}"`,
          availableAssetIds: sessionAssets.map((x) => x.id),
        };
      }

      try {
        const result = await materializeSessionAssetToVfs(virtualRuntime, asset, {
          fetchRemote: input.fetchRemote ?? true,
          includeBase64: input.includeBase64 ?? false,
        });

        return {
          ok: true,
          asset: describeSessionAsset(asset),
          ref: `asset://${asset.id}`,
          assetRoot: result.assetRoot,
          metaPath: result.metaPath,
          base64Path: result.base64Path,
          textPath: result.textPath,
          infoPath: result.infoPath,
          loaded: {
            filename: result.loaded.filename,
            mimeType: result.loaded.mimeType,
            sizeBytes: result.loaded.sizeBytes,
            source: result.loaded.source,
          },
        };
      } catch (error: any) {
        return {
          ok: false,
          asset: describeSessionAsset(asset),
          error: String(error?.message ?? error ?? "Unknown materialize_session_asset error"),
        };
      }
    },
  });


  async function inspectSessionAssetImpl(input: {
    assetId?: string;
    question?: string;
    fetchRemote?: boolean;
    maxTextChars?: number;
  }) {
    const selectedAsset = input.assetId
      ? sessionAssets.find((x) => x.id === input.assetId)
      : sessionAssets[sessionAssets.length - 1];

    if (!selectedAsset) {
      return {
        ok: false,
        error: "No session assets are available to inspect.",
      };
    }

    const fetchRemote = input.fetchRemote ?? true;
    const maxTextChars = input.maxTextChars ?? 16000;
    const question = String(input.question ?? "").trim();
    const signedUrl = await buildSignedAssetUrl(selectedAsset);
    const inspectionModelName = env("ASSET_INSPECTION_MODEL_NAME") ?? smartModel ?? "gpt-4o";

    const runInspectionText = async (request: { prompt?: string; messages?: any[] }) => {
      const modelArgs: any = { model: openai(inspectionModelName) };
      if (request.messages) {
        modelArgs.messages = request.messages;
      } else {
        modelArgs.prompt = request.prompt;
      }
      if (shouldSendTemperature(inspectionModelName, 0.2)) {
        modelArgs.temperature = 0.2;
      }
      const result = await generateText(modelArgs);
      return String(result.text ?? "").trim();
    };

    try {
      const loadedRaw = await loadSessionAssetContent(selectedAsset, { fetchRemote });
      const loaded = coerceLoadedAssetMimeType(loadedRaw);

      const base = {
        ok: true,
        asset: describeSessionAsset(selectedAsset),
        ref: `asset://${selectedAsset.id}`,
        url: signedUrl,
        filename: loaded.filename,
        mimeType: loaded.mimeType,
        sizeBytes: loaded.sizeBytes,
        question: question || null,
      };

      const decodedText = loaded.textPreview ?? tryUtf8FromBase64(loaded.base64) ?? "";
      const shouldTreatAsText =
        isTextualMimeType(loaded.mimeType) ||
        isTextLikeFilename(loaded.filename || selectedAsset.filename) ||
        (!question && decodedText.length > 0 && !looksLikeBinaryBase64String(decodedText));

      if (shouldTreatAsText && decodedText.trim()) {
        const preview = truncateForModelContext(decodedText, maxTextChars);
        const analysis = await runInspectionText({
          prompt: [
            "You are inspecting a user-uploaded text file.",
            "Explain what it contains and answer the user's question if one is provided.",
            "If the file looks like code, mention the language and summarize what it does.",
            "If the file looks like JSON, CSV, logs, or config, describe the structure and important contents.",
            "Do not invent content beyond the provided text.",
            "",
            `Filename: ${loaded.filename}`,
            `MIME Type: ${loaded.mimeType}`,
            question ? `User question: ${question}` : "User question: Describe what this file contains.",
            "",
            "File content:",
            preview,
          ].join("\n"),
        });

        return {
          ...base,
          inspectionMode: "text",
          textPreview: truncateText(decodedText, 6000),
          analysis,
        };
      }

      if (String(loaded.mimeType).toLowerCase().startsWith("image/")) {
        const imageInput = signedUrl ?? base64ToBytes(loaded.base64);
        const analysis = await runInspectionText({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: [
                    "Inspect this uploaded image and describe what it contains.",
                    "Include visible text, UI elements, objects, people, charts, diagrams, and other important details.",
                    question ? `User question: ${question}` : "User question: Describe exactly what you see.",
                  ].join("\n"),
                },
                {
                  type: "image",
                  image: imageInput,
                },
              ],
            },
          ],
        });

        return {
          ...base,
          inspectionMode: "image",
          analysis,
        };
      }

      if (String(loaded.mimeType).toLowerCase() === "application/pdf") {
        const pdfInput = signedUrl ?? base64ToBytes(loaded.base64);
        const analysis = await runInspectionText({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: [
                    "Inspect this uploaded PDF and explain what it contains.",
                    "Summarize the document, mention major sections, and answer the user's question if one is provided.",
                    question ? `User question: ${question}` : "User question: What does this PDF contain?",
                  ].join("\n"),
                },
                {
                  type: "file",
                  data: pdfInput,
                  mediaType: "application/pdf",
                  filename: loaded.filename,
                },
              ],
            },
          ],
        });

        return {
          ...base,
          inspectionMode: "pdf",
          analysis,
        };
      }

      if (String(loaded.mimeType).toLowerCase().startsWith("audio/")) {
        const audioModelName = env("AUDIO_INSPECTION_MODEL_NAME") ?? "gpt-4o-audio-preview";
        const audioInput = signedUrl ?? base64ToBytes(loaded.base64);
        const audioResult = await generateText({
          model: openai(audioModelName),
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: question || "Transcribe this audio and summarize what it says.",
                },
                {
                  type: "file",
                  data: audioInput,
                  mediaType: loaded.mimeType,
                  filename: loaded.filename,
                },
              ],
            },
          ],
        });

        return {
          ...base,
          inspectionMode: "audio",
          analysis: String(audioResult.text ?? "").trim(),
        };
      }

      return {
        ...base,
        inspectionMode: "metadata",
        analysis:
          `I could not directly inspect the binary contents of ${loaded.filename} (${loaded.mimeType}). ` +
          `I can still provide metadata and a signed URL for an external tool if needed.`,
      };
    } catch (error: any) {
      return {
        ok: false,
        asset: describeSessionAsset(selectedAsset),
        ref: `asset://${selectedAsset.id}`,
        url: signedUrl,
        error: String(error?.message ?? error ?? "Unknown inspect_session_asset error"),
      };
    }
  }

  const inspectSessionAsset = tool({
    description:
      "Inspect the contents of the most recent uploaded asset or a specific session asset. Use this when the user asks what an image, screenshot, PDF, file, JSON, code file, or log contains. Do not use list_session_assets or prepare_session_asset when you need content understanding.",
    inputSchema: zodSchema(
      z.object({
        assetId: z.string().optional(),
        question: z.string().max(4000).optional(),
        fetchRemote: z.boolean().optional(),
        maxTextChars: z.number().int().min(500).max(40000).optional(),
      })
    ),
    execute: inspectSessionAssetImpl,
  });

  const sendSessionAssetToTelegram = tool({
    description:
      "Send a session asset back to the user in Telegram. Supports photo, document, audio, and voice delivery.",
    inputSchema: zodSchema(
      z.object({
        assetId: z.string().min(1),
        caption: z.string().max(1024).optional(),
        asDocument: z.boolean().optional(),
        sendAs: z.enum(["auto", "photo", "document", "audio", "voice"]).optional(),
      })
    ),
    execute: async (input: { assetId: string; caption?: string; asDocument?: boolean; sendAs?: "auto" | TelegramSendAs }) => {
      const asset = sessionAssets.find((x) => x.id === input.assetId);
      if (!asset) {
        return {
          ok: false,
          error: `Unknown assetId "${input.assetId}"`,
          availableAssetIds: sessionAssets.map((x) => x.id),
        };
      }

      const prepared = await buildTelegramUploadableSessionAsset(asset);
      const caption = input.caption?.trim() || undefined;
      const sendAs = resolveTelegramSendAs({
        mimeType: prepared.mimeType,
        filename: prepared.filename,
        sendAs: input.sendAs,
        asDocument: input.asDocument,
      });

      const messageId =
        sendAs === "photo"
          ? await telegramSendPhoto(args.sessionId, prepared.signedUrl ?? `asset://${asset.id}`, { caption })
          : sendAs === "voice"
            ? await telegramSendVoice(args.sessionId, prepared.blob, { caption, filename: prepared.filename })
            : sendAs === "audio"
              ? await telegramSendAudio(args.sessionId, prepared.blob, { caption, filename: prepared.filename, title: prepared.filename })
              : await telegramSendDocument(args.sessionId, prepared.signedUrl ?? `asset://${asset.id}`, { caption });

      return {
        ok: true,
        asset: describeSessionAsset(asset),
        ref: `asset://${asset.id}`,
        url: prepared.signedUrl,
        messageId,
        sentAs: sendAs,
      };
    },
  });

  const sendVirtualFileToTelegram = tool({
    description:
      "Send a file from the Redis-backed virtual filesystem back to the user in Telegram. Supports photo, document, audio, and voice delivery when the file is fetchable by URL.",
    inputSchema: zodSchema(
      z.object({
        path: z.string().min(1).max(4000),
        caption: z.string().max(1024).optional(),
        asDocument: z.boolean().optional(),
        sendAs: z.enum(["auto", "photo", "document", "audio", "voice"]).optional(),
      })
    ),
    execute: async (input: { path: string; caption?: string; asDocument?: boolean; sendAs?: "auto" | TelegramSendAs }) => {
      try {
        const path = sanitizePath(input.path);
        const node = await vfsGetNode(virtualRuntime, path);
        if (!node) throw new Error(`No such path: ${path}`);
        if (node.type !== "file") throw new Error(`Not a file: ${path}`);

        const filename = basename(path) || "file";
        const mimeType = inferMimeFromFilename(filename);
        const url = await buildSignedVfsUrlForRuntime(virtualRuntime, path, {
          filename,
          mimeType,
          encoding: "utf8",
          download: false,
        });

        if (!url) {
          throw new Error(`Could not build a signed URL for ${path}`);
        }

        const caption = input.caption?.trim() || undefined;
        const sendAs = resolveTelegramSendAs({
          mimeType,
          filename,
          sendAs: input.sendAs,
          asDocument: input.asDocument,
        });
        const messageId =
          sendAs === "photo"
            ? await telegramSendPhoto(args.sessionId, url, { caption })
            : sendAs === "voice"
              ? await telegramSendVoice(args.sessionId, url, { caption, filename })
              : sendAs === "audio"
                ? await telegramSendAudio(args.sessionId, url, { caption, filename, title: filename })
                : await telegramSendDocument(args.sessionId, url, { caption });

        return {
          ok: true,
          path,
          filename,
          mimeType,
          url,
          messageId,
          sentAs: sendAs,
        };
      } catch (error: any) {
        return {
          ok: false,
          path: sanitizePath(input.path),
          error: String(error?.message ?? error ?? "Unknown send_virtual_file_to_telegram error"),
        };
      }
    },
  });

  const sendVoiceMessageToTelegram = tool({
    description:
      "Generate speech from text using OpenAI audio speech and send it to the user in Telegram as a voice message or audio track.",
    inputSchema: zodSchema(
      z.object({
        text: z.string().min(1).max(4096),
        caption: z.string().max(1024).optional(),
        voice: z.string().max(128).optional(),
        instructions: z.string().max(1000).optional(),
        model: z.string().max(128).optional(),
        speed: z.number().min(0.25).max(4).optional(),
        sendAs: z.enum(["voice", "audio"]).optional(),
      })
    ),
    execute: async (input: {
      text: string;
      caption?: string;
      voice?: string;
      instructions?: string;
      model?: string;
      speed?: number;
      sendAs?: "voice" | "audio";
    }) => {
      const sendAs = input.sendAs ?? "voice";
      const speech = await synthesizeSpeechForTelegram({
        text: input.text,
        voice: input.voice,
        instructions: input.instructions,
        model: input.model,
        responseFormat: "mp3",
        speed: input.speed,
      });

      const messageId =
        sendAs === "audio"
          ? await telegramSendAudio(args.sessionId, speech.blob, {
              caption: input.caption,
              filename: speech.filename,
              title: speech.filename,
            })
          : await telegramSendVoice(args.sessionId, speech.blob, {
              caption: input.caption,
              filename: speech.filename,
            });

      return {
        ok: true,
        text: input.text,
        messageId,
        sentAs: sendAs,
        mimeType: speech.mimeType,
        filename: speech.filename,
        sizeBytes: speech.sizeBytes,
        model: speech.model,
        voice: speech.voice,
      };
    },
  });

  const composioGetMcpServer = tool({
    description:
      "Get the Composio MCP server URL and headers for this user session. Use when an MCP-compatible client needs connection details.",
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      try {
        const session = await createComposioSessionForUser(args.userId, args.composio?.session, args.composio);
        const mcp: any = (session as any)?.mcp ?? null;
        return {
          ok: Boolean(mcp?.url),
          userId: args.userId,
          url: mcp?.url ?? null,
          headers: mcp?.headers ?? null,
        };
      } catch (error: any) {
        return {
          ok: false,
          error: String(error?.message ?? error ?? "Unknown composio_get_mcp_server error"),
        };
      }
    },
  });

  const composioProjectApiRequest = tool({
    description:
      "Call any project-scoped Composio REST API v3 endpoint dynamically. Use for platform/admin operations not exposed by the session meta tools, such as webhook subscriptions, trigger lifecycle, connected accounts, auth configs, toolkits, tools, files, MCP, tool_router session endpoints, and project config.",
    inputSchema: zodSchema(
      z.object({
        method: z.string().min(1).max(10).optional(),
        path: z.string().min(1).max(2000),
        query: z.record(z.string(), z.any()).optional(),
        body: z.any().optional(),
        rawBody: z.string().optional(),
        rawBodyBase64: z.string().optional(),
        contentType: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
      })
    ),
    execute: async (input: {
      method?: string;
      path: string;
      query?: Record<string, unknown>;
      body?: unknown;
      rawBody?: string;
      rawBodyBase64?: string;
      contentType?: string;
      headers?: Record<string, string>;
    }) => {
      try {
        return await composioApiRequest({
          ...input,
          authMode: "project",
          config: args.composio,
        });
      } catch (error: any) {
        return {
          ok: false,
          status: null,
          statusText: null,
          error: String(error?.message ?? error ?? "Unknown composio_api_request error"),
          data: null,
        };
      }
    },
  });

  const composioOrgApiRequest = tool({
    description:
      "Call any org-scoped Composio REST API v3 endpoint dynamically. Use only for organization-level operations such as listing or creating projects. Requires COMPOSIO_ORG_API_KEY or an orgApiKey override.",
    inputSchema: zodSchema(
      z.object({
        method: z.string().min(1).max(10).optional(),
        path: z.string().min(1).max(2000),
        query: z.record(z.string(), z.any()).optional(),
        body: z.any().optional(),
        rawBody: z.string().optional(),
        rawBodyBase64: z.string().optional(),
        contentType: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
      })
    ),
    execute: async (input: {
      method?: string;
      path: string;
      query?: Record<string, unknown>;
      body?: unknown;
      rawBody?: string;
      rawBodyBase64?: string;
      contentType?: string;
      headers?: Record<string, string>;
    }) => {
      try {
        return await composioApiRequest({
          ...input,
          authMode: "org",
          config: args.composio,
        });
      } catch (error: any) {
        return {
          ok: false,
          status: null,
          statusText: null,
          error: String(error?.message ?? error ?? "Unknown composio_org_api_request error"),
          data: null,
        };
      }
    },
  });

  const composioVerifyWebhookSignature = tool({
    description:
      "Verify a Composio webhook signature using the webhook id, timestamp, raw payload string, and signature header. Use when debugging or implementing webhook handlers.",
    inputSchema: zodSchema(
      z.object({
        id: z.string().min(1),
        timestamp: z.string().min(1),
        signature: z.string().min(1),
        payload: z.string().min(1),
        secret: z.string().optional(),
        toleranceSeconds: z.number().int().min(0).max(86_400).optional(),
      })
    ),
    execute: async (input: {
      id: string;
      timestamp: string;
      signature: string;
      payload: string;
      secret?: string;
      toleranceSeconds?: number;
    }) => {
      try {
        const secret = String(input.secret ?? env("COMPOSIO_WEBHOOK_SECRET") ?? "").trim();
        if (!secret) {
          return {
            ok: false,
            error: "COMPOSIO_WEBHOOK_SECRET not set and no secret provided",
          };
        }

        const toleranceSeconds = input.toleranceSeconds ?? 300;
        const parsedTimestamp = parseWebhookTimestampSeconds(input.timestamp);
        if (parsedTimestamp == null) {
          return {
            ok: false,
            error: "Invalid webhook timestamp",
          };
        }

        if (toleranceSeconds > 0) {
          const nowSeconds = Math.floor(Date.now() / 1000);
          if (Math.abs(nowSeconds - parsedTimestamp) > toleranceSeconds) {
            return {
              ok: false,
              error: `Webhook timestamp outside tolerance (${toleranceSeconds}s)`,
              parsedTimestamp,
            };
          }
        }

        const signingString = `${input.id}.${input.timestamp}.${input.payload}`;
        const expected = await hmacSha256Base64(secret, signingString);
        const received = extractWebhookSignatureValue(input.signature);
        const verified = constantTimeEquals(expected, received);
        const parsedPayload = tryParseJson(input.payload);

        return {
          ok: verified,
          verified,
          expectedSignatureBase64: expected,
          receivedSignatureBase64: received,
          version: detectComposioWebhookVersion(parsedPayload),
          parsedTimestamp,
          eventType: (parsedPayload as any)?.type ?? null,
          triggerSlug: (parsedPayload as any)?.metadata?.trigger_slug ?? (parsedPayload as any)?.trigger_slug ?? null,
          payload: parsedPayload,
          error: verified ? null : "Invalid webhook signature",
        };
      } catch (error: any) {
        return {
          ok: false,
          error: String(error?.message ?? error ?? "Unknown composio_verify_webhook_signature error"),
        };
      }
    },
  });

  // ============================================================
  // Fast-path /ssh
  // ============================================================
  const slash = parseSlashCommand(userText);
  if (slash?.cmd === "/ssh") {
    const cmd = slash.arg;
    const out = cmd ? await sshExec(cmd) : "Usage: /ssh <command>";
    return { text: String(out), responseMessages: [] as any[] };
  }

  const shouldAutoInspectLatestAsset =
    sessionAssets.length > 0 &&
    latestUserMessageHasAsset(normalizedHistory) &&
    (!userText || isInspectQuestion(userText));

  if (shouldAutoInspectLatestAsset) {
    const inspection = await inspectSessionAssetImpl({
      assetId: sessionAssets[sessionAssets.length - 1]?.id,
      question: userText || undefined,
      fetchRemote: true,
    });

    if ((inspection as any)?.ok && typeof (inspection as any)?.analysis === "string" && (inspection as any).analysis.trim()) {
      return {
        text: String((inspection as any).analysis).trim(),
        responseMessages: [] as any[],
      };
    }
  }

  // ============================================================
  // Load Composio session meta tools and wrap them with deterministic asset resolution
  // ============================================================
  let composioTools: ToolSet = {};
  if (getComposioProjectApiKey(args.composio)) {
    const rawTools = await getComposioToolsForUser(args.userId, args.composio?.session, args.composio).catch(
      () => ({} as ToolSet)
    );
    composioTools = wrapComposioToolsWithAssetResolution(rawTools, {
      sessionAssets,
      composioConfig: args.composio,
    });
  }

  const nativeTools: ToolSet = {
    schedule_message: scheduleMessage,
    ssh_exec: sshTool,
    composio_get_mcp_server: composioGetMcpServer,
    composio_api_request: composioProjectApiRequest,
    composio_org_api_request: composioOrgApiRequest,
    composio_verify_webhook_signature: composioVerifyWebhookSignature,
    list_skills: listSkills,
    read_skill: readSkill,
    read_virtual_file: readVirtualFile,
    write_virtual_file: writeVirtualFile,
    virtual_shell: virtualShell,
    list_session_assets: listSessionAssets,
    inspect_session_asset: inspectSessionAsset,
    prepare_session_asset: prepareSessionAsset,
    materialize_session_asset: materializeSessionAsset,
    send_session_asset_to_telegram: sendSessionAssetToTelegram,
    send_virtual_file_to_telegram: sendVirtualFileToTelegram,
    send_voice_message_to_telegram: sendVoiceMessageToTelegram,
  };

  const tools: ToolSet = {
    ...composioTools,
    ...nativeTools,
  };

  const retryTools: ToolSet = tools;

  // ============================================================
  // Telegram streaming helpers
  // ============================================================
  async function deliverFinalTelegram(text: string) {
    const chunks = splitForTelegram(text, maxEditChars);

    if (placeholderMsgId != null) {
      try {
        await telegramEditMessageText(args.sessionId, placeholderMsgId, chunks[0]);
      } catch {
        placeholderMsgId = await telegramSendMessage(args.sessionId, chunks[0]);
      }
    } else {
      placeholderMsgId = await telegramSendMessage(args.sessionId, chunks[0]);
    }

    for (let i = 1; i < chunks.length; i++) {
      await telegramSendMessage(args.sessionId, chunks[i], { disableNotification: true });
    }

    return { delivered: true };
  }

  async function streamToTelegram(fullStream: AsyncIterable<any>): Promise<string> {
    let full = "";
    let stepNumber = 0;
    let sawReasoning = false;

    const toolStates = new Map<string, TelegramLiveToolState>();

    const editor = createEditCoalescer({
      sessionId: args.sessionId,
      messageId: placeholderMsgId!,
      throttleMs: editThrottleMs,
    });

    const requestRender = () => {
      if (full.length > 0) {
        editor.requestTypewriter(truncateForTelegramLive(full, maxEditChars));
        return;
      }

      editor.requestStatus(
        truncateForTelegramLive(
          renderTelegramStatus({
            stepNumber,
            sawReasoning,
            tools: Array.from(toolStates.values()),
          }),
          maxEditChars
        )
      );
    };

    const upsertToolState = (part: any, patch: Partial<TelegramLiveToolState>) => {
      const toolCallId = String(part?.toolCallId ?? part?.id ?? "");
      const prev = toolStates.get(toolCallId) ?? {
        toolCallId,
        toolName: String(part?.toolName ?? "tool"),
        status: "running" as const,
      };

      toolStates.set(toolCallId, {
        ...prev,
        ...patch,
        toolCallId,
        toolName: String(part?.toolName ?? patch.toolName ?? prev.toolName ?? "tool"),
      });
    };

    requestRender();

    for await (const part of fullStream) {
      const type = String(part?.type ?? "");

      switch (type) {
        case "start-step": {
          stepNumber += 1;
          requestRender();
          break;
        }

        case "reasoning":
        case "reasoning-start":
        case "reasoning-delta": {
          sawReasoning = true;
          requestRender();
          break;
        }

        case "tool-input-start":
        case "tool-call-streaming-start": {
          upsertToolState(part, {
            status: "running",
          });
          requestRender();
          break;
        }

        case "tool-input-delta":
        case "tool-call-delta": {
          const previousId = String(part?.toolCallId ?? part?.id ?? "");
          const previous = toolStates.get(previousId);
          const delta = String(part?.delta ?? part?.argsTextDelta ?? "");
          const nextArgs = `${previous?.argsPreview ?? ""}${delta}`;

          upsertToolState(part, {
            status: "running",
            argsPreview: singleLineStatus(nextArgs, 220),
          });
          requestRender();
          break;
        }

        case "tool-input-end": {
          requestRender();
          break;
        }

        case "tool-call": {
          upsertToolState(part, {
            status: "running",
            argsPreview: summarizeToolPayloadForTelegram(part?.input ?? part?.args, 220),
          });
          requestRender();
          break;
        }

        case "tool-result": {
          upsertToolState(part, {
            status: "done",
            resultPreview: summarizeToolPayloadForTelegram(part?.output ?? part?.result, 180),
          });
          requestRender();
          break;
        }

        case "text": {
          full += String(part?.text ?? "");
          requestRender();
          break;
        }

        case "text-delta": {
          full += String(part?.delta ?? part?.textDelta ?? "");
          requestRender();
          break;
        }

        case "text-start":
        case "text-end":
        case "finish-step":
        case "finish":
        case "error": {
          requestRender();
          break;
        }

        default:
          break;
      }
    }

    await editor.flush();
    return full;
  }

  // ============================================================
  // System prompt
  // ============================================================
  const system = [
    "You are an Agentic Operating System assistant running in Telegram/WhatsApp/SMS with Composio tools.",
    "",
    "CRITICAL TOOL RULES:",
    "- If the user asks for an external action, use the appropriate tool.",
    "- Never claim an action succeeded unless a tool call returned success.",
    "- For external apps/services, prefer the Composio session meta tools already loaded for this user.",
    "- Let Composio search, authenticate, and execute dynamically at runtime instead of relying on hard-coded toolkit routing.",
    "",
    "COMPOSIO SESSION:",
    `- Active namespace: ${args.userId}`,
    "- session.tools() returns Composio meta tools for discovery, auth, execution, browser automation toolkit discovery, and the persistent workbench sandbox.",
    "- Use COMPOSIO_SEARCH_TOOLS when you do not know the exact app/tool slug or need browser automation or other dynamic toolkit discovery.",
    "- Use COMPOSIO_GET_TOOL_SCHEMAS to inspect exact tool inputs before execution.",
    "- Use COMPOSIO_MANAGE_CONNECTIONS when auth may be missing or the user asks to connect an app.",
    "- Use COMPOSIO_MULTI_EXECUTE_TOOL or COMPOSIO_EXECUTE_TOOL to run Composio actions after discovery.",
    "- Use COMPOSIO_REMOTE_WORKBENCH or COMPOSIO_REMOTE_BASH_TOOL for the Composio code sandbox/workbench.",
    "- Use composio_api_request for project-scoped Composio platform APIs that are outside session meta tools, including /webhook_subscriptions, /trigger_instances, /triggers_types, /connected_accounts, /auth_configs, /toolkits, /tools, /files, /mcp, /tool_router, and /org/project/config.",
    "- Use composio_org_api_request only for org-level project administration endpoints such as /org/owner/project/list or /org/owner/project/new when an org key is configured.",
    "- Use composio_get_mcp_server to retrieve MCP connection info for this user session.",
    "- Use composio_verify_webhook_signature when working with inbound webhook payloads and headers.",
    "",
    "FILESYSTEM:",
    "- Use read_virtual_file and write_virtual_file for the Redis-backed virtual filesystem.",
    "- Use send_virtual_file_to_telegram when the user asks you to send back a file from the virtual filesystem.",
    "- Use virtual_shell for shell-like operations on the virtual filesystem only.",
    "- Prefer /workspace for drafts, payloads, notes, JSON, and staging.",
    "",
    "MODALITIES:",
    `- Session asset count available via tools: ${sessionAssets.length}`,
    "- Use inspect_session_asset first when the user asks what an uploaded image, screenshot, PDF, file, JSON, code file, or log contains.",
    "- Use list_session_assets only to enumerate available assets.",
    "- Use prepare_session_asset only for metadata and upload hints.",
    "- When calling external tools, pass asset references like asset://asset_m6_p2.",
    "- The execution wrapper resolves asset references deterministically before the external tool runs, staging asset bytes into Composio storage when a tool expects an s3key-backed upload.",
    "- Only request inline content when the target tool really needs it.",
    "- When the user asks what an uploaded asset contains, do not loop on list_session_assets or prepare_session_asset; use inspect_session_asset and then answer directly.",
    "",
    "SSH:",
    "- Use ssh_exec only for real host actions the user wants.",
    "- If blocked, tell the user to use /ssh <command>.",
    "",
    "SKILLS:",
    "- Use list_skills or read_skill only when needed.",
    "",
    "DELIVERY:",
    "- Use send_session_asset_to_telegram when the user asks you to send back an uploaded image, audio file, voice note, or document.",
    "- Use send_virtual_file_to_telegram when the user asks you to send back a generated or saved file from /workspace.",
    "- Use send_voice_message_to_telegram when the user asks for a spoken reply, voice note, or text-to-speech response from the bot itself.",
    "",
    `Mode: ${autonomy}`,
    "Be concise, accurate, and tool-grounded.",
  ].join("\n");

  async function runStreamingAttempt(attemptMessages: ModelMessage[], attemptTools: ToolSet) {
    const s = streamText(
      buildModelCallArgs({
        modelName,
        system,
        messages: attemptMessages,
        tools: attemptTools,
        temperature,
        maxToolSteps,
      })
    );

    const streamedText = await streamToTelegram(s.fullStream as AsyncIterable<any>);

    const maybeText = (s as any).text;
    const fallbackText =
      typeof maybeText === "string"
        ? maybeText
        : maybeText && typeof maybeText.then === "function"
          ? await maybeText
          : "";

    const text = String(streamedText || fallbackText || "").trim();

    if (!text) {
      throw new Error("Streaming completed without assistant text");
    }

    await deliverFinalTelegram(text);

    const responseMessages = Array.isArray((await (s as any).response)?.messages)
      ? ((await (s as any).response).messages as any[])
      : [];

    return { text, responseMessages, delivered: true };
  }


  async function runGenerateAttempt(attemptMessages: ModelMessage[], attemptTools: ToolSet) {
    const r = await generateText(
      buildModelCallArgs({
        modelName,
        system,
        messages: attemptMessages,
        tools: attemptTools,
        temperature,
        maxToolSteps,
      })
    );

    return { text: r.text, responseMessages: (r.response?.messages as any[]) ?? [] };
  }

  try {
    if (telegramStreamingEnabled) {
      typingLoop = telegramStartChatActionLoop(args.sessionId, "typing", { intervalMs: typingIntervalMs });
      placeholderMsgId = await telegramSendMessage(args.sessionId, "Thinking…", { disableNotification: true });

      try {
        return await runStreamingAttempt(primaryMessages, tools);
      } catch (error) {
        if (!isPromptBudgetRetryableError(error)) throw error;
        return await runStreamingAttempt(retryMessages, retryTools);
      }
    }

    try {
      return await runGenerateAttempt(primaryMessages, tools);
    } catch (error) {
      if (!isPromptBudgetRetryableError(error)) throw error;
      return await runGenerateAttempt(retryMessages, retryTools);
    }
  } finally {
    typingLoop?.stop();
  }
}
