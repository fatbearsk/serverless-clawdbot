import type { Channel } from "@/app/lib/identity";
import { sendOutboundRuntime } from "@/app/lib/outbound";

export async function sendOutbound(args: { channel: Channel; sessionId: string; text: string }) {
  "use step";
  await sendOutboundRuntime(args);
}
