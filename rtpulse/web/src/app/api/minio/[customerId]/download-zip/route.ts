import { NextRequest, NextResponse } from "next/server";
import { getCustomer } from "@/lib/customers";
import { Client as MinioClient } from "minio";
import { zipSync, Zippable } from "fflate";

type Params = { params: Promise<{ customerId: string }> };

interface ZipItem {
  path:     string;   // MinIO path (e.g. /app-service/minio/video/...mp4)
  bucket:   string;   // "video" | "thumbnail"
  fileName: string;   // ZIP 내 파일명
  folder?:  string;   // ZIP 내 폴더명 (옵션)
}

const MINIO_USER = process.env.MINIO_ACCESS_KEY ?? "";
const MINIO_PASS = process.env.MINIO_SECRET_KEY ?? "";
const PORTS = [9000, 32702];

async function minioReadFile(client: MinioClient, bucket: string, key: string): Promise<Buffer> {
  const stream = await client.getObject(bucket, key);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data",  (c: Buffer) => chunks.push(c));
    stream.on("end",   () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/**
 * POST /api/minio/{customerId}/download-zip
 * body: { items: ZipItem[], zipName?: string }
 *
 * MinIO에서 선택한 파일들을 읽어 ZIP으로 묶어 반환합니다.
 * 최대 30건 제한 (VM 메모리 보호)
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const { items, zipName = "events" }: { items: ZipItem[]; zipName?: string } = await req.json();
  if (!items?.length) return NextResponse.json({ error: "items 필요" }, { status: 400 });
  if (items.length > 30) return NextResponse.json({ error: "최대 30건까지 가능합니다." }, { status: 400 });

  if (!MINIO_USER || !MINIO_PASS) {
    return NextResponse.json(
      { error: "MINIO_ACCESS_KEY / MINIO_SECRET_KEY 환경변수가 설정되지 않았습니다." },
      { status: 500 }
    );
  }

  const ip = customer.vip || customer.ip || new URL(customer.apiUrl).hostname;

  // 연결 가능한 포트 찾기
  let minioClient: MinioClient | null = null;
  for (const port of PORTS) {
    try {
      const c = new MinioClient({ endPoint: ip, port, useSSL: false, accessKey: MINIO_USER, secretKey: MINIO_PASS });
      await c.statObject(items[0].bucket, extractKey(items[0].path, items[0].bucket));
      minioClient = c;
      break;
    } catch { /* try next port */ }
  }

  if (!minioClient) {
    return NextResponse.json({ error: `MinIO 연결 실패 (${ip})` }, { status: 502 });
  }

  const zipFiles: Zippable = {};
  const errors: string[] = [];

  for (const item of items) {
    const key  = extractKey(item.path, item.bucket);
    const dest = item.folder ? `${item.folder}/${item.fileName}` : item.fileName;
    try {
      const buf = await minioReadFile(minioClient, item.bucket, key);
      zipFiles[dest] = [new Uint8Array(buf), { level: 0 }];
    } catch (e: unknown) {
      errors.push(`${item.fileName}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (Object.keys(zipFiles).length === 0) {
    return NextResponse.json({ error: `파일을 읽을 수 없습니다. ${errors[0] ?? ""}` }, { status: 502 });
  }

  const zipped      = zipSync(zipFiles);
  const safeZipName = zipName.replace(/[^\w가-힣-]/g, "_");
  const ab   = zipped.buffer as ArrayBuffer;
  const view = new Uint8Array(ab, zipped.byteOffset, zipped.byteLength);
  const blob = new Blob([view], { type: "application/zip" });

  return new NextResponse(blob, {
    status: 200,
    headers: {
      "Content-Type":        "application/zip",
      "Content-Disposition": `attachment; filename="${safeZipName}.zip"`,
      "Content-Length":      String(zipped.byteLength),
    },
  });
}

/** MinIO 경로에서 bucket 이후 key 추출 */
function extractKey(path: string, bucket: string): string {
  const marker = `/${bucket}/`;
  const idx = path.indexOf(marker);
  return idx !== -1 ? path.slice(idx + marker.length) : path.replace(/^\//, "");
}
