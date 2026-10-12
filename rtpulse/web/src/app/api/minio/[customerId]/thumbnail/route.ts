import { NextRequest, NextResponse } from "next/server";
import { getCustomer } from "@/lib/customers";
import { Client as MinioClient } from "minio";

type Params = { params: Promise<{ customerId: string }> };

const MINIO_USER = process.env.MINIO_ACCESS_KEY ?? "";
const MINIO_PASS = process.env.MINIO_SECRET_KEY ?? "";
const PORTS = [9000, 32702];

/**
 * GET /api/minio/{customerId}/thumbnail?path=/thumbnail/20260410/file.jpg
 *
 * MinIO에서 썸네일 이미지를 가져와 프록시합니다.
 * MinIO IP = 고객사 VIP (Virtual-IP) 또는 서버 IP
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return new NextResponse("Not found", { status: 404 });

  const thumbnailPath = req.nextUrl.searchParams.get("path") ?? "";
  const isDownload    = req.nextUrl.searchParams.get("download") === "1";
  if (!thumbnailPath) return new NextResponse("path required", { status: 400 });

  // DB 경로 예시: /app-service/minio/thumbnail/20260419/file.jpg
  // → bucket=thumbnail, key=20260419/file.jpg
  // 경로에서 /thumbnail/ 세그먼트를 기준으로 분리
  const bucket = "thumbnail";
  const marker = "/thumbnail/";
  const markerIdx = thumbnailPath.indexOf(marker);
  const objectKey =
    markerIdx !== -1
      ? thumbnailPath.slice(markerIdx + marker.length)
      : thumbnailPath.replace(/^\//, "");

  if (!objectKey) {
    return new NextResponse("Invalid path", { status: 400 });
  }

  if (!MINIO_USER || !MINIO_PASS) {
    return new NextResponse("MINIO_ACCESS_KEY / MINIO_SECRET_KEY 환경변수가 설정되지 않았습니다.", { status: 500 });
  }

  const ip =
    customer.vip ||
    customer.ip ||
    new URL(customer.apiUrl).hostname;

  for (const port of PORTS) {
    try {
      const client = new MinioClient({
        endPoint: ip,
        port,
        useSSL: false,
        accessKey: MINIO_USER,
        secretKey: MINIO_PASS,
      });

      const stream = await client.getObject(bucket, objectKey);

      // Node.js Readable → Web ReadableStream
      // 가드 필수: 클라이언트가 응답을 취소하면 컨트롤러가 닫히는데, MinIO 스트림은
      // 계속 data를 밀어 닫힌 컨트롤러에 enqueue → 동기 예외 → uncaughtException(프로세스 사망).
      const readable = new ReadableStream({
        start(controller) {
          stream.on("data", (chunk: Buffer) => {
            try { controller.enqueue(chunk); }
            catch { stream.destroy(); } // 컨트롤러 닫힘(취소) → 소스 중단
          });
          stream.on("end",   () => { try { controller.close(); } catch { /* 이미 닫힘 */ } });
          stream.on("error", (err: Error) => { try { controller.error(err); } catch { /* 이미 닫힘 */ } });
        },
        cancel() { stream.destroy(); }, // 클라이언트 연결 종료 시 MinIO 스트림 정리
      });

      const fileName = objectKey.split("/").pop() ?? "thumbnail.jpg";
      const headers: Record<string, string> = {
        "Content-Type":  "image/jpeg",
        "Cache-Control": "public, max-age=3600",
      };
      if (isDownload) headers["Content-Disposition"] = `attachment; filename="${fileName}"`;

      return new NextResponse(readable, { headers });
    } catch (e) {
      console.error(`[minio] ${ip}:${port}/${bucket}/${objectKey} →`, e);
    }
  }

  return new NextResponse(`MinIO 연결 실패 (${ip}, bucket=${bucket}, key=${objectKey})`, { status: 502 });
}
