// app/workflows/session.ts
import type { InboundMessage } from "@/app/lib/normalize";
import type { ModelMessage } from "ai";

import { agentTurn } from "@/app/steps/agentTurn";
import { sendOutbound } from "@/app/steps/sendOutbound";
import { loadHistoryStep, saveHistoryStep } from "@/app/steps/sessionStateSteps";

// -----------------------------
// Helpers: multimodal user msg
// -----------------------------
type ImageInput =
  | { kind: "url"; value: string }
  | { kind: "base64"; value: string };

function extractImages(msg: InboundMessage): ImageInput[] {
  const m: any = msg as any;
  const out: ImageInput[] = [];

  // direct fields
  if (typeof m.imageUrl === "string" && m.imageUrl) out.push({ kind: "url", value: m.imageUrl });
  if (typeof m.image_url === "string" && m.image_url) out.push({ kind: "url", value: m.image_url });

  // arrays of urls
  if (Array.isArray(m.imageUrls)) for (const u of m.imageUrls) if (typeof u === "string" && u) out.push({ kind: "url", value: u });
  if (Array.isArray(m.image_urls)) for (const u of m.image_urls) if (typeof u === "string" && u) out.push({ kind: "url", value: u });

  // attachments/media/files
  const arrays: any[][] = [];
  if (Array.isArray(m.attachments)) arrays.push(m.attachments);
  if (Array.isArray(m.media)) arrays.push(m.media);
  if (Array.isArray(m.files)) arrays.push(m.files);

  for (const arr of arrays) {
    for (const a of arr) {
      if (!a) continue;

      const url =
        (typeof a.url === "string" && a.url) ||
        (typeof a.href === "string" && a.href) ||
        (typeof a.downloadUrl === "string" && a.downloadUrl) ||
        (typeof a.download_url === "string" && a.download_url) ||
        "";

      const mime =
        (typeof a.mimeType === "string" && a.mimeType) ||
        (typeof a.mime_type === "string" && a.mime_type) ||
        (typeof a.contentType === "string" && a.contentType) ||
        (typeof a.content_type === "string" && a.content_type) ||
        "";

      const isImageByMime = typeof mime === "string" && mime.startsWith("image/");
      const isImageByExt = typeof url === "string" && /\.(png|jpe?g|webp|gif|bmp|tiff?)($|\?)/i.test(url);

      if (url && (isImageByMime || isImageByExt)) out.push({ kind: "url", value: url });

      const b64 =
        (typeof a.base64 === "string" && a.base64) ||
        (typeof a.data === "string" && a.data) ||
        (typeof a.b64 === "string" && a.b64) ||
        "";

      if (b64 && (isImageByMime || b64.length > 200)) out.push({ kind: "base64", value: b64 });
    }
  }

  // raw base64 fields
  if (typeof m.imageBase64 === "string" && m.imageBase64) out.push({ kind: "base64", value: m.imageBase64 });
  if (typeof m.image_base64 === "string" && m.image_base64) out.push({ kind: "base64", value: m.image_base64 });

  // dedupe
  const seen = new Set<string>();
  return out.filter((x) => {
    const k = `${x.kind}:${x.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function buildUserModelMessage(msg: InboundMessage): ModelMessage {
  const images = extractImages(msg);

  if (!images.length) {
    return { role: "user", content: msg.text ?? "" };
  }

  const parts: any[] = [];
  if (msg.text && msg.text.trim()) parts.push({ type: "text", text: msg.text });

  for (const img of images) {
    if (img.kind === "url") parts.push({ type: "image", image: new URL(img.value) });
    else parts.push({ type: "image", image: img.value });
  }

  return { role: "user", content: parts } as any;
}

function trimHistory(history: ModelMessage[], maxMessages: number): ModelMessage[] {
  const m = Math.max(6, Math.min(200, maxMessages));
  return history.length <= m ? history : history.slice(history.length - m);
}

// -----------------------------
// The workflow (NO HOOKS)
// -----------------------------
export async function sessionWorkflow(sessionId: string, msg: InboundMessage) {
  "use workflow";

  let history = (await loadHistoryStep(sessionId)) as ModelMessage[];
  history = Array.isArray(history) ? history : [];

  const max = Number(process.env.HISTORY_MAX_MESSAGES ?? "30");
  history = trimHistory(history, Number.isFinite(max) ? max : 30);

  history.push(buildUserModelMessage(msg));

  const result = await agentTurn({
    sessionId,
    userId: `${msg.channel}:${msg.senderId}`,
    channel: msg.channel,
    history,
    showTyping: msg.channel === "telegram",
  });

  history.push({ role: "assistant", content: result.text });
  await saveHistoryStep(sessionId, history);

  // ✅ Avoid duplicates: if Telegram streaming already delivered, do not send again
  if (!(result as any).delivered) {
    await sendOutbound({
      channel: msg.channel,
      sessionId: msg.sessionId,
      text: result.text,
    });
  }
}
