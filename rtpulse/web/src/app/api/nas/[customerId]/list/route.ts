import { NextRequest, NextResponse } from "next/server";
import { getCustomer } from "@/lib/customers";
import { Client as SshClient, SFTPWrapper } from "ssh2";

type Params = { params: Promise<{ customerId: string }> };

/** NAS에서 스캔한 하나의 이벤트 항목 (thumbnail + video 병합) */
export interface NasEntry {
  baseName: string;         // "189_intrusion_20260419_205033" (확장자 제외)
  cameraId: string;
  eventName: string;
  startTime: string;        // "2026-04-20 05:55:32"
  videoFileName?: string;   // "189_intrusion_20260419_205033.mp4"
  thumbFileName?: string;   // "189_intrusion_20260419_205033.jpg"
  videoPath?: string;       // full NAS path (파일 다운로드용)
  thumbPath?: string;
  videoSize: number;
  thumbSize: number;
  hasVideo: boolean;
  hasThumb: boolean;
}

/** "20260420_055532" -> "2026-04-20 05:55:32" */
function parseTs(ts: string): string {
  const d = ts.replace("_", "");
  return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)} ${d.slice(8,10)}:${d.slice(10,12)}:${d.slice(12,14)}`;
}

/** "189_intrusion_20260420_055532" -> { cameraId, eventName, startTime }
 *  파싱 불가 시 파일명을 최대한 분해해 fallback 반환 (null 없음) */
function parseBaseName(base: string): { cameraId: string; eventName: string; startTime: string } {
  // 표준 포맷: {cam}_{event}_{YYYYMMDD}_{HHMMSS}
  const m = base.match(/^(.+)_(\d{8}_\d{6})$/);
  if (m) {
    const rest = m[1];
    const ts   = m[2];
    const idx  = rest.indexOf("_");
    if (idx !== -1) {
      return {
        cameraId:  rest.slice(0, idx),
        eventName: rest.slice(idx + 1),
        startTime: parseTs(ts),
      };
    }
  }
  // 유닉스 타임스탬프 포맷: {cam}_{anything}_{unix_ms}
  const parts = base.split("_");
  if (parts.length >= 2) {
    return {
      cameraId:  parts[0],
      eventName: parts.slice(1, parts.length - 1).join("_") || parts[parts.length - 1],
      startTime: "",
    };
  }
  return { cameraId: base, eventName: "", startTime: "" };
}

function sftpReaddir(
  sftp: SFTPWrapper,
  dirPath: string,
): Promise<{ filename: string; attrs: { size: number } }[]> {
  return new Promise((resolve) =>
    sftp.readdir(dirPath, (err, list) =>
      err ? resolve([]) : resolve(list as { filename: string; attrs: { size: number } }[])
    )
  );
}

/**
 * GET /api/nas/{customerId}/list?subPath=videos/demo-test/test
 *
 * NAS의 thumbnail/ 및 video/ 디렉터리를 SFTP로 스캔합니다.
 * 동일한 파일명(확장자 제외)을 가진 thumbnail + video는 한 행으로 병합합니다.
 * NAS가 영구 저장소이므로 서비스 재시작 후에도 목록이 유지됩니다.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const nasHost     = process.env.NAS_SSH_HOST     ?? "192.0.2.20"; // example
  const sshUser     = process.env.NAS_SSH_USER     ?? "ops";
  const sshPassword = process.env.NAS_SSH_PASSWORD ?? "";
  const nasBase     = (customer.nasPath ?? "/rtpulse").replace(/\/$/, "");

  if (!sshPassword) {
    return NextResponse.json({ error: "NAS_SSH_PASSWORD 환경변수가 설정되지 않았습니다." }, { status: 500 });
  }

  // 앞뒤 슬래시 정규화
  const rawSub      = req.nextUrl.searchParams.get("subPath") ?? "";
  const normalizedSub = rawSub.replace(/^\/+/, "").replace(/\/+$/, "");
  const targetDir   = normalizedSub ? `${nasBase}/${normalizedSub}` : nasBase;
  const thumbDir    = `${targetDir}/thumbnail`;
  const videoDir    = `${targetDir}/video`;

  return new Promise<NextResponse>((resolve) => {
    const conn = new SshClient();

    conn.on("ready", () => {
      conn.sftp(async (err, sftp) => {
        if (err) {
          conn.end();
          resolve(NextResponse.json({ error: `SFTP 세션 실패: ${err.message}` }, { status: 502 }));
          return;
        }

        const [thumbFiles, videoFiles] = await Promise.all([
          sftpReaddir(sftp, thumbDir),
          sftpReaddir(sftp, videoDir),
        ]);

        // baseName -> NasEntry 맵 구성
        const entryMap = new Map<string, NasEntry>();

        // 1) video 파일 먼저
        for (const f of videoFiles) {
          if (!/\.(mp4|mov|avi|mkv)$/i.test(f.filename)) continue;
          const base   = f.filename.replace(/\.[^.]+$/, "");
          const parsed = parseBaseName(base);
          entryMap.set(base, {
            baseName:      base,
            ...parsed,
            videoFileName: f.filename,
            videoPath:     `${videoDir}/${f.filename}`,
            videoSize:     f.attrs.size,
            thumbSize:     0,
            hasVideo:      true,
            hasThumb:      false,
          });
        }

        // 2) thumbnail 파일 — video 와 병합 or 단독 추가
        for (const f of thumbFiles) {
          if (!/\.(jpg|jpeg|png|webp)$/i.test(f.filename)) continue;
          const base    = f.filename.replace(/\.[^.]+$/, "");
          const existing = entryMap.get(base);
          if (existing) {
            // 같은 이름의 video가 있으면 병합
            existing.hasThumb      = true;
            existing.thumbFileName = f.filename;
            existing.thumbPath     = `${thumbDir}/${f.filename}`;
            existing.thumbSize     = f.attrs.size;
          } else {
            // thumbnail 단독 (video 없음)
            const parsed = parseBaseName(base);
            entryMap.set(base, {
              baseName:      base,
              ...parsed,
              thumbFileName: f.filename,
              thumbPath:     `${thumbDir}/${f.filename}`,
              thumbSize:     f.attrs.size,
              videoSize:     0,
              hasVideo:      false,
              hasThumb:      true,
            });
          }
        }

        const entries = Array.from(entryMap.values()).sort((a, b) =>
          (b.startTime ?? "").localeCompare(a.startTime ?? "")
        );

        conn.end();
        resolve(NextResponse.json({ entries, targetDir, subPath: normalizedSub }));
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
      readyTimeout: 10_000,
    });
  });
}
