import { NextResponse } from "next/server";
import { start } from "workflow/api";

import { createReadStream } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";

import { sessionWorkflow } from "@/app/workflows/session";
import { daemonWorkflow } from "@/app/workflows/daemon";

import type { Channel } from "@/app/lib/identity";
import { makeIdentity } from "@/app/lib/identity";
import { createPairing, approvePairing, getPendingCode } from "@/app/lib/pairing";
import {
  parsePairCommand,
  normalizeTelegram,
  normalizeTextbeltReply,
  normalizeWhatsApp,
  type InboundMessage,
} from "@/app/lib/normalize";
import { sendOutboundRuntime } from "@/app/lib/outbound";
import { env } from "@/app/lib/env";
import { getStore } from "@/app/lib/store";
import { telegramValidateWebhook } from "@/app/lib/providers/telegram";
import { whatsappVerifyChallenge, verifyWhatsAppSignature } from "@/app/lib/providers/whatsapp";
import {
  getTextbeltApiKeyOptional,
  shouldVerifyTextbeltWebhook,
  verifyTextbeltWebhook,
} from "@/app/lib/providers/textbelt";
import { isInboundAllowed } from "@/app/lib/allowlist";
import { saveSessionMeta, getLastSession, getSessionMeta } from "@/app/lib/sessionMeta";
import { ensurePairingCode, exchangePairingCode, verifyGatewayBearer } from "@/app/lib/gatewayAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// Utilities
// ============================================================
function jsonOk(extra: any = {}) {
  return NextResponse.json({ ok: true, ...extra });
}

async function handleCronTrigger() {
  const store = getStore();
  const lockKey = "daemon:lock";
  const acquired = await store.set(lockKey, String(Date.now()), { exSeconds: 70, nx: true });

  if (acquired) {
    await start(daemonWorkflow, []);
    return jsonOk({ started: true, acquiredLock: true });
  }

  return jsonOk({ started: false, acquiredLock: false });
}

function isStopCmd(text: string) {
  const t = (text ?? "").trim().toLowerCase();
  return t === "/stop" || t === "stop";
}

function isStartCmd(text: string) {
  const t = (text ?? "").trim().toLowerCase();
  return t === "/start" || t === "start";
}

function stopKey(channel: string, sessionId: string) {
  return `chat:stopped:${channel}:${sessionId}`;
}

// Media proxy allowlist (Bobby CDN only; add more hosts if needed)
const MEDIA_ALLOWED_HOSTS = new Set(["cdn-bobbyapproved.flavcity.com"]);

function safeDecodeMediaUrlParam(raw: string): string {
  // Supports either plain URL-encoded or base64url-encoded.
  try {
    const trimmed = raw.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;

    const b64 = trimmed.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    return Buffer.from(b64 + pad, "base64").toString("utf8");
  } catch {
    return raw;
  }
}

// ============================================================
// Telegram voice/audio transcription
// ============================================================
let openaiClient: OpenAI | null = null;

function getOpenAIClient() {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: env("OPENAI_API_KEY"),
    });
  }

  return openaiClient;
}

function numberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MAX_TELEGRAM_TRANSCRIBE_BYTES = numberEnv(
  "TELEGRAM_TRANSCRIBE_MAX_BYTES",
  20 * 1024 * 1024
);

type TelegramAudioMedia = {
  kind: "voice" | "audio" | "video_note" | "audio_document";
  fileId: string;
  fileName: string;
  mimeType: string;
  duration?: number;
  fileSize?: number;
};

function getTelegramMessage(update: any) {
  return (
    update?.message ??
    update?.edited_message ??
    update?.business_message ??
    update?.channel_post ??
    null
  );
}

function sanitizeFileName(name: string) {
  return name.replace(/[^\w.\-]+/g, "_").slice(0, 160);
}

function extensionFromMime(mimeType: string) {
  const m = mimeType.toLowerCase();

  if (m.includes("ogg") || m.includes("opus")) return ".ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return ".mp3";
  if (m.includes("mp4") || m.includes("m4a")) return ".m4a";
  if (m.includes("wav")) return ".wav";
  if (m.includes("webm")) return ".webm";
  if (m.includes("flac")) return ".flac";

  return ".ogg";
}

function extractTelegramAudioMedia(update: any): TelegramAudioMedia | null {
  const message = getTelegramMessage(update);
  if (!message) return null;

  const messageId = String(message.message_id ?? Date.now());

  if (message.voice?.file_id) {
    return {
      kind: "voice",
      fileId: String(message.voice.file_id),
      fileName: `telegram-voice-${messageId}.ogg`,
      mimeType: String(message.voice.mime_type ?? "audio/ogg"),
      duration: message.voice.duration,
      fileSize: message.voice.file_size,
    };
  }

  if (message.audio?.file_id) {
    const mimeType = String(message.audio.mime_type ?? "audio/mpeg");
    const fileName =
      message.audio.file_name ??
      `telegram-audio-${messageId}${extensionFromMime(mimeType)}`;

    return {
      kind: "audio",
      fileId: String(message.audio.file_id),
      fileName,
      mimeType,
      duration: message.audio.duration,
      fileSize: message.audio.file_size,
    };
  }

  if (message.video_note?.file_id) {
    return {
      kind: "video_note",
      fileId: String(message.video_note.file_id),
      fileName: `telegram-video-note-${messageId}.mp4`,
      mimeType: "video/mp4",
      duration: message.video_note.duration,
      fileSize: message.video_note.file_size,
    };
  }

  const documentMime = String(message.document?.mime_type ?? "");

  if (
    message.document?.file_id &&
    documentMime.toLowerCase().startsWith("audio/")
  ) {
    return {
      kind: "audio_document",
      fileId: String(message.document.file_id),
      fileName:
        message.document.file_name ??
        `telegram-audio-document-${messageId}${extensionFromMime(documentMime)}`,
      mimeType: documentMime,
      fileSize: message.document.file_size,
    };
  }

  return null;
}

async function telegramApi<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const token = env("TELEGRAM_BOT_TOKEN");

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok || !json?.ok) {
    throw new Error(
      `Telegram API ${method} failed: ${res.status} ${json?.description ?? res.statusText}`
    );
  }

  return json.result as T;
}

async function downloadTelegramFile(fileId: string): Promise<{
  bytes: Buffer;
  filePath: string;
  contentType: string;
}> {
  const token = env("TELEGRAM_BOT_TOKEN");

  const file = await telegramApi<{
    file_id?: string;
    file_unique_id?: string;
    file_size?: number;
    file_path?: string;
  }>("getFile", {
    file_id: fileId,
  });

  if (!file.file_path) {
    throw new Error("Telegram getFile did not return file_path");
  }

  if (file.file_size && file.file_size > MAX_TELEGRAM_TRANSCRIBE_BYTES) {
    throw new Error(`Telegram audio is too large to transcribe: ${file.file_size} bytes`);
  }

  const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(fileUrl, {
    method: "GET",
  });

  if (!res.ok) {
    throw new Error(`Telegram file download failed: ${res.status} ${res.statusText}`);
  }

  const arrayBuffer = await res.arrayBuffer();

  if (arrayBuffer.byteLength > MAX_TELEGRAM_TRANSCRIBE_BYTES) {
    throw new Error(
      `Telegram audio is too large to transcribe: ${arrayBuffer.byteLength} bytes`
    );
  }

  return {
    bytes: Buffer.from(arrayBuffer),
    filePath: file.file_path,
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
  };
}

async function transcribeTelegramAudio(media: TelegramAudioMedia): Promise<string> {
  const downloaded = await downloadTelegramFile(media.fileId);

  const safeName = sanitizeFileName(
    media.fileName || `telegram-audio-${Date.now()}${extensionFromMime(media.mimeType)}`
  );

  const tmpPath = path.join(tmpdir(), `${randomUUID()}-${safeName}`);

  await writeFile(tmpPath, downloaded.bytes);

  try {
    const openai = getOpenAIClient();

    const transcription = await openai.audio.transcriptions.create({
      file: createReadStream(tmpPath),
      model: process.env.TELEGRAM_TRANSCRIBE_MODEL ?? "gpt-4o-mini-transcribe",
    });

    const text =
      typeof transcription === "string"
        ? transcription
        : String((transcription as any)?.text ?? "");

    return text.trim();
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }
}

function buildTelegramInboundFromUpdate(
  update: any,
  text: string,
  media: TelegramAudioMedia
): InboundMessage | null {
  const message = getTelegramMessage(update);
  if (!message?.chat) return null;

  const chat = message.chat;
  const from = message.from ?? chat;

  return {
    channel: "telegram",
    sessionId: String(chat.id),
    senderId: String(from.id ?? chat.id),
    senderUsername: from.username ? String(from.username) : undefined,
    text,
    ts: typeof message.date === "number" ? message.date * 1000 : Date.now(),
    raw: {
      ...update,
      transcribedMedia: {
        provider: "telegram",
        kind: media.kind,
        mimeType: media.mimeType,
        duration: media.duration,
        fileSize: media.fileSize,
      },
    },
  };
}

async function normalizeTelegramWithTranscription(update: any): Promise<InboundMessage | null> {
  const media = extractTelegramAudioMedia(update);

  // Preserve existing behavior for normal text/photo/etc.
  if (!media) {
    return normalizeTelegram(update);
  }

  const base = await normalizeTelegram(update).catch(() => null);
  const transcript = await transcribeTelegramAudio(media);

  if (!transcript) {
    const fallbackText =
      "I received your voice message, but I could not transcribe any speech from it.";

    return base
      ? {
          ...base,
          text: fallbackText,
          raw: {
            ...(base.raw as any),
            transcribedMedia: {
              provider: "telegram",
              kind: media.kind,
              mimeType: media.mimeType,
              duration: media.duration,
              fileSize: media.fileSize,
              emptyTranscript: true,
            },
          },
        }
      : buildTelegramInboundFromUpdate(update, fallbackText, media);
  }

  const existingText = base?.text?.trim();

  const finalText = existingText
    ? `${existingText}\n\n[Voice transcript]\n${transcript}`
    : transcript;

  return base
    ? {
        ...base,
        text: finalText,
        raw: {
          ...(base.raw as any),
          transcribedMedia: {
            provider: "telegram",
            kind: media.kind,
            mimeType: media.mimeType,
            duration: media.duration,
            fileSize: media.fileSize,
            transcript,
          },
        },
      }
    : buildTelegramInboundFromUpdate(update, finalText, media);
}

async function handleTelegramWebhook(req: Request) {
  if (!(await telegramValidateWebhook(req))) {
    return new Response("Unauthorized", { status: 401 });
  }

  const update = await req.json().catch(() => null);
  if (!update) return new Response("Bad JSON", { status: 400 });

  const updateId = (update as any)?.update_id;

  if (typeof updateId === "number") {
    const store = getStore();
    const key = `dedupe:telegram:update:${updateId}`;
    const inserted = await store.set(key, "1", {
      exSeconds: 600,
      nx: true,
    });

    if (!inserted) return jsonOk({ deduped: true });
  }

  try {
    const msg = await normalizeTelegramWithTranscription(update);
    if (msg) await handleInbound(msg);

    return jsonOk();
  } catch (err: any) {
    console.error("[telegram] voice/audio transcription failed", err);

    const media = extractTelegramAudioMedia(update);
    const fallback = media
      ? buildTelegramInboundFromUpdate(
          update,
          "I received your voice message, but transcription failed. Please resend it or type the message.",
          media
        )
      : null;

    if (fallback) {
      await handleInbound(fallback);
    }

    return jsonOk({
      transcribeError: true,
      error: err?.message ?? "Unknown transcription error",
    });
  }
}

// ============================================================
// Pairing
// ============================================================
async function maybeHandleChatPairingCommand(msg: InboundMessage): Promise<boolean> {
  const envAllowConfigured =
    (msg.channel === "telegram" && process.env.TELEGRAM_ALLOWED_USERS != null) ||
    (msg.channel === "whatsapp" && process.env.WHATSAPP_ALLOWED_NUMBERS != null) ||
    (msg.channel === "sms" && process.env.SMS_ALLOWED_NUMBERS != null);

  if (envAllowConfigured) return false;

  const cmd = parsePairCommand(msg.text);
  if (!cmd) return false;

  const identity = makeIdentity(msg.channel, msg.senderId);

  if (!cmd.code) {
    const pending = await getPendingCode(identity);

    if (pending) {
      await sendOutboundRuntime({
        channel: msg.channel,
        sessionId: msg.sessionId,
        text: `Pending pairing code: ${pending}\nReply with /pair ${pending}`,
      });
    } else {
      const code = await createPairing(identity);

      await sendOutboundRuntime({
        channel: msg.channel,
        sessionId: msg.sessionId,
        text: `Pairing code: ${code}\nReply with /pair ${code}`,
      });
    }

    return true;
  }

  const ok = await approvePairing(identity, cmd.code);

  await sendOutboundRuntime({
    channel: msg.channel,
    sessionId: msg.sessionId,
    text: ok ? "✅ Paired. You can now use the bot." : "❌ Invalid or expired pairing code.",
  });

  return true;
}

// ============================================================
// Workflow routing
// ============================================================
async function routeToSession(msg: InboundMessage): Promise<void> {
  await start(sessionWorkflow, [msg.sessionId, msg]);
}

// ============================================================
// Inbound handling
// ============================================================
async function handleInbound(msg: InboundMessage): Promise<void> {
  if (await maybeHandleChatPairingCommand(msg)) return;

  // HARD /stop + /start at ingress (no LLM; no workflow)
  {
    const store = getStore();
    const key = stopKey(msg.channel, msg.sessionId);

    if (isStopCmd(msg.text)) {
      await store.set(key, "1", {
        exSeconds: 60 * 60 * 24 * 365,
      });

      await sendOutboundRuntime({
        channel: msg.channel,
        sessionId: msg.sessionId,
        text: "✅ Stopped. Send /start to resume.",
      });

      return;
    }

    if (isStartCmd(msg.text)) {
      await store.set(key, "0", {
        exSeconds: 5,
      });

      await sendOutboundRuntime({
        channel: msg.channel,
        sessionId: msg.sessionId,
        text: "✅ Resumed.",
      });

      return;
    }

    const stopped = await store.get(key);
    if (stopped === "1") return;
  }

  const allowed = await isInboundAllowed(msg);

  await saveSessionMeta(
    {
      channel: msg.channel,
      sessionId: msg.sessionId,
      senderId: msg.senderId,
      senderUsername: msg.senderUsername,
      updatedAt: Date.now(),
    },
    {
      updateLast: allowed.allowed,
    }
  );

  if (!allowed.allowed) {
    const hasTelegramAllow = process.env.TELEGRAM_ALLOWED_USERS != null;
    const hasWhatsAllow = process.env.WHATSAPP_ALLOWED_NUMBERS != null;
    const hasSmsAllow = process.env.SMS_ALLOWED_NUMBERS != null;

    const identity = makeIdentity(msg.channel, msg.senderId);

    if (
      (msg.channel === "telegram" && hasTelegramAllow) ||
      (msg.channel === "whatsapp" && hasWhatsAllow) ||
      (msg.channel === "sms" && hasSmsAllow)
    ) {
      const hint =
        msg.channel === "telegram"
          ? `Set TELEGRAM_ALLOWED_USERS to include: ${msg.senderId}${
              msg.senderUsername ? ` or @${msg.senderUsername}` : ""
            }`
          : msg.channel === "whatsapp"
            ? `Set WHATSAPP_ALLOWED_NUMBERS to include: ${msg.senderId} (E.164)`
            : `Set SMS_ALLOWED_NUMBERS to include: ${msg.senderId} (E.164)`;

      await sendOutboundRuntime({
        channel: msg.channel,
        sessionId: msg.sessionId,
        text: `🔒 Unauthorized (${allowed.reason ?? "not allowed"}).\nIdentity: ${identity}\n\nOperator hint: ${hint}`,
      });

      return;
    }

    const pending = await getPendingCode(identity);
    const code = pending ?? (await createPairing(identity));

    await sendOutboundRuntime({
      channel: msg.channel,
      sessionId: msg.sessionId,
      text:
        `🔒 This bot is locked.\n` +
        `Reply with: /pair ${code}\n` +
        `This code expires in 15 minutes.`,
    });

    return;
  }

  await routeToSession(msg);
}

// ============================================================
// GET handler
// ============================================================
export async function GET(req: Request) {
  const url = new URL(req.url);
  const op = url.searchParams.get("op");

  if (op === "health") return jsonOk({ ts: Date.now() });

  if (op === "cron") {
    return handleCronTrigger();
  }

  if (op === "whatsapp") {
    const v = whatsappVerifyChallenge(url);

    if (v.ok) return new Response(v.challenge ?? "", { status: 200 });

    return new Response("Verification failed", { status: 403 });
  }

  if (op === "media") {
    const raw = url.searchParams.get("url") ?? "";
    if (!raw) return new Response("Missing url param", { status: 400 });

    const decoded = safeDecodeMediaUrlParam(decodeURIComponent(raw));

    let u: URL;

    try {
      u = new URL(decoded);
    } catch {
      return new Response("Bad url", { status: 400 });
    }

    if (!MEDIA_ALLOWED_HOSTS.has(u.host)) {
      return new Response("Host not allowed", { status: 403 });
    }

    const res = await fetch(u.toString(), {
      method: "GET",
    });

    if (!res.ok) {
      return new Response(`Upstream error: ${res.status}`, {
        status: 502,
      });
    }

    const contentType = res.headers.get("content-type") ?? "application/octet-stream";

    const headers = new Headers();
    headers.set("content-type", contentType);
    headers.set("cache-control", "public, max-age=31536000, immutable");

    const etag = res.headers.get("etag");
    if (etag) headers.set("etag", etag);

    const lastMod = res.headers.get("last-modified");
    if (lastMod) headers.set("last-modified", lastMod);

    return new Response(res.body, {
      status: 200,
      headers,
    });
  }

  if (op === "webhook") {
    const ok = await verifyGatewayBearer(req);
    if (!ok) return new Response("Unauthorized", { status: 401 });

    const body = await req.json().catch(() => null);
    if (!body) return new Response("Bad JSON", { status: 400 });

    const message = String(body.message ?? "");
    if (!message) return new Response("Missing field: message", { status: 400 });

    const deliver = body.deliver !== undefined ? Boolean(body.deliver) : true;
    const channel = String(body.channel ?? "last");
    const allowSessionOverride = env("ALLOW_WEBHOOK_SESSION_ID") === "true";
    const requestedSessionId = allowSessionOverride ? String(body.sessionId ?? "") : "";

    let target: { channel: Channel; sessionId: string } | null = null;

    if (requestedSessionId) {
      const meta = await getSessionMeta(requestedSessionId);
      if (meta) target = { channel: meta.channel, sessionId: meta.sessionId };
    } else if (channel === "last") {
      target = await getLastSession("any");
    } else if (channel === "telegram" || channel === "whatsapp" || channel === "sms") {
      target = await getLastSession(channel);
    }

    if (!deliver) return new Response(null, { status: 202 });
    if (!target) return new Response("No active chat session to deliver to", { status: 409 });

    const meta = await getSessionMeta(target.sessionId);
    if (!meta) return new Response("Missing session metadata", { status: 409 });

    const synthetic: InboundMessage = {
      channel: meta.channel,
      sessionId: meta.sessionId,
      senderId: meta.senderId,
      senderUsername: meta.senderUsername,
      text: message,
      ts: Date.now(),
      raw: {
        source: "webhook",
      },
    };

    await routeToSession(synthetic);

    return new Response(null, { status: 202 });
  }

  if (op === "telegram") {
    return handleTelegramWebhook(req);
  }

  return new Response("Not found", { status: 404 });
}

// ============================================================
// POST handler
// ============================================================
export async function POST(req: Request) {
  const url = new URL(req.url);
  const op = url.searchParams.get("op");

  if (op === "cron") {
    return handleCronTrigger();
  }

  if (op === "pair") {
    await ensurePairingCode();

    const code = req.headers.get("x-pairing-code") ?? "";
    if (!code) return new Response("Missing X-Pairing-Code header", { status: 401 });

    const token = await exchangePairingCode(code);
    if (!token) return new Response("Invalid pairing code", { status: 401 });

    return jsonOk({ token });
  }

  if (op === "webhook") {
    const ok = await verifyGatewayBearer(req);
    if (!ok) return new Response("Unauthorized", { status: 401 });

    const body = await req.json().catch(() => null);
    if (!body) return new Response("Bad JSON", { status: 400 });

    const message = String(body.message ?? "");
    if (!message) return new Response("Missing field: message", { status: 400 });

    const deliver = body.deliver !== undefined ? Boolean(body.deliver) : true;
    const channel = String(body.channel ?? "last");
    const allowSessionOverride = env("ALLOW_WEBHOOK_SESSION_ID") === "true";
    const requestedSessionId = allowSessionOverride ? String(body.sessionId ?? "") : "";

    let target: { channel: Channel; sessionId: string } | null = null;

    if (requestedSessionId) {
      const meta = await getSessionMeta(requestedSessionId);
      if (meta) target = { channel: meta.channel, sessionId: meta.sessionId };
    } else if (channel === "last") {
      target = await getLastSession("any");
    } else if (channel === "telegram" || channel === "whatsapp" || channel === "sms") {
      target = await getLastSession(channel);
    }

    if (!deliver) return new Response(null, { status: 202 });
    if (!target) return new Response("No active chat session to deliver to", { status: 409 });

    const meta = await getSessionMeta(target.sessionId);
    if (!meta) return new Response("Missing session metadata", { status: 409 });

    const synthetic: InboundMessage = {
      channel: meta.channel,
      sessionId: meta.sessionId,
      senderId: meta.senderId,
      senderUsername: meta.senderUsername,
      text: message,
      ts: Date.now(),
      raw: {
        source: "webhook",
      },
    };

    await routeToSession(synthetic);

    return new Response(null, { status: 202 });
  }

  if (op === "telegram") {
    return handleTelegramWebhook(req);
  }

  if (op === "sms") {
    const raw = await req.text();

    const apiKey = getTextbeltApiKeyOptional();

    if (apiKey && shouldVerifyTextbeltWebhook()) {
      const sig = req.headers.get("x-textbelt-signature");
      const ts = req.headers.get("x-textbelt-timestamp");

      const ok = await verifyTextbeltWebhook({
        apiKey,
        timestampHeader: ts,
        signatureHeader: sig,
        rawBody: raw,
      });

      if (!ok) return new Response("Invalid Textbelt signature", { status: 401 });
    }

    const body = JSON.parse(raw);
    const msg = normalizeTextbeltReply(body);

    if (msg) await handleInbound(msg);

    return jsonOk();
  }

  if (op === "whatsapp") {
    const raw = await req.text();
    const sig = req.headers.get("x-hub-signature-256");

    if (!(await verifyWhatsAppSignature(raw, sig))) {
      return new Response("Invalid signature", { status: 401 });
    }

    const body = JSON.parse(raw);
    const messages = normalizeWhatsApp(body);

    for (const m of messages) {
      await handleInbound(m);
    }

    return jsonOk();
  }

  return new Response("Not found", { status: 404 });
}
