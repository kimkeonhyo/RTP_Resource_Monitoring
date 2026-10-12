import { NextResponse } from "next/server";
import { apoFetch, getApoBaseUrl } from "@/lib/apo-backend";

export const runtime = "nodejs";

/**
 * POST /api/apo/watch/connections
 * Watch DB 연결 → APO 백엔드의 POST /watch/connections 로 프록시
 *
 * Watch DB 접속 정보는 서버 환경변수에서 직접 읽어 APO 백엔드로 전달합니다.
 * Body: { host, port, user, password, dbName }
 * Response: { ok }
 */
export async function POST() {
  try {
    getApoBaseUrl();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 503 }
    );
  }

  const watchBody = {
    host:     process.env.PGHOST     ?? "localhost",
    port:     Number(process.env.PGPORT ?? "5432"),
    user:     process.env.PGUSER     ?? "",
    password: process.env.PGPASSWORD ?? "",
    dbName:   process.env.PGDATABASE ?? "rtpulse",
  };

  try {
    const upstream = await apoFetch("/watch/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(watchBody),
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
