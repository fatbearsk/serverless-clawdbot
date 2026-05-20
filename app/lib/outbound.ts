import type { Channel } from "@/app/lib/identity";
import { telegramSendMessage } from "@/app/lib/providers/telegram";
import { getTextbeltReplyWebhookUrl, textbeltSendSms } from "./providers/textbelt";
//import { whatsappSendMessage, whatsappSessionToTo } from "@/app/lib/providers/whatsapp";
//import { getTextbeltReplyWebhookUrl, textbeltSendSms } from "@/app/lib/providers/textbelt";

/**
 * Runtime outbound send helper.
 * Safe to call from:
 * - Route handlers (webhooks)
 * - Workflow steps
 */
export async function sendOutboundRuntime(args: { channel: Channel; sessionId: string; text: string; baseUrlHint?: string }) {
  const { channel, sessionId, text, baseUrlHint } = args;

  if (channel === "telegram") {
    await telegramSendMessage(sessionId, text);
    return;
  }
/*
  if (channel === "whatsapp") {
    const to = whatsappSessionToTo(sessionId);
    if (!to) throw new Error(`Invalid whatsapp sessionId: ${sessionId}`);
    await whatsappSendMessage(to, text);
    return;
  }
*/

  if (channel === "sms") {
    const to = sessionId.split(":")[1] ?? "";
    if (!to) throw new Error(`Invalid sms sessionId: ${sessionId}`);

    // Include reply webhook so the user can reply back to the bot (US numbers only, paid key required)
    const replyWebhookUrl = getTextbeltReplyWebhookUrl(baseUrlHint);

    const resp = await textbeltSendSms({
      to,
      message: text,
      replyWebhookUrl,
    });

    if (!resp.success) {
      throw new Error(`Textbelt send failed: ${resp.error ?? "unknown error"}`);
    }
    return;
  }

  throw new Error(`Unsupported channel: ${channel}`);
}
