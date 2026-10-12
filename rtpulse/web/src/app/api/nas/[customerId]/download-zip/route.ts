import { NextRequest, NextResponse } from "next/server";
import { getCustomer } from "@/lib/customers";
import { Client as SshClient, SFTPWrapper } from "ssh2";
import { zipSync, Zippable } from "fflate";

type Params = { params: Promise<{ customerId: string }> };

interface ZipItem {
  baseName: string;
  videoPath?: string;
  thumbPath?: string;
  videoFile?: string;
  thumbFile?: string;
}

/** SFTP에서 파일을 Buffer로 읽기 */
function sftpReadFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = sftp.createReadStream(path);
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end",  () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/**
 * POST /api/nas/{customerId}/download-zip
 * body: { items: ZipItem[], zipName?: string }
 *
 * 선택한 이벤트 파일들을 NAS에서 읽어 ZIP으로 묶어 반환합니다.
 * 영상/썸네일은 NAS에서 직접 스트리밍 → VM 영구 저장 없음.
 * 최대 30건 제한 (VM 메모리 보호)
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const { items, zipName = "events" }: { items: ZipItem[]; zipName?: string } = await req.json();
  if (!items?.length) return NextResponse.json({ error: "items 필요" }, { status: 400 });
  if (items.length > 30) return NextResponse.json({ error: "최대 30건까지 가능합니다." }, { status: 400 });

  const nasHost     = process.env.NAS_SSH_HOST     ?? "192.0.2.20"; // example
  const sshUser     = process.env.NAS_SSH_USER     ?? "ops";
  const sshPassword = process.env.NAS_SSH_PASSWORD ?? "";

  if (!sshPassword) {
    return NextResponse.json({ error: "NAS_SSH_PASSWORD 환경변수가 설정되지 않았습니다." }, { status: 500 });
  }

  return new Promise<NextResponse>((resolve) => {
    const conn = new SshClient();

    conn.on("ready", () => {
      conn.sftp(async (err, sftp) => {
        if (err) {
          conn.end();
          resolve(NextResponse.json({ error: `SFTP 세션 실패: ${err.message}` }, { status: 502 }));
          return;
        }

        const zipFiles: Zippable = {};
        const errors: string[] = [];

        for (const item of items) {
          const folder = item.baseName; // ZIP 내 폴더명 = 이벤트 이름

          // 영상 파일
          if (item.videoPath) {
            const fileName = item.videoFile ?? `${item.baseName}.mp4`;
            try {
              const buf = await sftpReadFile(sftp, item.videoPath);
              // level: 0 = store only (영상은 이미 압축된 형식)
              zipFiles[`${folder}/${fileName}`] = [new Uint8Array(buf), { level: 0 }];
            } catch (e: unknown) {
              errors.push(`${fileName}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }

          // 썸네일 파일
          if (item.thumbPath) {
            const fileName = item.thumbFile ?? `${item.baseName}.jpg`;
            try {
              const buf = await sftpReadFile(sftp, item.thumbPath);
              zipFiles[`${folder}/${fileName}`] = [new Uint8Array(buf), { level: 0 }];
            } catch (e: unknown) {
              errors.push(`${fileName}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }

        conn.end();

        if (Object.keys(zipFiles).length === 0) {
          resolve(NextResponse.json({ error: `파일을 읽을 수 없습니다. ${errors[0] ?? ""}` }, { status: 502 }));
          return;
        }

        const zipped  = zipSync(zipFiles);
        const safeZipName = zipName.replace(/[^\w가-힣-]/g, "_");
        // Cast ArrayBufferLike → ArrayBuffer for TypeScript (fflate always returns a plain ArrayBuffer)
        const ab   = zipped.buffer as ArrayBuffer;
        const view = new Uint8Array(ab, zipped.byteOffset, zipped.byteLength);
        const blob = new Blob([view], { type: "application/zip" });

        resolve(new NextResponse(blob, {
          status: 200,
          headers: {
            "Content-Type":        "application/zip",
            "Content-Disposition": `attachment; filename="${safeZipName}.zip"`,
            "Content-Length":      String(zipped.byteLength),
          },
        }));
      });
    });

    conn.on("error", (err) => {
      resolve(NextResponse.json({ error: `SSH 연결 실패: ${err.message}` }, { status: 502 }));
    });

    conn.connect({
      host:         nasHost,
      port:         Number(process.env.NAS_SSH_PORT ?? 22),
      username:     sshUser,
      password:     sshPassword,
      readyTimeout: 15_000,
    });
  });
}
