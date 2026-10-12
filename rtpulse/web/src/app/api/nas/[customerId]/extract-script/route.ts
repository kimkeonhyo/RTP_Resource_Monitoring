import { NextRequest, NextResponse } from "next/server";
import { getCustomer } from "@/lib/customers";

type Params = { params: Promise<{ customerId: string }> };

/**
 * GET /api/nas/{customerId}/extract-script?from=2026-04-01&to=2026-04-30
 *
 * VIP의 MinIO에서 데이터를 추출하는 shell script를 생성해 다운로드합니다.
 * MinIO client(mc)를 이용해 thumbnail + video 버킷에서 날짜 범위 데이터를 추출합니다.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return new NextResponse("Not found", { status: 404 });

  const from = req.nextUrl.searchParams.get("from") ?? "";
  const to   = req.nextUrl.searchParams.get("to")   ?? "";

  const vip     = customer.vip ?? customer.ip ?? "VIP_IP";
  const dbUser  = customer.dbUser  ?? "ops";
  const dbPass  = customer.dbPassword ?? "PASSWORD";
  const dbPort  = customer.dbPort  ?? 3306;
  const dbName  = customer.dbName  ?? "";
  // MinIO(VMS) 자격증명 — DB 계정과 별개. Watch가 실제 접속에 쓰는 env 값을 주입.
  const minioUser   = process.env.MINIO_ACCESS_KEY ?? "MINIO_ACCESS_KEY";
  const minioSecret = process.env.MINIO_SECRET_KEY ?? "MINIO_SECRET_KEY";
  const outDir  = `./data_${customer.name.replace(/\s/g, "_")}`;
  // mc alias 이름 — 로컬에서 여러 고객사 스크립트를 돌려도 충돌하지 않도록 유일화.
  // 한글 고객명은 alias 부적합, UUID 전체는 너무 길어 고객ID 앞 8자리 사용 (예: minio_68bc50ea)
  const alias   = `minio_${customerId.slice(0, 8)}`;

  // 날짜 범위 -> YYYYMMDD 형식 리스트 (최대 31일)
  let dateLines = "";
  if (from && to) {
    const start = new Date(from);
    const end   = new Date(to);
    const dates: string[] = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
    }
    dateLines = dates.map((yyyymmdd) => `
# --- ${yyyymmdd} ---
mc cp --recursive ${alias}/thumbnail/${yyyymmdd}/ "${outDir}/thumbnail/${yyyymmdd}/" 2>/dev/null || true
mc cp --recursive ${alias}/video/${yyyymmdd}/     "${outDir}/video/${yyyymmdd}/"     2>/dev/null || true`).join("\n");
  } else {
    dateLines = `
# 전체 데이터 다운로드 (날짜 범위 미지정)
mc cp --recursive ${alias}/thumbnail/ "${outDir}/thumbnail/" 2>/dev/null || true
mc cp --recursive ${alias}/video/     "${outDir}/video/"     2>/dev/null || true`;
  }

  const script = `#!/bin/bash
# RTPulse Data Extract Script
# 고객사: ${customer.name}
# VIP: ${vip}
# 생성일: ${new Date().toISOString().slice(0, 10)}
${from && to ? `# 조회 범위: ${from} ~ ${to}` : "# 조회 범위: 전체"}
#
# 사전 준비:
#   1. MinIO client 설치: https://min.io/docs/minio/linux/reference/minio-mc.html
#      curl https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc && chmod +x /usr/local/bin/mc
#   2. ffmpeg 설치 (m3u8 → mp4 변환에 필요)
#      - macOS:  brew install ffmpeg
#      - Ubuntu: sudo apt install ffmpeg
#   3. MinIO 계정이 없는 경우 아래 ACCESS_KEY / SECRET_KEY 를 실제 값으로 교체하세요.

set -e

VIP="${vip}"
# MinIO(VMS) 접속 — DB 계정과 다릅니다
ACCESS_KEY="${minioUser}"
SECRET_KEY="${minioSecret}"
DB_HOST="${vip}"
DB_PORT="${dbPort}"
DB_USER="${dbUser}"
DB_PASS="${dbPass}"
DB_NAME="${dbName}"
OUT_DIR="${outDir}"

# ── 1. MinIO에서 데이터 다운로드 ─────────────────────────────────────────────

echo "[RTPulse] MinIO alias 설정 중... (http://\${VIP}:9000)"
mc alias set ${alias} "http://\${VIP}:9000" "\${ACCESS_KEY}" "\${SECRET_KEY}"

echo "[RTPulse] 출력 디렉토리 생성: \${OUT_DIR}"
mkdir -p "\${OUT_DIR}/thumbnail"
mkdir -p "\${OUT_DIR}/video"
${dateLines}

# ── 2. DB에서 video_url → 파일명 매핑 조회 ──────────────────────────────────
# bash 3 호환 (macOS 기본 셸): declare -A 대신 임시 파일 + awk 사용

echo ""
echo "[RTPulse] DB에서 이벤트 메타데이터 조회 중..."

MAPPING_FILE="\$(mktemp)"
trap 'rm -f "\$MAPPING_FILE"' EXIT

if ! command -v mysql &>/dev/null; then
  echo "  ⚠ mysql 클라이언트가 없어 UUID 파일명으로 저장됩니다."
  echo "    설치: brew install mysql-client  또는  sudo apt install mysql-client"
else
  # video_url이 .mp4인 경우도 포함 (LIKE '%.m3u8' 제거)
  mysql -h "\${DB_HOST}" -P "\${DB_PORT}" -u "\${DB_USER}" -p"\${DB_PASS}" \\
        "\${DB_NAME}" --batch --skip-column-names 2>/dev/null <<ENDSQL > "\${MAPPING_FILE}" || true
SELECT SUBSTRING_INDEX(video_url, '/', -1),
       camera_id,
       event_name,
       DATE_FORMAT(start_time, '%Y%m%d_%H%i%S')
FROM camera_events
WHERE video_url IS NOT NULL AND video_url != ''
${from && to ? `AND start_time BETWEEN '${from}' AND '${to} 23:59:59'` : ""}
ENDSQL

  COUNT=\$(wc -l < "\${MAPPING_FILE}" | tr -d ' ')
  echo "  ✓ \${COUNT}개 이벤트 매핑 완료"
fi

# awk 헬퍼: UUID 파일명 → {cam}_{evt}_{ts} (없으면 빈 문자열)
lookup_name() {
  local uuid_file="\$1"
  awk -F'\\t' -v key="\$uuid_file" '$1 == key { print $2"_"$3"_"$4; exit }' "\${MAPPING_FILE}"
}

# ── 3. 다운로드된 mp4 파일명 변경 ────────────────────────────────────────────
# MinIO에서 직접 받은 UUID.mp4 → {cam}_{event}_{ts}.mp4

echo ""
echo "[RTPulse] mp4 파일명 변경 중..."

RENAMED=0
while IFS= read -r mp4file; do
  uuid_file="\$(basename "\$mp4file")"
  mapped="\$(lookup_name "\$uuid_file")"
  if [ -n "\$mapped" ]; then
    new_path="\$(dirname "\$mp4file")/\${mapped}.mp4"
    if [ "\$mp4file" != "\$new_path" ]; then
      mv "\$mp4file" "\$new_path"
      echo "  ✓ \$uuid_file → \${mapped}.mp4"
      RENAMED=\$((RENAMED + 1))
    fi
  else
    echo "  - \$uuid_file (DB 매핑 없음, 그대로 유지)"
  fi
done < <(find "\${OUT_DIR}/video" -name "*.mp4" 2>/dev/null)

echo "  파일명 변경 완료: \${RENAMED}개"

# ── 4. m3u8 → mp4 변환 ───────────────────────────────────────────────────────

echo ""
echo "[RTPulse] m3u8 → mp4 변환 시작..."

if ! command -v ffmpeg &>/dev/null; then
  echo "  ⚠ ffmpeg를 찾을 수 없습니다. 변환을 건너뜁니다."
  echo "    설치 방법: brew install ffmpeg  또는  sudo apt install ffmpeg"
else
  CONVERTED=0
  FAILED=0

  while IFS= read -r m3u8; do
    dir="\$(dirname "\$m3u8")"
    uuid_file="\$(basename "\$m3u8")"

    mapped="\$(lookup_name "\$uuid_file")"
    if [ -n "\$mapped" ]; then
      out_name="\${mapped}.mp4"
    else
      out_name="\${uuid_file%.m3u8}.mp4"
    fi

    mp4="\${OUT_DIR}/video/\${out_name}"
    echo "  변환: \$uuid_file → \$out_name"

    if ffmpeg -y \\
        -allowed_extensions ALL \\
        -protocol_whitelist file,crypto,data,fd \\
        -i "\$m3u8" \\
        -c copy \\
        "\$mp4" 2>/dev/null; then
      echo "    ✓ 완료"
      CONVERTED=\$((CONVERTED + 1))
      rm -f "\$m3u8"
      find "\$dir" -name "*.ts" -delete 2>/dev/null || true
      rmdir "\$dir" 2>/dev/null || true
    else
      echo "    ✗ 실패 (원본 m3u8 유지)"
      FAILED=\$((FAILED + 1))
    fi
  done < <(find "\${OUT_DIR}/video" -name "*.m3u8" 2>/dev/null)

  echo ""
  echo "  변환 결과: 성공 \${CONVERTED}개 / 실패 \${FAILED}개"
fi

# ── 5. UUID 원본 파일 삭제 ───────────────────────────────────────────────────
# rename/변환 후 남은 UUID.mp4, UUID.m3u8, .ts 파일 정리

echo ""
echo "[RTPulse] UUID 원본 파일 정리 중..."

DELETED=0

# UUID 패턴: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (8-4-4-4-12 hex)
UUID_PATTERN='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

# UUID.mp4 삭제 (rename 안 된 파일)
while IFS= read -r f; do
  base="\$(basename "\$f" .mp4)"
  if echo "\$base" | grep -qE "\$UUID_PATTERN"; then
    rm -f "\$f"
    echo "  삭제: \$(basename "\$f")"
    DELETED=\$((DELETED + 1))
  fi
done < <(find "\${OUT_DIR}/video" -name "*.mp4" 2>/dev/null)

# UUID.m3u8 + .ts 삭제 (변환 실패 파일)
while IFS= read -r f; do
  rm -f "\$f"
  echo "  삭제: \$(basename "\$f")"
  DELETED=\$((DELETED + 1))
done < <(find "\${OUT_DIR}/video" \\( -name "*.m3u8" -o -name "*.ts" \\) 2>/dev/null)

# 빈 디렉토리 정리
find "\${OUT_DIR}/video" -type d -empty -delete 2>/dev/null || true

echo "  총 \${DELETED}개 파일 삭제 완료"

# ── 6. 완료 ─────────────────────────────────────────────────────────────────

echo ""
echo "[RTPulse] 추출 완료!"
echo "  저장 위치: \$(realpath \${OUT_DIR})"
echo ""
echo "다음 단계: RTPulse UI에서 [NAS 업로드] 버튼을 클릭해 추출된 데이터를 NAS에 업로드하세요."
`;

  const fileName = `extract_${customer.name.replace(/[^a-zA-Z0-9가-힣]/g, "_")}${from ? `_${from}` : ""}.sh`;

  return new NextResponse(script, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
    },
  });
}
