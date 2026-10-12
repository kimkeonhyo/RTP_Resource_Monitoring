import { NextRequest, NextResponse } from "next/server";
import { getCustomer } from "@/lib/customers";
import mysql from "mysql2/promise";

type Params = { params: Promise<{ customerId: string }> };

import type { Customer } from "@/lib/types";
function getDbIp(customer: Customer | undefined) {
  if (!customer) return "";
  const serverIp = customer.ip ?? new URL(customer.apiUrl).hostname;
  return customer.vip || serverIp;
}

/**
 * POST /api/db/{customerId}/crawl
 * Body: { events?: string[], from: string, to: string, limit?: number }
 *
 * {고객사}DB의 camera_events 테이블에서 이벤트를 조회합니다.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const ip = getDbIp(customer);
  const dbName = customer.dbName ?? "";
  const dbPort = customer.dbPort ?? 3306;
  const dbUser = customer.dbUser ?? "ops";
  const dbPassword = customer.dbPassword ?? "";

  if (!dbName)
    return NextResponse.json({ error: "DB 이름이 설정되지 않았습니다. 고객사 수정 페이지에서 DB 이름을 입력하세요." }, { status: 400 });
  if (!dbPassword)
    return NextResponse.json({ error: "DB 비밀번호가 설정되지 않았습니다. 고객사 수정 페이지에서 DB 정보를 입력하세요." }, { status: 400 });

  const { events = [], from, to, limit = 500 } = await req.json() as {
    events?: string[];
    from: string;
    to: string;
    limit?: number;
  };

  let conn: mysql.Connection | null = null;
  try {
    conn = await mysql.createConnection({
      host: ip, port: dbPort, user: dbUser, password: dbPassword,
      database: dbName, connectTimeout: 8000,
    });

    const eventFilter = events.length > 0
      ? `AND event_name IN (${events.map(() => "?").join(",")})`
      : "";

    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT _id, camera_id, event_name, start_time, end_time,
              thumbnail, video_url, has_watched, is_media_exist,
              type, dis_connection
       FROM camera_events
       WHERE start_time BETWEEN ? AND ?
       ${eventFilter}
       ORDER BY start_time DESC
       LIMIT ?`,
      [from, to, ...events, limit]
    );

    return NextResponse.json({ rows, total: rows.length });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `DB 연결 실패: ${msg}` }, { status: 502 });
  } finally {
    await conn?.end();
  }
}

/**
 * GET /api/db/{customerId}/crawl
 * camera_events 테이블의 이벤트 종류 목록을 반환합니다.
 */
export async function GET(_: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const ip = getDbIp(customer);
  const dbName = customer.dbName ?? "";
  const dbPort = customer.dbPort ?? 3306;
  const dbUser = customer.dbUser ?? "ops";
  const dbPassword = customer.dbPassword ?? "";

  if (!dbName || !dbPassword) return NextResponse.json({ events: [] });

  let conn: mysql.Connection | null = null;
  try {
    conn = await mysql.createConnection({
      host: ip, port: dbPort, user: dbUser, password: dbPassword,
      database: dbName, connectTimeout: 5000,
    });
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      "SELECT DISTINCT event_name FROM camera_events ORDER BY event_name"
    );
    return NextResponse.json({ events: rows.map((r) => r.event_name as string) });
  } catch {
    return NextResponse.json({ events: [] });
  } finally {
    await conn?.end();
  }
}
