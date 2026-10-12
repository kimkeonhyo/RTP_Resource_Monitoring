/**
 * GET  /api/prompt-records/schedule  — 현재 자동 동기화 스케줄 조회
 * PUT  /api/prompt-records/schedule  — 스케줄 저장 ({ enabled, times[], csv, json })
 */
import { NextRequest, NextResponse } from "next/server";
import { getSchedule, saveSchedule } from "@/lib/prompt-sync-schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getSchedule());
  } catch (e) {
    console.error("[prompt-sync-schedule] GET error:", e);
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    return NextResponse.json(await saveSchedule(body));
  } catch (e) {
    console.error("[prompt-sync-schedule] PUT error:", e);
    return NextResponse.json({ error: "저장 실패" }, { status: 500 });
  }
}
