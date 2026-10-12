/** GET /api/audit-logs?limit=&offset=&status=&actor=&targetType= — 감사 로그 조회 */
import { NextRequest, NextResponse } from "next/server";
import { listAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  try {
    const result = await listAudit({
      limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
      offset: sp.get("offset") ? Number(sp.get("offset")) : undefined,
      status: sp.get("status") || undefined,
      actor: sp.get("actor") || undefined,
      targetType: sp.get("targetType") || undefined,
    });
    return NextResponse.json(result);
  } catch (e) {
    console.error("[audit-logs] GET error:", e);
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }
}
