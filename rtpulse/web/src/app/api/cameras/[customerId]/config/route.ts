import { NextRequest, NextResponse } from "next/server";
import { getCameraStreams } from "@/lib/cameras";
import { getCustomer } from "@/lib/customers";

type Params = { params: Promise<{ customerId: string }> };

/**
 * GET /api/cameras/{customerId}/config
 *
 * rtpulse가 주기적으로 폴링해서 스트림 목록을 DB와 동기화하는 엔드포인트.
 * enabled 카메라의 mainstream + substream URL을 rtpulse 스트림 형식으로 반환합니다.
 *
 * Response:
 * [
 *   { "name": "카메라1 (메인)", "url": "rtsp://..." },
 *   { "name": "카메라1 (서브)", "url": "rtsp://..." },
 *   ...
 * ]
 *
 * rtpulse 설정 예시:
 *   RTPULSE_API_URL=https://watch.example.com
 *   CUSTOMER_ID={customerId}
 *   # rtpulse가 30초마다 이 엔드포인트를 폴링해 스트림 목록을 동기화
 */
export async function GET(_: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const streams = await getCameraStreams(customerId);
  return NextResponse.json(streams);
}
