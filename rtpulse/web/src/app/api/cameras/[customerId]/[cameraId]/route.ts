import { NextRequest, NextResponse } from "next/server";
import { getCamera, deleteCamera, updateCamera } from "@/lib/cameras";
import { getCustomer } from "@/lib/customers";

type Params = { params: Promise<{ customerId: string; cameraId: string }> };

export async function PUT(req: NextRequest, { params }: Params) {
  const { customerId, cameraId } = await params;
  const body = await req.json();
  const updated = await updateCamera(customerId, cameraId, body);
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(updated);
}

export async function DELETE(_: NextRequest, { params }: Params) {
  const { customerId, cameraId } = await params;

  // 삭제 전 카메라 정보 조회 (rtpulse 즉시 반영용)
  const camera = await getCamera(customerId, cameraId);

  const ok = await deleteCamera(customerId, cameraId);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // rtpulse에서도 즉시 제거 (best-effort — DB 삭제가 권위 소스)
  // 다음 rtpulse 폴링 주기(30s)에 자동으로도 동기화됨
  if (camera) {
    const customer = await getCustomer(customerId);
    if (customer?.apiUrl) {
      const base = customer.apiUrl.replace(/\/$/, "");
      try {
        const res = await fetch(`${base}/api/streams`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const streams: Array<{ id: number; name: string; url: string }> = await res.json();

          const targetUrls  = new Set([camera.mainstream_url, camera.substream_url].filter(Boolean));
          const targetNames = new Set([`${camera.name} (메인)`, `${camera.name} (서브)`]);
          const toDelete    = streams.filter((s) => targetUrls.has(s.url) || targetNames.has(s.name));

          await Promise.allSettled(
            toDelete.map((s) =>
              fetch(`${base}/api/streams/${s.id}`, {
                method: "DELETE",
                signal: AbortSignal.timeout(3000),
              })
            )
          );
        }
      } catch {
        // rtpulse 미연결 시 무시 — DB 삭제는 완료됨
        // 다음 폴링 주기에 rtpulse가 자동으로 반영함
      }
    }
  }

  return NextResponse.json({ ok: true });
}
