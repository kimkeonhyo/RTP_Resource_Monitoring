/**
 * PATCH /api/maintenance/shipments/[shipmentId]/images
 *
 * IMS(ims) IMS 납품 서비스의 이미지 버전을 갱신한다. (직접 write)
 * 유지보수 점검에서 확인한 "최신 점검 이미지 기준"으로 IMS 서비스 납품정보
 * (shipment_service_images)의 버전을 반영하기 위한 엔드포인트.
 *
 * Body: { images: [{ image_name, version }] }
 *   - shipment_id로 shipment_services(1:1)의 service_id를 찾은 뒤,
 *   - 각 image_name에 대해 version을 UPDATE, 없으면 INSERT (upsert).
 *
 * ※ ims DB에 write 권한이 필요하다. 권한/스키마 문제 시 502로 반환하며
 *   watch 측 데이터(리포트)에는 영향을 주지 않는다.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getImsPool } from "@/lib/ims-db";

export const runtime = "nodejs";

type Params = { params: Promise<{ shipmentId: string }> };

interface ImageVersion { image_name: string; version: string }

export async function PATCH(req: NextRequest, { params }: Params) {
  const { shipmentId } = await params;
  if (!shipmentId) return NextResponse.json({ error: "shipmentId가 필요합니다." }, { status: 400 });
  const customer = req.nextUrl.searchParams.get("customer")?.trim() ?? "";

  let body: { images?: ImageVersion[]; bundle_version?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "요청 본문(JSON)이 올바르지 않습니다." }, { status: 400 });
  }

  const images = (body.images ?? [])
    .map((i) => ({ image_name: String(i.image_name ?? "").trim(), version: String(i.version ?? "").trim() }))
    .filter((i) => i.image_name);
  const bundleVersion = body.bundle_version != null ? String(body.bundle_version).trim() : null;

  if (images.length === 0 && bundleVersion == null) {
    return NextResponse.json({ error: "반영할 이미지 버전 또는 번들 버전이 없습니다." }, { status: 400 });
  }

  const pool = getImsPool();
  const client = await pool.connect().catch(() => null);
  if (!client) {
    return NextResponse.json({ error: "IMS DB 연결 실패" }, { status: 502 });
  }

  try {
    // 서비스 해석 — 1차: 납품번호, 2차(폴백): 고객사 최신 VMS 서비스
    // (연결 납품이 하드웨어 납품이면 서비스가 없어 고객사 기준으로 찾음)
    let serviceId: string | null = null;
    const bySh = await client.query<{ id: string }>(
      `SELECT id FROM shipment_services WHERE shipment_id = $1 LIMIT 1`,
      [shipmentId],
    );
    if (bySh.rows[0]) serviceId = bySh.rows[0].id;
    if (!serviceId && customer) {
      const byCust = await client.query<{ id: string }>(
        `SELECT ss.id FROM shipment_services ss
           JOIN shipments s ON s.shipment_id = ss.shipment_id
          WHERE s.customer_name = $1 AND ss.service = 'VMS'
          ORDER BY ss.updated_at DESC NULLS LAST, ss.created_at DESC NULLS LAST
          LIMIT 1`,
        [customer],
      );
      if (byCust.rows[0]) serviceId = byCust.rows[0].id;
    }
    await client.query("BEGIN");

    // 서비스가 없으면 연결 납품(shipmentId)에 VMS 서비스를 생성한다.
    // (점검에서 VMS 이미지 버전을 기록하려는데 IMS에 서비스가 없을 때)
    let serviceCreated = false;
    if (!serviceId) {
      const deployMode = bundleVersion != null ? "BUNDLE" : "MANUAL";
      try {
        const newId = randomUUID();
        const ins = await client.query<{ id: string }>(
          `INSERT INTO shipment_services (id, shipment_id, service, deploy_mode, bundle_version, created_at, updated_at)
           VALUES ($1, $2, 'VMS', $3, $4, now(), now())
           RETURNING id`,
          [newId, shipmentId, deployMode, bundleVersion],
        );
        serviceId = ins.rows[0].id;
        serviceCreated = true;
      } catch (e) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { error: `VMS 서비스 생성 실패 (해당 납품번호 ${shipmentId} 확인 필요): ${e instanceof Error ? e.message : String(e)}` },
          { status: 502 },
        );
      }
    }

    let updated = 0;
    let inserted = 0;
    let bundleUpdated = false;
    for (const img of images) {
      const upd = await client.query(
        `UPDATE shipment_service_images SET version = $1 WHERE service_id = $2 AND image_name = $3`,
        [img.version, serviceId, img.image_name],
      );
      if ((upd.rowCount ?? 0) > 0) {
        updated += upd.rowCount ?? 0;
      } else {
        await client.query(
          `INSERT INTO shipment_service_images (service_id, image_name, version) VALUES ($1, $2, $3)`,
          [serviceId, img.image_name, img.version],
        );
        inserted += 1;
      }
    }
    if (bundleVersion != null) {
      await client.query(
        `UPDATE shipment_services SET bundle_version = $1, updated_at = now() WHERE id = $2`,
        [bundleVersion, serviceId],
      );
      bundleUpdated = true;
    }
    await client.query("COMMIT");

    return NextResponse.json({ ok: true, service_id: serviceId, service_created: serviceCreated, updated, inserted, bundle_version: bundleUpdated ? bundleVersion : undefined });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /**/ }
    console.error("[maintenance/shipments/images] write 실패:", e);
    return NextResponse.json(
      { error: `IMS 이미지 버전 반영 실패 (ims write 권한 확인 필요): ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  } finally {
    client.release();
  }
}
