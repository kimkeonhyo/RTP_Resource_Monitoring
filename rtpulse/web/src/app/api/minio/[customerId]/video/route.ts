import { NextRequest, NextResponse } from "next/server";
import { getCustomer } from "@/lib/customers";
import { Client as MinioClient } from "minio";

type Params = { params: Promise<{ customerId: string }> };

const MINIO_USER = process.env.MINIO_ACCESS_KEY ?? "";
const MINIO_PASS = process.env.MINIO_SECRET_KEY ?? "";
const PORTS = [9000, 32702];

/**
 * GET /api/minio/{customerId}/video?path=/app-service/minio/video/...&download=1
 *
 * MinIO에서 영상 파일을 가져와 프록시합니다.
 * download=1 쿼리 시 Content-Disposition: attachment 헤더를 붙여 다운로드 트리거.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return new NextResponse("Not found", { status: 404 });

  const videoPath = req.nextUrl.searchParams.get("path") ?? "";
  const isDownload = req.nextUrl.searchParams.get("download") === "1";
  if (!videoPath) return new NextResponse("path required", { status: 400 });

  const bucket = "video";
  const marker = "/video/";
  const markerIdx = videoPath.indexOf(marker);
  const objectKey =
    markerIdx !== -1
      ? videoPath.slice(markerIdx + marker.length)
      : videoPath.replace(/^\//, "");

  if (!objectKey) return new NextResponse("Invalid path", { status: 400 });

  if (!MINIO_USER || !MINIO_PASS) {
    return new NextResponse(
      "MINIO_ACCESS_KEY / MINIO_SECRET_KEY 환경변수가 설정되지 않았습니다.",
      { status: 500 }
    );
  }

  const ip = customer.vip || customer.ip || new URL(customer.apiUrl).hostname;
  const fileName = objectKey.split("/").pop() ?? "video.mp4";

  for (const port of PORTS) {
    try {
      const client = new MinioClient({
        endPoint: ip, port, useSSL: false,
        accessKey: MINIO_USER, secretKey: MINIO_PASS,
      });

      const stat   = await client.statObject(bucket, objectKey).catch(() => null);
      const stream = await client.getObject(bucket, objectKey);

      // 가드 필수: 클라이언트 취소로 컨트롤러가 닫힌 뒤 MinIO 스트림이 계속 밀면
      // 닫힌 컨트롤러 enqueue → 동기 예외 → uncaughtException(프로세스 사망).
      const readable = new ReadableStream({
        start(controller) {
          stream.on("data", (chunk: Buffer) => {
            try { controller.enqueue(chunk); }
            catch { stream.destroy(); }
          });
          stream.on("end",  () => { try { controller.close(); } catch { /* 이미 닫힘 */ } });
          stream.on("error", (err: Error) => { try { controller.error(err); } catch { /* 이미 닫힘 */ } });
        },
        cancel() { stream.destroy(); },
      });

      const headers: Record<string, string> = {
        "Content-Type": "video/mp4",
      };
      if (stat?.size) headers["Content-Length"] = String(stat.size);
      if (isDownload)  headers["Content-Disposition"] = `attachment; filename="${fileName}"`;

      return new NextResponse(readable, { headers });
    } catch (e) {
      console.error(`[minio/video] ${ip}:${port}/${bucket}/${objectKey} →`, e);
    }
  }

  return new NextResponse(
    `MinIO 연결 실패 (${ip}, bucket=${bucket}, key=${objectKey})`,
    { status: 502 }
  );
}
