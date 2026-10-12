/**
 * GET /api/maintenance/shipments
 *
 * IMS(ims) DB의 납품현황(shipments)을 읽어온다. (읽기 전용)
 * 유지보수 점검의 고객사 목록·설치(납품) 기준일 소스로 사용.
 *
 * 기본은 출하 완료/확정(SHIPPED·CONFIRMED) 건만. ?all=1 이면 전체.
 * Response: { shipments: [{ shipment_id, customer_name, title, status, delivery_date, shipped_at, confirmed_at }] }
 */
import { NextRequest, NextResponse } from "next/server";
import { getImsPool } from "@/lib/ims-db";

export const runtime = "nodejs";

interface ShipmentRow {
  shipment_id:   string;
  customer_name: string;
  title:         string;
  status:        string;
  delivery_date: string | null;
  shipped_at:    string | null;
  confirmed_at:  string | null;
  install_date:  string | null;  // 최초 설치일 = 발송처리일(shipped_at) 우선, 없으면 납품예정일(delivery_date)
  product_names: string | null;  // 출하 품목명 모음
  units:         ShipmentUnit[]; // 항목별 사양(시리얼 태그)
  service:        string | null;  // 서비스 (VMS/EDGE/ETC)
  deploy_mode:    string | null;  // 배포 방식 (BUNDLE/MANUAL)
  bundle_version: string | null;  // 번들 버전 (배포방식 BUNDLE)
  images:         ImageVersion[]; // 서비스 이미지 버전 (shipment_service_images)
}

/** 출하 품목/유닛 — 시리얼 태그를 항목별 사양으로 사용 */
interface ShipmentUnit {
  item_name: string;
  serial_no: string | null;
  tags:      Record<string, string> | null;
}

/** 서비스 이미지 버전 (IMS 서비스 납품정보) */
interface ImageVersion {
  image_name: string;
  version:    string;
}

export async function GET(req: NextRequest) {
  const all = req.nextUrl.searchParams.get("all") === "1";
  try {
    const pool = getImsPool();
    const { rows } = await pool.query<ShipmentRow>(
      `SELECT
         s.shipment_id, s.customer_name, s.title, s.status,
         s.delivery_date::text                              AS delivery_date,
         s.shipped_at,
         s.confirmed_at,
         -- 최초 설치일: 발송처리일(shipped_at) 우선, 없으면 납품예정일(기초재고 등록건)
         COALESCE(s.shipped_at::date, s.delivery_date)::text AS install_date,
         (SELECT string_agg(DISTINCT i.item_name, ', ')
            FROM shipment_items si JOIN items i ON i.item_code = si.item_code
           WHERE si.shipment_id = s.shipment_id)             AS product_names
       FROM shipments s
       ${all ? "" : "WHERE s.status IN ('SHIPPED','CONFIRMED')"}
       ORDER BY COALESCE(s.confirmed_at, s.shipped_at, s.created_at) DESC NULLS LAST`,
    );

    // 항목별 사양(시리얼 태그) — 실패해도 위 결과(설치일 등)는 유지되도록 분리 쿼리.
    const unitsByShip: Record<string, ShipmentUnit[]> = {};
    try {
      const u = await pool.query<{ shipment_id: string; units: ShipmentUnit[] }>(
        `SELECT si.shipment_id,
                json_agg(json_build_object(
                  'item_name', i.item_name,
                  'serial_no', sn.serial_no,
                  'tags',      sn.tags
                ) ORDER BY i.item_name, sn.serial_no) AS units
           FROM shipment_items si
           JOIN items i ON i.item_code = si.item_code
           LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(si.serial_number_ids, '[]'::jsonb)) sid ON TRUE
           LEFT JOIN serial_numbers sn ON sn.id = sid::int
          GROUP BY si.shipment_id`,
      );
      for (const r of u.rows) unitsByShip[r.shipment_id] = r.units ?? [];
    } catch (e) {
      console.warn("[maintenance/shipments] units(serial tags) 취합 실패:", e instanceof Error ? e.message : e);
    }
    for (const r of rows) r.units = unitsByShip[r.shipment_id] ?? [];

    // 서비스 납품정보(VMS 등) + 이미지 버전 — 실패해도 나머지 결과는 유지.
    const svcByShip: Record<string, { service: string | null; deploy_mode: string | null; bundle_version: string | null; images: ImageVersion[] }> = {};
    try {
      const sv = await pool.query<{ shipment_id: string; service: string | null; deploy_mode: string | null; bundle_version: string | null; images: ImageVersion[] }>(
        `SELECT ss.shipment_id, ss.service, ss.deploy_mode, ss.bundle_version,
                COALESCE(
                  (SELECT json_agg(json_build_object('image_name', im.image_name, 'version', im.version) ORDER BY im.image_name)
                     FROM shipment_service_images im WHERE im.service_id = ss.id),
                  '[]'::json
                ) AS images
           FROM shipment_services ss`,
      );
      for (const r of sv.rows) svcByShip[r.shipment_id] = { service: r.service, deploy_mode: r.deploy_mode, bundle_version: r.bundle_version, images: r.images ?? [] };
    } catch (e) {
      console.warn("[maintenance/shipments] service images 취합 실패:", e instanceof Error ? e.message : e);
    }
    for (const r of rows) {
      const s = svcByShip[r.shipment_id];
      r.service        = s?.service        ?? null;
      r.deploy_mode    = s?.deploy_mode    ?? null;
      r.bundle_version = s?.bundle_version ?? null;
      r.images         = s?.images         ?? [];
    }

    return NextResponse.json({ shipments: rows });
  } catch (e) {
    console.error("[maintenance/shipments]", e);
    // ims 접근 불가(권한/네트워크) 시에도 점검 기능은 동작하도록 빈 목록 반환.
    return NextResponse.json(
      { shipments: [], error: "IMS 납품현황 조회 실패 (ims DB 접근 권한 확인 필요)" },
      { status: 200 },
    );
  }
}
