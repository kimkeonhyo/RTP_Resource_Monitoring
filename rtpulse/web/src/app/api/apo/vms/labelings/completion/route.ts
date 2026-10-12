import { NextRequest, NextResponse } from "next/server";
import { apoFetch, getApoBaseUrl } from "@/lib/apo-backend";

export const runtime = "nodejs";

/**
 * POST /api/apo/vms/labelings/completion
 * VMS 라벨링 완료 신호 → APO 백엔드의 POST /vms/labelings/completion
 *
 * Body: { events, conn, peCategory }
 * Response: { ok }
 */
export async function POST(req: NextRequest) {
  try {
    getApoBaseUrl();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 503 }
    );
  }

  try {
    const body = await req.json();
    const upstream = await apoFetch("/vms/labelings/completion", {
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
