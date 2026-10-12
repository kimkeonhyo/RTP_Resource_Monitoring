/**
 * APO 백엔드 URL 관리 유틸리티
 *
 * 환경변수 APO_BASE_URL 이 설정되어 있어야 합니다.
 * 예: APO_BASE_URL=http://<NAS_IP>:8000
 */

export function getApoBaseUrl(): string {
  const url = process.env.APO_BASE_URL;
  if (!url) {
    throw new Error(
      "APO_BASE_URL 환경변수가 설정되지 않았습니다. " +
        ".env 파일에 APO_BASE_URL=http://<host>:<port> 를 추가하세요."
    );
  }
  return url.replace(/\/$/, ""); // 후행 슬래시 제거
}

/**
 * 워치가 다루는 NAS 경로(/rtpulse/...)를 APO 서버의 로컬 마운트 경로로 변환.
 * APO 서버는 savePath/jsonPath를 로컬 파일시스템으로 해석하는데, 거기선 nas01이
 * `${APO_NAS_MOUNT_PREFIX}/rtpulse`(기본 /mnt/rtpulse)에 마운트돼 있음.
 * 유저는 /rtpulse/... 만 입력하고, APO로 보낼 때 자동으로 접두사를 붙인다.
 */
export function toApoMountPath(p?: string | null): string | undefined {
  if (!p) return p ?? undefined;
  const prefix = (process.env.APO_NAS_MOUNT_PREFIX ?? "/mnt").replace(/\/$/, "");
  if (p.startsWith(`${prefix}/`)) return p;           // 이미 마운트 경로
  if (p === "/rtpulse" || p.startsWith("/rtpulse/")) return `${prefix}${p}`;
  return p;                                           // 그 외 절대경로는 그대로
}

export async function apoFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const base = getApoBaseUrl();
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  return fetch(url, init);
}
