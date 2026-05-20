import { NextResponse } from "next/server";
import { env } from "@/app/lib/env";
import { getUiCookie, verifyUiToken } from "@/app/lib/uiAuth";
import { setAutopilotEnabled } from "@/app/lib/autopilotState";
import { start } from "workflow/api";
import { autopilotWorkflow } from "@/app/workflows/autopilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ok = verifyUiToken(await getUiCookie());
  if (!ok) return new Response("Unauthorized", { status: 401 });

  await setAutopilotEnabled(true);

  // fire-and-forget: autopilot loop runs durably
  await start(autopilotWorkflow, []);

  const url = new URL(req.url);
  const baseUrl = env("APP_BASE_URL") ?? `${url.protocol}//${url.host}`;
  return NextResponse.redirect(`${baseUrl.replace(/\/$/, "")}/ui#autopilot`, 303);
}
