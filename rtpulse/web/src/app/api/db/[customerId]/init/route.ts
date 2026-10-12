import { NextRequest, NextResponse } from "next/server";
import { getCustomer } from "@/lib/customers";
import mysql from "mysql2/promise";

type Params = { params: Promise<{ customerId: string }> };

/**
 * POST /api/db/{customerId}/init
 * DB 연결 테스트 및 camera_events 테이블 존재 여부를 확인합니다.
 */
export async function POST(_: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const serverIp = customer.ip ?? new URL(customer.apiUrl).hostname;
  const ip = customer.vip || serverIp;
  const dbName = customer.dbName ?? "";
  const dbPort = customer.dbPort ?? 3306;
  const dbUser = customer.dbUser ?? "ops";
  const dbPassword = customer.dbPassword ?? "";

  if (!dbName)
    return NextResponse.json({ error: "DB 이름이 설정되지 않았습니다." }, { status: 400 });
  if (!dbPassword)
    return NextResponse.json({ error: "DB 비밀번호를 먼저 설정하세요." }, { status: 400 });

  let conn: mysql.Connection | null = null;
  try {
    conn = await mysql.createConnection({
      host: ip, port: dbPort, user: dbUser, password: dbPassword,
      database: dbName, connectTimeout: 8000,
    });

    // camera_events 테이블 존재 확인
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM information_schema.tables
       WHERE table_schema = ? AND table_name = 'camera_events'`,
      [dbName]
    );
    const exists = rows[0]?.cnt > 0;

    if (!exists) {
      return NextResponse.json(
        { ok: false, message: `${dbName} DB에 camera_events 테이블이 없습니다.` },
        { status: 200 }
      );
    }

    // 행 수 확인
    const [countRows] = await conn.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS total FROM camera_events"
    );
    const total = countRows[0]?.total ?? 0;

    return NextResponse.json({
      ok: true,
      message: `연결 성공 — ${dbName}.camera_events (${total.toLocaleString()}건)`,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `DB 연결 실패: ${msg}` }, { status: 502 });
  } finally {
    await conn?.end();
  }
}
