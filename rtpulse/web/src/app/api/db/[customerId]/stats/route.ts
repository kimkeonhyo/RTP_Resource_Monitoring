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

// DST-safe: 해당 날짜 정오(noon) UTC 기준으로 오프셋 계산
function tzOffsetStr(tz: string, refDateStr: string): string {
  const noon = new Date(`${refDateStr}T12:00:00Z`);
  const tzMs  = new Date(noon.toLocaleString("en-US", { timeZone: tz })).getTime();
  const utcMs = new Date(noon.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  const offsetMin = Math.round((tzMs - utcMs) / 60_000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const hh = Math.floor(Math.abs(offsetMin) / 60).toString().padStart(2, "0");
  const mm = (Math.abs(offsetMin) % 60).toString().padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

function localDateToUtc(dateStr: string, isEnd: boolean, tz: string): string {
  const timeStr = isEnd ? "23:59:59" : "00:00:00";
  const offset  = tzOffsetStr(tz, dateStr);
  return new Date(`${dateStr}T${timeStr}${offset}`)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

type GroupBy = "day" | "week" | "month" | "camera" | "hour";

/**
 * POST /api/db/{customerId}/stats
 * Body: { from, to, groupBy: "day"|"week"|"month"|"camera"|"hour", events? }
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const ip = getDbIp(customer);
  const dbName     = customer.dbName ?? "";
  const dbPort     = customer.dbPort ?? 3306;
  const dbUser     = customer.dbUser ?? "ops";
  const dbPassword = customer.dbPassword ?? "";

  if (!dbName)
    return NextResponse.json(
      { error: "DB 이름이 설정되지 않았습니다. 고객사 수정 페이지에서 DB 이름을 입력하세요." },
      { status: 400 }
    );
  if (!dbPassword)
    return NextResponse.json(
      { error: "DB 비밀번호가 설정되지 않았습니다. 고객사 수정 페이지에서 DB 정보를 입력하세요." },
      { status: 400 }
    );

  const { from, to, groupBy, events = [], timezone } = (await req.json()) as {
    from: string;
    to: string;
    groupBy: GroupBy;
    events?: string[];
    timezone?: string;
  };

  // customer.timezone 우선, body timezone 차선, 기본값 Asia/Seoul
  const tz = customer.timezone ?? timezone ?? "Asia/Seoul";

  if (!["day", "week", "month", "camera", "hour"].includes(groupBy))
    return NextResponse.json({ error: "잘못된 groupBy 값입니다." }, { status: 400 });

  // 1년 초과 안전장치
  const fromOffset = tzOffsetStr(tz, from);
  const toOffset   = tzOffsetStr(tz, to);
  const diffDays =
    (new Date(`${to}T23:59:59${toOffset}`).getTime() - new Date(`${from}T00:00:00${fromOffset}`).getTime()) /
    86400000;
  if (diffDays > 366)
    return NextResponse.json({ error: "조회 기간은 최대 1년까지 지원합니다." }, { status: 400 });

  const utcFrom = localDateToUtc(from, false, tz);
  const utcTo   = localDateToUtc(to, true, tz);

  // CONVERT_TZ 오프셋: from~to 중간 날짜 기준 (DST 안전)
  const midDate = new Date((new Date(`${from}T12:00:00Z`).getTime() + new Date(`${to}T12:00:00Z`).getTime()) / 2);
  const midDateStr = midDate.toISOString().slice(0, 10);
  const tzOff = tzOffsetStr(tz, midDateStr);

  const bucketExpr =
    groupBy === "week"
      ? `DATE(DATE_SUB(CONVERT_TZ(start_time,'+00:00','${tzOff}'), INTERVAL WEEKDAY(CONVERT_TZ(start_time,'+00:00','${tzOff}')) DAY))`
      : groupBy === "month"
      ? `DATE_FORMAT(CONVERT_TZ(start_time,'+00:00','${tzOff}'), '%Y-%m-01')`
      : groupBy === "camera"
      ? "CAST(camera_id AS CHAR)"
      : groupBy === "hour"
      ? `LPAD(CAST(HOUR(CONVERT_TZ(start_time,'+00:00','${tzOff}')) AS CHAR), 2, '0')`
      : `DATE(CONVERT_TZ(start_time,'+00:00','${tzOff}'))`;

  const orderByExpr = groupBy === "camera"
    ? "CAST(bucket AS UNSIGNED) ASC, event_name ASC"
    : "bucket ASC, event_name ASC";

  const eventFilter =
    events.length > 0 ? `AND event_name IN (${events.map(() => "?").join(",")})` : "";

  let conn: mysql.Connection | null = null;
  try {
    conn = await mysql.createConnection({
      host: ip, port: dbPort, user: dbUser, password: dbPassword,
      database: dbName, connectTimeout: 8000,
    });

    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT
         ${bucketExpr} AS bucket,
         event_name,
         COUNT(*) AS count
       FROM camera_events
       WHERE start_time BETWEEN ? AND ?
       ${eventFilter}
       GROUP BY bucket, event_name
       ORDER BY ${orderByExpr}`,
      [utcFrom, utcTo, ...events]
    );

    const mapped = rows.map((r) => ({
      bucket:
        r.bucket instanceof Date
          ? r.bucket.toISOString().slice(0, 10)
          : groupBy === "camera" || groupBy === "hour"
          ? String(r.bucket)
          : String(r.bucket).slice(0, 10),
      event_name: r.event_name as string,
      count: Number(r.count),
    }));
    const total = mapped.reduce((s, r) => s + r.count, 0);

    return NextResponse.json({ rows: mapped, total, groupBy, from, to });
  } catch (e: unknown) {
    const msg  = e instanceof Error ? e.message : String(e);
    const hint = msg.toLowerCase().includes("timeout") ? " 기간을 줄여 보세요." : "";
    return NextResponse.json({ error: `DB 연결 실패: ${msg}${hint}` }, { status: 502 });
  } finally {
    await conn?.end();
  }
}
