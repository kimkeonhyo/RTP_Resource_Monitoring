import { NextRequest, NextResponse } from "next/server";
import { getCustomer } from "@/lib/customers";
import { getPool, initDb } from "@/lib/db";

type Params = { params: Promise<{ customerId: string }> };

interface EventEntry {
  baseName: string;
  cameraId: string;
  eventName: string;
  startTime: string;
  subPath: string;
  videoPath?: string;
  thumbPath?: string;
  videoFile?: string;
  thumbFile?: string;
}

/**
 * GET /api/nas/{customerId}/register-events
 * 등록된 이벤트 base_name 목록 반환 (이미 등록된 항목 표시용)
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  await initDb();
  const pool = getPool();

  const subPath = req.nextUrl.searchParams.get("subPath") ?? "";
  const { rows } = await pool.query(
    `SELECT base_name, camera_id, event_name, start_time, sub_path,
            video_path, thumb_path, video_file, thumb_file, registered_at
     FROM event_registrations
     WHERE customer_id = $1
     ${subPath ? "AND sub_path = $2" : ""}
     ORDER BY start_time DESC NULLS LAST`,
    subPath ? [customerId, subPath] : [customerId]
  );

  const registered = new Set(rows.map((r: { base_name: string }) => r.base_name));
  return NextResponse.json({ registered: Array.from(registered), events: rows });
}

/**
 * POST /api/nas/{customerId}/register-events
 * body: { entries: EventEntry[] }
 * 선택한 이벤트를 DB에 일괄 등록 (중복 시 경로 업데이트)
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const { entries }: { entries: EventEntry[] } = await req.json();
  if (!entries?.length) return NextResponse.json({ error: "entries 필요" }, { status: 400 });

  await initDb();
  const pool = getPool();

  const registeredAt = new Date().toISOString();
  let inserted = 0;

  for (const e of entries) {
    await pool.query(
      `INSERT INTO event_registrations
         (customer_id, base_name, camera_id, event_name, start_time, sub_path,
          video_path, thumb_path, video_file, thumb_file, registered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (customer_id, base_name) DO UPDATE
         SET video_path    = EXCLUDED.video_path,
             thumb_path    = EXCLUDED.thumb_path,
             video_file    = EXCLUDED.video_file,
             thumb_file    = EXCLUDED.thumb_file,
             sub_path      = EXCLUDED.sub_path,
             registered_at = EXCLUDED.registered_at`,
      [
        customerId, e.baseName,
        e.cameraId  || null,   // 빈 문자열도 NULL로
        e.eventName || null,
        e.startTime || null,
        e.subPath ?? "",
        e.videoPath || null, e.thumbPath || null,
        e.videoFile || null, e.thumbFile || null,
        registeredAt,
      ]
    );
    inserted++;
  }

  return NextResponse.json({ ok: true, inserted });
}

/**
 * DELETE /api/nas/{customerId}/register-events
 * body: { baseNames: string[] }
 * 선택한 이벤트를 DB에서 삭제 (등록 해제)
 */
export async function DELETE(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const { baseNames }: { baseNames: string[] } = await req.json();
  if (!baseNames?.length) return NextResponse.json({ error: "baseNames 필요" }, { status: 400 });

  await initDb();
  const pool = getPool();

  const { rowCount } = await pool.query(
    `DELETE FROM event_registrations WHERE customer_id = $1 AND base_name = ANY($2)`,
    [customerId, baseNames]
  );

  return NextResponse.json({ ok: true, deleted: rowCount ?? 0 });
}
