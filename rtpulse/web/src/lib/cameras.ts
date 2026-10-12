/**
 * cameras.ts
 *
 * 카메라 설정의 단일 권위 소스(source of truth)를 PostgreSQL로 관리합니다.
 * rtpulse는 GET /api/cameras/{customerId}/config 를 주기적으로 폴링해
 * 스트림 목록을 DB와 동기화합니다.
 *
 * 이전: data/cameras/{customerId}.json (파일 기반)
 * 이후: cameras 테이블 (DB 기반)
 */

import { randomUUID } from "crypto";
import { getPool, initDb } from "./db";

export interface Camera {
  id: string;
  name: string;
  mainstream_url: string;
  substream_url: string;
  description?: string;
  location?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, unknown>;

function rowToCamera(r: Row): Camera {
  return {
    id:             r.id as string,
    name:           r.name as string,
    mainstream_url: r.mainstream_url as string,
    substream_url:  (r.substream_url as string) ?? "",
    description:    (r.description as string)   ?? undefined,
    location:       (r.location as string)       ?? undefined,
    enabled:        (r.enabled as boolean)       ?? true,
    createdAt:      r.created_at as string,
    updatedAt:      r.updated_at as string,
  };
}

async function pool() {
  await initDb();
  return getPool();
}

export async function getCameras(customerId: string): Promise<Camera[]> {
  const db = await pool();
  const { rows } = await db.query(
    `SELECT * FROM cameras WHERE customer_id = $1 ORDER BY created_at ASC`,
    [customerId]
  );
  return rows.map(rowToCamera);
}

export async function addCamera(
  customerId: string,
  data: Omit<Camera, "id" | "createdAt" | "updatedAt" | "enabled">
): Promise<Camera> {
  const db  = await pool();
  const now = new Date().toISOString();
  const id  = randomUUID();
  const { rows } = await db.query(
    `INSERT INTO cameras
       (id, customer_id, name, mainstream_url, substream_url,
        location, description, enabled, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$8)
     RETURNING *`,
    [
      id, customerId, data.name, data.mainstream_url,
      data.substream_url || null,
      data.location    || null,
      data.description || null,
      now,
    ]
  );
  return rowToCamera(rows[0]);
}

export async function updateCamera(
  customerId: string,
  cameraId: string,
  data: Partial<Omit<Camera, "id" | "createdAt" | "updatedAt">>
): Promise<Camera | null> {
  const db  = await pool();
  const now = new Date().toISOString();

  const sets: string[] = ["updated_at = $3"];
  const vals: unknown[] = [customerId, cameraId, now];
  let idx = 4;

  if (data.name           !== undefined) { sets.push(`name = $${idx++}`);           vals.push(data.name); }
  if (data.mainstream_url !== undefined) { sets.push(`mainstream_url = $${idx++}`); vals.push(data.mainstream_url); }
  if (data.substream_url  !== undefined) { sets.push(`substream_url = $${idx++}`);  vals.push(data.substream_url || null); }
  if (data.location       !== undefined) { sets.push(`location = $${idx++}`);       vals.push(data.location || null); }
  if (data.description    !== undefined) { sets.push(`description = $${idx++}`);    vals.push(data.description || null); }
  if (data.enabled        !== undefined) { sets.push(`enabled = $${idx++}`);        vals.push(data.enabled); }

  const { rows } = await db.query(
    `UPDATE cameras SET ${sets.join(", ")}
     WHERE customer_id = $1 AND id = $2
     RETURNING *`,
    vals
  );
  return rows[0] ? rowToCamera(rows[0]) : null;
}

export async function deleteCamera(customerId: string, cameraId: string): Promise<boolean> {
  const db = await pool();
  const { rowCount } = await db.query(
    `DELETE FROM cameras WHERE customer_id = $1 AND id = $2`,
    [customerId, cameraId]
  );
  return (rowCount ?? 0) > 0;
}

export async function getCamera(customerId: string, cameraId: string): Promise<Camera | null> {
  const db = await pool();
  const { rows } = await db.query(
    `SELECT * FROM cameras WHERE customer_id = $1 AND id = $2`,
    [customerId, cameraId]
  );
  return rows[0] ? rowToCamera(rows[0]) : null;
}

/** rtpulse 폴링용: enabled 카메라의 스트림 목록을 rtpulse API 형식으로 반환 */
export async function getCameraStreams(
  customerId: string
): Promise<Array<{ name: string; url: string }>> {
  const cameras = await getCameras(customerId);
  const streams: Array<{ name: string; url: string }> = [];
  for (const cam of cameras) {
    if (!cam.enabled) continue;
    streams.push({ name: `${cam.name} (메인)`, url: cam.mainstream_url });
    // 서브스트림 URL이 메인과 다를 때만 추가 (동일 URL 중복 방지)
    if (cam.substream_url && cam.substream_url !== cam.mainstream_url) {
      streams.push({ name: `${cam.name} (서브)`, url: cam.substream_url });
    }
  }
  return streams;
}

/** CSV 파싱 (파일 기반 시절과 동일 — DB와 무관) */
export function parseCsvCameras(
  csv: string
): Omit<Camera, "id" | "createdAt" | "updatedAt" | "enabled">[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  const start =
    lines[0]?.toLowerCase().includes("이름") ||
    lines[0]?.toLowerCase().includes("스트리밍")
      ? 1
      : 0;
  return lines
    .slice(start)
    .map((line) => {
      const cols = line.split(",").map((c) => c.trim());
      return {
        name:           cols[0] ?? "",
        mainstream_url: cols[1] ?? "",
        substream_url:  cols[2] ?? "",
        description:    cols[3] ?? undefined,
        location:       undefined,
      };
    })
    .filter((c) => c.name && c.mainstream_url);
}
