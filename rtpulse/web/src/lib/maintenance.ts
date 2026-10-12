/**
 * 유지보수(정기 점검) 도메인 공통 정의.
 *
 * 점검 단계(파이프라인)와 점검주기, 다음 일정 자동 계산 규칙을 중앙화한다.
 *
 * 시행 기준(가이드):
 *   안정화   | 2주   | 설치 완료 후 2회
 *   월간 점검 | 1개월 | 안정화 완료 후 3개월(3회)
 *   반기 점검 | 6개월 | 월간 점검 후 1년(2회)
 *   연간 점검 | 1년   | 반기 점검 완료 후
 */
import { addDays, addMonths, addYears } from "date-fns";

/** 제품명 선택지 */
export const PRODUCT_OPTIONS = ["VMS", "EDGE", "신규"] as const;

export type Cycle = "2주" | "1개월" | "6개월" | "1년" | "없음";

// "없음" = 반복 주기 없음(1회성). 다음 예정일을 자동 계산하지 않고 사용자가 직접 입력한다.
export const CYCLES: Cycle[] = ["2주", "1개월", "6개월", "1년", "없음"];

/** 점검명 (초기점검 = 설치 직후 기준점). "기타"는 선택 시 직접 입력한다. */
export const INSPECTION_NAMES = [
  "초기점검",
  "안정화",
  "월간 점검",
  "반기 점검",
  "연간 점검",
  "업데이트",
  "기타",
] as const;
export type InspectionName = (typeof INSPECTION_NAMES)[number];

/** "기타" = 사용자가 점검명을 직접 입력하는 특수 항목 */
export const CUSTOM_INSPECTION_NAME = "기타";

/** 점검명 → 기본 점검주기 (등록 시 기본값, 사용자가 변경 가능) */
export const DEFAULT_CYCLE: Record<string, Cycle> = {
  "초기점검":  "2주",
  "안정화":    "2주",
  "월간 점검": "1개월",
  "반기 점검": "6개월",
  "연간 점검": "1년",
  "업데이트":  "없음",   // 업데이트/기타는 1회성 기본
  "기타":      "없음",
};

/**
 * 점검명 → 권장 "다음 점검명" (시행 기준 progression).
 * 결과 등록 시 다음 점검명/주기 선택의 기본값으로 제시한다.
 */
export const NEXT_DEFAULT: Record<string, InspectionName> = {
  "초기점검":  "안정화",
  "안정화":    "월간 점검",
  "월간 점검": "반기 점검",
  "반기 점검": "연간 점검",
  "연간 점검": "연간 점검",
};

/** 기준일에 점검주기를 더해 다음 점검 예정일(YYYY-MM-DD)을 계산한다.
 *  타임존 영향을 받지 않도록 로컬 정오 기준으로 더하고 로컬 날짜 컴포넌트로 포맷한다.
 *  (toISOString는 UTC로 변환되어 KST 등에서 하루 밀리는 문제가 있음) */
export function nextDate(baseDate: string, cycle: Cycle): string {
  // "없음"(1회성)은 자동 계산 대상이 아님 — 호출측에서 직접 입력한 날짜를 사용한다.
  if (cycle === "없음") return "";
  const day = String(baseDate).slice(0, 10);
  const d = new Date(`${day}T12:00:00`); // 로컬 정오 — DST/UTC 경계 회피
  const out =
    cycle === "2주"   ? addDays(d, 14)   :
    cycle === "1개월" ? addMonths(d, 1)  :
    cycle === "6개월" ? addMonths(d, 6)  :
                         addYears(d, 1);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${out.getFullYear()}-${p(out.getMonth() + 1)}-${p(out.getDate())}`;
}

export type InspectionStatus = "예정" | "완료" | "취소";

/** 서버/워크스테이션 사양 — 항목(제품/유닛)별 1행 (IMS 납품 품목 형식) */
export interface SpecRow {
  name:   string;                  // 제품명
  serial: string;                  // S/N
  tags:   Record<string, string>;  // CPU/RAM/Storage/GPU/OS/모델명 등
}

// ─── 점검 체크리스트 (Notion 원격/방문 Check Sheet 기반) ───────────────────────

/** 검사 방식: 원격 / 방문 */
export type InspectType = "remote" | "visit";
export const INSPECT_TYPES: { key: InspectType; label: string }[] = [
  { key: "remote", label: "원격 검사" },
  { key: "visit",  label: "방문 검사" },
];

/** 검사결과 (Notion select: N/A / Pass / Fail) */
export const CHECK_RESULTS = ["N/A", "Pass", "Fail"] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number] | "";

/** 체크리스트 1행 — 유형/점검항목/검사방법/검사결과/조치결과/비고 */
export interface CheckItem {
  type:   string;       // 유형 (watch/VMS/AI품질/VOS/VOC/cable/HW/Secrets)
  item:   string;       // 점검항목
  method: string;       // 검사방법 (기준 설명)
  result: CheckResult;  // 검사결과
  action: string;       // 조치결과
  note:   string;       // 비고
}

const ck = (type: string, item: string, method: string): CheckItem =>
  ({ type, item, method, result: "", action: "", note: "" });

/**
 * VMS 기본 점검 체크리스트 (원격·방문 공통).
 * 담당자 점검표(VMS_점검표.xlsx) 기준. 탐지현황 통계·고객 민원은 2-3/2-4로 분리.
 * (정탐/오탐 집계는 2-3 탐지현황 통계와 중복되어 체크리스트에서 제외 — DB 적재만 확인)
 */
export const VMS_CHECKLIST: CheckItem[] = [
  // 1. HW 및 서버 상태
  ck("HW", "디스크 사용량 및 여유 공간", "디스크 과다 사용 여부"),
  ck("HW", "CPU 사용률", "비정상적인 고사용률 지속 여부"),
  ck("HW", "메모리 사용량", "메모리 부족·스왑 과다 여부"),
  ck("HW", "GPU 사용량", "GPU 사용률·메모리 사용량 이상 여부"),
  ck("HW", "GPU 온도", "고온 지속 여부"),
  ck("HW", "GPU 팬 상태", "팬 회전 및 이상 여부"),
  // 2. Kubernetes 서비스 상태
  ck("vms-api", "Pod 상태 및 최근 로그", "전체 Pod Ready 및 오류 로그 유무"),
  ck("vms-inference", "Pod 상태·모델 로딩·추론 로그", "전체 Pod Ready 및 모델/추론 오류 유무"),
  // 3. 웹 화면 · DB 적재 (정탐/오탐 집계는 2-3 탐지현황 통계로 분리)
  ck("웹 화면", "전체 카메라 수", "사이트 등록 카메라 수 확인"),
  ck("웹 화면", "카메라 영상 정상 출력 여부", "영상 끊김·지연·검은 화면 여부"),
  ck("DB", "이벤트 DB 적재 상태", "탐지 이벤트가 Maria DB에 정상 적재되었는지 확인"),
];

/** 방문검사 전용 추가 항목 — 현장 물리 점검 (원격에는 없음). 방문검사 Check list(Notion) 기준. */
export const VISIT_ONLY_CHECKLIST: CheckItem[] = [
  ck("HW", "물리보안 시건장치", "물리보안 시건장치가 모든 포트에 시건되어 있어야 한다."),
  ck("HW", "서버 위치 및 상태 확인", "서버가 납품한 위치에 잘 있는지, 외관 상 문제가 없어야 한다."),
  ck("HW", "케이블 상태 확인", "랜/파워 케이블이 절단·파손되거나 파손 위기 상태가 아니어야 한다."),
];

/** 원격검사 = VMS 공통 점검. */
export const REMOTE_CHECKLIST: CheckItem[] = VMS_CHECKLIST;
/** 방문검사 = VMS 공통 점검 + 현장 물리 점검(방문 전용). */
export const VISIT_CHECKLIST: CheckItem[] = [...VMS_CHECKLIST, ...VISIT_ONLY_CHECKLIST];

export function defaultChecklist(type: InspectType): CheckItem[] {
  // 새 객체로 복제(참조 공유 방지)
  return (type === "visit" ? VISIT_CHECKLIST : REMOTE_CHECKLIST).map((c) => ({ ...c }));
}

// ─── 2-3 탐지현황 통계 (사용자 편집형 표) ──────────────────────────────────────

export interface StatsTable {
  columns: string[];    // 표 헤더 (사용자가 추가/수정)
  rows:    string[][];  // 각 행 = 컬럼 수 만큼의 셀
}

export function emptyStats(): StatsTable {
  return { columns: ["카메라", "이벤트", "기간", "탐지 건수", "비고"], rows: [] };
}

// ─── 2-3 탐지현황 통계 (이벤트 × TP/FP × 날짜 매트릭스) ─────────────────────────
// 이벤트명 | 탐지결과(TP/FP) | 날짜열… | Total  형식.

export interface DetectionEventRow {
  name: string;               // 이벤트명 (쓰러짐/연기/화재 …)
  tp: (number | null)[];      // 날짜별 TP (null = 미입력/"-")
  fp: (number | null)[];      // 날짜별 FP
}

/** 기간 단위 — 일/주/월 (달력 입력 타입 분기용) */
export type DetectionUnit = "day" | "week" | "month";
export const DETECTION_UNITS: { key: DetectionUnit; label: string }[] = [
  { key: "day",   label: "일별" },
  { key: "week",  label: "주별" },
  { key: "month", label: "월별" },
];

export interface DetectionStats {
  unit:   DetectionUnit;       // 날짜 열 단위 (일/주/월)
  dates:  string[];            // 열 값 — day: "2026-07-05", week: "2026-W27", month: "2026-07"
  events: DetectionEventRow[];
}

export function emptyDetectionStats(): DetectionStats {
  return {
    unit: "day",
    dates: [],
    events: [
      { name: "쓰러짐", tp: [], fp: [] },
      { name: "연기",   tp: [], fp: [] },
      { name: "화재",   tp: [], fp: [] },
    ],
  };
}

/** 저장된 데이터의 tp/fp 길이를 dates 길이에 맞춰 정규화(누락은 null 패딩). */
export function normalizeDetectionStats(d: Partial<DetectionStats> | undefined): DetectionStats {
  if (!d || !Array.isArray(d.dates)) return emptyDetectionStats();
  const n = d.dates.length;
  const pad = (a: (number | null)[] | undefined) => {
    const arr = Array.isArray(a) ? a.slice(0, n) : [];
    while (arr.length < n) arr.push(null);
    return arr;
  };
  const unit: DetectionUnit = d.unit === "week" || d.unit === "month" ? d.unit : "day";
  return {
    unit,
    dates: d.dates.map((x) => String(x ?? "")),
    events: (d.events ?? []).map((e) => ({ name: e?.name ?? "", tp: pad(e?.tp), fp: pad(e?.fp) })),
  };
}

/** 열 값(원본)을 단위별 짧은 표시로 변환. day: 7/5, week: 26-W27, month: 26/07 */
export function formatDetectionDate(value: string, unit: DetectionUnit): string {
  if (!value) return "-";
  if (unit === "day") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return m ? `${Number(m[2])}/${Number(m[3])}` : value;
  }
  if (unit === "week") {
    const m = /^(\d{4})-W(\d{2})$/.exec(value);
    return m ? `${m[1].slice(2)}-W${m[2]}` : value;
  }
  // month
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  return m ? `${m[1].slice(2)}/${m[2]}` : value;
}

/** 방문검사 이벤트 통계 쿼리 예시 (참조용 — 실제 환경에 맞게 조정) */
export const EVENT_STATS_QUERY_EXAMPLE = `-- 주별 이벤트 탐지 건수 (안정화 & 월간 점검)
SELECT DATE_FORMAT(event_time, '%x-W%v') AS week,
       camera_id, event_name, COUNT(*) AS cnt
FROM   events
WHERE  event_time >= '이전_점검일'
GROUP  BY week, camera_id, event_name
ORDER  BY week, camera_id;

-- 월별 이벤트 탐지 건수 (반기 & 연간 점검)
SELECT DATE_FORMAT(event_time, '%Y-%m') AS month,
       camera_id, event_name, COUNT(*) AS cnt
FROM   events
WHERE  event_time >= '이전_점검일'
GROUP  BY month, camera_id, event_name
ORDER  BY month, camera_id;`;

// ─── VMS 이미지 버전 (제품명 VMS일 때, IMS 서비스 납품정보와 동일 형식) ──────

export interface ImageVersion {
  image_name: string;  // 이미지명 (event, camera, api-gateway, auth, frontend, decoder, inference, es-gateway …)
  version:    string;  // 버전 (vms-be-event-v26.03.20 …)
}

/** shipment_service_images가 없을 때 프리필용 기본 VMS 이미지 목록 */
export const DEFAULT_VMS_IMAGES = [
  "event", "camera", "api-gateway", "auth", "frontend", "decoder", "inference", "es-gateway",
];

/** 상세 점검 리포트(2번 정기 점검 결과 + 3번 후속 계획) 구조 */
export interface InspectionReport {
  env: {
    install_date:    string;      // 최초 설치 일
    inspect_date:    string;      // 점검 일
    product_name:    string;      // 제품명
    product_version: string;      // 제품버전
    inspect_type?:   InspectType; // 검사 방식 (원격/방문)
  };
  specs:      SpecRow[];    // 서버/워크스테이션 사양 (항목별 표)
  checklist?: CheckItem[];  // 2-2 점검 내용 (체크리스트)
  stats?:     StatsTable;   // (레거시) 2-3 자유 표
  detectionStats?: DetectionStats; // 2-3 탐지현황 통계 (이벤트×TP/FP×날짜)
  complaints?: string;      // 2-4 고객민원 및 특이사항
  deploy_mode?:    string;  // 배포 방식 (BUNDLE/MANUAL) — 제품명 VMS
  bundle_version?: string;  // 번들 버전 (배포방식 BUNDLE)
  images?:    ImageVersion[]; // VMS 이미지 버전 (배포방식 MANUAL)
  contents:   string;       // (레거시) 2-2 점검 내용 자유서술
  results:    string;       // (레거시) 2-3 점검 결과 자유서술
  followups:  { date: string; content: string; note: string }[]; // 3 후속 점검 계획
}

export function emptyReport(): InspectionReport {
  return {
    env: { install_date: "", inspect_date: "", product_name: "", product_version: "", inspect_type: "remote" },
    specs: [],
    checklist: defaultChecklist("remote"),
    stats: emptyStats(),
    detectionStats: emptyDetectionStats(),
    complaints: "",
    images: [],
    contents: "",
    results: "",
    followups: [],
  };
}

export interface Inspection {
  id:              number;
  customer_name:   string;
  shipment_id:     string | null;
  inspection_name: string;
  cycle:           string | null;
  scheduled_date:  string;          // YYYY-MM-DD
  completed_date:  string | null;
  status:          InspectionStatus;
  inspector:       string;
  purpose:         string;
  report:          InspectionReport;
  next_id:         number | null;
  created_at:      string;
  updated_at:      string;
}
