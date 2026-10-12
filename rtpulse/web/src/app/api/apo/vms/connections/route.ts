import { NextRequest, NextResponse } from "next/server";
import { apoFetch, getApoBaseUrl, toApoMountPath } from "@/lib/apo-backend";

export const runtime = "nodejs";

/**
 * POST /api/apo/vms/connections
 * VMS DB 연결 → APO 백엔드의 POST /vms/connections 로 프록시
 *
 * Body: { host, port, user, password, dbName, savePath }
 * Response: { ok, tables }
 */
export async function POST(req: NextRequest) {
  try {
    getApoBaseUrl(); // APO_BASE_URL 미설정 시 에러 조기 감지
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 503 }
    );
  }

  try {
    const body = await req.json();
    // NAS 경로(/rtpulse/...)를 APO 서버 마운트 경로(/mnt/rtpulse/...)로 변환
    if (body && typeof body.savePath === "string") body.savePath = toApoMountPath(body.savePath);
    const upstream = await apoFetch("/vms/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await upstream.json();
    return NextResponse.json(data, { status: upstream.status });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
