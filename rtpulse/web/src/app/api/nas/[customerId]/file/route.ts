import { NextRequest, NextResponse } from "next/server";
import { getCustomer } from "@/lib/customers";
import { Client as SshClient } from "ssh2";

type Params = { params: Promise<{ customerId: string }> };

/**
 * GET /api/nas/{customerId}/file?path=/rtpulse/...&type=thumbnail|video
 *
 * NAS에서 파일을 SFTP로 가져와 프록시합니다.
 * - type=thumbnail : Content-Type: image/jpeg, 캐시 1시간
 * - type=video     : Content-Disposition: attachment (다운로드)
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return new NextResponse("Not found", { status: 404 });

  const filePath = req.nextUrl.searchParams.get("path") ?? "";
  const fileType = req.nextUrl.searchParams.get("type") ?? "thumbnail";

  if (!filePath) return new NextResponse("path required", { status: 400 });

  const nasHost     = process.env.NAS_SSH_HOST     ?? "192.0.2.20"; // example
  const sshUser     = process.env.NAS_SSH_USER     ?? "ops";
  const sshPassword = process.env.NAS_SSH_PASSWORD ?? "";

  if (!sshPassword) return new NextResponse("NAS_SSH_PASSWORD not set", { status: 500 });

  return new Promise<NextResponse>((resolve) => {
    const conn = new SshClient();

    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          resolve(new NextResponse(`SFTP 실패: ${err.message}`, { status: 502 }));
          return;
        }

        const readStream = sftp.createReadStream(filePath);
        const chunks: Buffer[] = [];

        readStream.on("data", (chunk: Buffer) => chunks.push(chunk));
        readStream.on("error", (e: Error) => {
          conn.end();
          resolve(new NextResponse(`파일 읽기 실패: ${e.message}`, { status: 404 }));
        });
        readStream.on("close", () => {
          conn.end();
          const buffer = Buffer.concat(chunks);
          const isThumb = fileType === "thumbnail";
          const fileName = filePath.split("/").pop() ?? "file";
          resolve(
            new NextResponse(buffer, {
              headers: {
                "Content-Type": isThumb ? "image/jpeg" : "application/octet-stream",
                "Content-Disposition": isThumb
                  ? "inline"
                  : `attachment; filename="${encodeURIComponent(fileName)}"`,
                "Cache-Control": isThumb ? "public, max-age=3600" : "no-cache",
                "Content-Length": String(buffer.length),
              },
            })
          );
        });
      });
    });

    conn.on("error", (err) => {
      resolve(new NextResponse(`SSH 연결 실패: ${err.message}`, { status: 502 }));
    });

    conn.connect({
      host: nasHost,
      port: Number(process.env.NAS_SSH_PORT ?? 22),
      username: sshUser,
      password: sshPassword,
      readyTimeout: 10_000,
    });
  });
}
