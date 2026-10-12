/**
 * GET /api/prompt-records/sync-status
 * Notion 동기화 백그라운드 작업의 현재 상태를 반환한다. 프런트가 폴링한다.
 */
import { NextResponse } from "next/server";
import { getSyncJob } from "@/lib/prompt-sync-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getSyncJob(), { headers: { "Cache-Control": "no-store" } });
}
