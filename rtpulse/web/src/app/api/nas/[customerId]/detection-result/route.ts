import { NextRequest, NextResponse } from "next/server";
import { getCustomer } from "@/lib/customers";
import { getPool, initDb } from "@/lib/db";

type Params = { params: Promise<{ customerId: string }> };

/**
 * GET /api/nas/{customerId}/detection-result
 * 고객사의 탐지 결과(TP/FP) 전체 목록을 반환합니다.
 * 응답: { results: Record<fileName, "TP" | "FP" | null>, customer_name: string }
 */
export async function GET(_: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await initDb();
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT file_name, result, label_name FROM detection_results WHERE customer_id = $1",
    [customerId]
  );

  const results:    Record<string, string | null> = {};
  const labelNames: Record<string, string | null> = {};
  for (const r of rows) {
    results[r.file_name]    = r.result;
    labelNames[r.file_name] = r.label_name ?? null;
  }

  return NextResponse.json({ results, labelNames, customer_name: customer.name });
}

/**
 * POST /api/nas/{customerId}/detection-result
 * Body: { fileName: string, result: "TP" | "FP" | null }
 * 탐지 결과를 저장(upsert)합니다. customer_name을 함께 저장해
 * 외부 시스템에서 고객사명으로 조회할 수 있습니다.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { fileName, result, eventName, cameraId, eventTime, thumbPath } = await req.json() as {
    fileName:   string;
    result:     "TP" | "FP" | "TN" | "FN" | null;
    eventName?: string;
    cameraId?:  string;
    eventTime?: string;
    thumbPath?: string;
  };

  if (!fileName) return NextResponse.json({ error: "fileName required" }, { status: 400 });

  await initDb();
  const pool = getPool();
  const updatedAt = new Date().toISOString();

  const finalEventName = eventName || null;
  const finalCameraId  = cameraId  || null;
  const finalEventTime = eventTime || null;
  const finalThumb     = thumbPath || null;

  // 1) detection_results upsert
  await pool.query(
    `INSERT INTO detection_results
       (customer_id, customer_name, file_name, result, auto_labeled, updated_at,
        event_name, camera_id, event_time)
     VALUES ($1, $2, $3, $4, FALSE, $5, $6, $7, $8)
     ON CONFLICT (customer_id, file_name)
     DO UPDATE SET
       customer_name = $2,
       result        = $4,
       auto_labeled  = FALSE,
       updated_at    = $5,
       event_name    = COALESCE($6, detection_results.event_name),
       camera_id     = COALESCE($7, detection_results.camera_id),
       event_time    = COALESCE($8, detection_results.event_time)`,
    [customerId, customer.name, fileName, result, updatedAt,
     finalEventName, finalCameraId, finalEventTime]
  );

  // 2) detection_results에서 최신값 조회 (이미 저장된 event_name/camera_id/event_time 포함)
  const drRow = await pool.query(
    `SELECT event_name, camera_id, event_time
     FROM detection_results
     WHERE customer_id = $1 AND file_name = $2`,
    [customerId, fileName]
  );
  const dr = drRow.rows[0] ?? {};

  // 3) copy_camera_events upsert — detection_results 최신값 기준으로 동기화
  await pool.query(
    `INSERT INTO copy_camera_events
       (_id, customer_id, customer_name, result, auto_labeling, updated_at,
        event_name, camera_id, event_time, thumbnail, is_media_exist)
     VALUES ($1, $2, $3, $4, FALSE, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (customer_id, _id)
     DO UPDATE SET
       result         = EXCLUDED.result,
       auto_labeling  = FALSE,
       updated_at     = EXCLUDED.updated_at,
       event_name     = COALESCE(EXCLUDED.event_name,  copy_camera_events.event_name),
       camera_id      = COALESCE(EXCLUDED.camera_id,   copy_camera_events.camera_id),
       event_time     = COALESCE(EXCLUDED.event_time,  copy_camera_events.event_time),
       thumbnail      = COALESCE(EXCLUDED.thumbnail,   copy_camera_events.thumbnail),
       is_media_exist = CASE
         WHEN EXCLUDED.thumbnail IS NOT NULL THEN TRUE
         ELSE copy_camera_events.is_media_exist
       END`,
    [fileName, customerId, customer.name, result, updatedAt,
     dr.event_name || null, dr.camera_id || null, dr.event_time || null,
     finalThumb, finalThumb ? true : false]
  );

  return NextResponse.json({ ok: true });
}
