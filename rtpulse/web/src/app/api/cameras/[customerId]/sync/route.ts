import { NextRequest, NextResponse } from "next/server";
import { getCameras, addCamera } from "@/lib/cameras";
import { getCustomer } from "@/lib/customers";

type Params = { params: Promise<{ customerId: string }> };

/**
 * POST /api/cameras/[customerId]/sync
 *
 * rtpulse에서 현재 모니터링 중인 스트림을 가져와
 * 카메라 레지스트리에 없는 항목을 자동으로 등록합니다.
 *
 * 매칭 규칙:
 * - 이름이 "{name} (메인)" / "{name} (서브)" 형식이면 한 쌍으로 묶어 카메라 1개 생성
 * - 그 외 이름은 개별 카메라로 등록
 * - 이미 URL이 등록된 스트림은 건너뜀
 */
export async function POST(_: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer?.apiUrl) {
    return NextResponse.json({ error: "Customer not found or no apiUrl" }, { status: 404 });
  }

  const base = customer.apiUrl.replace(/\/$/, "");

  let streams: Array<{ id: number; name: string; url: string }>;
  try {
    const res = await fetch(`${base}/api/streams`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`rtpulse responded ${res.status}`);
    streams = await res.json();
  } catch (e) {
    return NextResponse.json(
      { error: "rtpulse에 연결할 수 없습니다", detail: String(e) },
      { status: 502 }
    );
  }

  // 이미 등록된 URL 목록
  const existing = await getCameras(customerId);
  const registeredUrls = new Set<string>(
    existing.flatMap((c) => [c.mainstream_url, c.substream_url ?? ""].filter(Boolean))
  );

  // 미등록 스트림만 필터
  const newStreams = streams.filter((s) => !registeredUrls.has(s.url));
  if (newStreams.length === 0) {
    return NextResponse.json({ synced: 0, cameras: [] });
  }

  // 이름 패턴으로 메인/서브 짝 맞추기
  type StreamEntry = { id: number; name: string; url: string };
  const groups = new Map<string, { main?: StreamEntry; sub?: StreamEntry }>();
  const unpaired: StreamEntry[] = [];

  for (const s of newStreams) {
    if (s.name.endsWith(" (메인)")) {
      const base_name = s.name.slice(0, -5);
      if (!groups.has(base_name)) groups.set(base_name, {});
      groups.get(base_name)!.main = s;
    } else if (s.name.endsWith(" (서브)")) {
      const base_name = s.name.slice(0, -5);
      if (!groups.has(base_name)) groups.set(base_name, {});
      groups.get(base_name)!.sub = s;
    } else {
      unpaired.push(s);
    }
  }

  const addPromises: ReturnType<typeof addCamera>[] = [];

  // 짝이 맞는 카메라 등록
  for (const [name, { main, sub }] of groups) {
    if (main) {
      addPromises.push(addCamera(customerId, {
        name,
        mainstream_url: main.url,
        substream_url: sub?.url ?? "",
      }));
    } else if (sub) {
      // 서브만 있는 경우 (메인 없음)
      addPromises.push(addCamera(customerId, {
        name,
        mainstream_url: sub.url,
        substream_url: "",
      }));
    }
  }

  // 패턴 없는 스트림 개별 등록
  for (const s of unpaired) {
    addPromises.push(addCamera(customerId, {
      name: s.name,
      mainstream_url: s.url,
      substream_url: "",
    }));
  }

  const added = await Promise.all(addPromises);

  return NextResponse.json({ synced: added.length, cameras: added });
}
