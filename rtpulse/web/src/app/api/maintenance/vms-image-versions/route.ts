/**
 * GET /api/maintenance/vms-image-versions?customer=<고객사명>&shipment=<납품번호>
 *
 * IMS(ims)의 VMS 서비스 이미지 버전을 조회한다. (읽기 전용)
 *   - current: 해당 납품(shipment_id)의 서비스 이미지별 현재 버전. IMS 납품상세와 동일.
 *              shipment 미지정/미매칭 시 고객사 최신 VMS 서비스로 폴백.
 *   - options: 드롭다운 선택지 — VMS Release Notes(Notion). 없으면 ims 사용 버전.
 *
 * 점검 결과 폼: 초기 버전은 IMS(current)에서, 드롭다운 목록은 릴리즈노트(options)에서.
 */
import { NextRequest, NextResponse } from "next/server";
import { getImsPool } from "@/lib/ims-db";
import { getVmsImageVersionOptions, getVmsBundles, type VmsBundle } from "@/lib/vms-release-notes";

export const runtime = "nodejs";

interface ImageVersion { image_name: string; version: string }

export async function GET(req: NextRequest) {
  const customer = req.nextUrl.searchParams.get("customer")?.trim() ?? "";
  const shipmentId = req.nextUrl.searchParams.get("shipment")?.trim() ?? "";
  try {
    const pool = getImsPool();

    // 드롭다운 선택지 — 1차: VMS Release Notes(Notion, IMS과 동일 소스)
    //                    2차(폴백): ims에서 실제 사용된 버전
    let options: Record<string, string[]> = {};
    try {
      options = await getVmsImageVersionOptions();
    } catch (e) {
      console.warn("[vms-image-versions] Notion 릴리즈노트 조회 실패, ims 폴백:", e instanceof Error ? e.message : e);
    }
    if (Object.keys(options).length === 0) {
      const opt = await pool.query<{ image_name: string; versions: string[] }>(
        `SELECT image_name,
                array_agg(DISTINCT version) FILTER (WHERE version IS NOT NULL AND version <> '') AS versions
           FROM shipment_service_images
          GROUP BY image_name`,
      );
      for (const r of opt.rows) options[r.image_name] = (r.versions ?? []).sort().reverse();
    }

    // 서비스 1건 해석 — 1차: 납품번호(shipment_id), 2차(폴백): 고객사 최신 VMS 서비스.
    // (점검이 연결된 납품이 하드웨어 납품이라 서비스가 없을 수 있어, 고객사 기준으로 폴백)
    let svc: { id: string; deploy_mode: string | null; bundle_version: string | null } | null = null;
    let via = "none";
    if (shipmentId) {
      const r = await pool.query<{ id: string; deploy_mode: string | null; bundle_version: string | null }>(
        `SELECT id, deploy_mode, bundle_version FROM shipment_services WHERE shipment_id = $1 LIMIT 1`,
        [shipmentId],
      );
      if (r.rows[0]) { svc = r.rows[0]; via = "shipment"; }
    }
    if (!svc && customer) {
      const r = await pool.query<{ id: string; deploy_mode: string | null; bundle_version: string | null }>(
        `SELECT ss.id, ss.deploy_mode, ss.bundle_version
           FROM shipment_services ss
           JOIN shipments s ON s.shipment_id = ss.shipment_id
          WHERE s.customer_name = $1 AND ss.service = 'VMS'
          ORDER BY ss.updated_at DESC NULLS LAST, ss.created_at DESC NULLS LAST
          LIMIT 1`,
        [customer],
      );
      if (r.rows[0]) { svc = r.rows[0]; via = "customer"; }
    }

    let current: ImageVersion[] = [];
    if (svc) {
      const im = await pool.query<ImageVersion>(
        `SELECT image_name, version FROM shipment_service_images WHERE service_id = $1 ORDER BY image_name`,
        [svc.id],
      );
      current = im.rows;
    }

    // 배포방식 BUNDLE용 번들 목록 (릴리즈노트) — best-effort
    let bundles: VmsBundle[] = [];
    try {
      bundles = await getVmsBundles();
    } catch (e) {
      console.warn("[vms-image-versions] 번들 목록 조회 실패:", e instanceof Error ? e.message : e);
    }

    console.log(`[vms-image-versions] customer="${customer}" shipment="${shipmentId}" svc=${svc ? svc.id : "none"}(via ${via}) deploy=${svc?.deploy_mode ?? "-"} current=${current.length} bundles=${bundles.length}`);
    return NextResponse.json({ current, options, bundles, deploy_mode: svc?.deploy_mode ?? null, bundle_version: svc?.bundle_version ?? null });
  } catch (e) {
    console.error("[maintenance/vms-image-versions]", e);
    // ims 접근 실패 시에도 폼은 동작하도록 빈 결과 반환.
    return NextResponse.json({ current: [], options: {}, error: "IMS 이미지 버전 조회 실패" }, { status: 200 });
  }
}
