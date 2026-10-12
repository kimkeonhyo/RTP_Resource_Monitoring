// 고객민원(CS) 카테고리 정의 — complain / business / inquiry
// 각 카테고리별로 진행 단계(파이프라인)와 라벨을 다르게 가진다.

export type Category = "complain" | "business" | "inquiry";

export const CATEGORY_KEYS: Category[] = ["complain", "business", "inquiry"];

export interface CategoryConfig {
  key: Category;
  /** 탭/사이드바에 표시할 라벨 */
  label: string;
  /** 진행 단계(칸반 컬럼 순서) */
  statuses: string[];
  /** 통계상 "완료"로 간주하는 단계 */
  doneStatuses: string[];
  /** 제목 필드 라벨 (불만 내용 / 문의 내용) */
  titleLabel: string;
  /** 신규 등록 버튼 라벨 */
  newLabel: string;
  /** 신규 등록 시 기본 상태 */
  defaultStatus: string;
  /** 자동화: 담당자 배정 시 전이할 "처리 중" 상태 */
  inProgressStatus: string;
  /** 자동화: 대화 해결 시 전이할 "완료" 상태 */
  doneStatus: string;
}

export const CATEGORIES: Record<Category, CategoryConfig> = {
  complain: {
    key: "complain",
    label: "고객 불만",
    statuses: ["접수", "현상파악 중", "조치 중", "조치 완료", "평가", "중지", "보류"],
    doneStatuses: ["조치 완료", "평가"],
    titleLabel: "불만 내용",
    newLabel: "새 불만 등록",
    defaultStatus: "접수",
    inProgressStatus: "조치 중",
    doneStatus: "조치 완료",
  },
  business: {
    key: "business",
    label: "사업 문의",
    statuses: ["접수", "요구사항 분석", "PoC", "계약", "완료", "중지", "보류"],
    doneStatuses: ["계약", "완료"],
    titleLabel: "문의 내용",
    newLabel: "새 사업 문의 등록",
    defaultStatus: "접수",
    inProgressStatus: "요구사항 분석",
    doneStatus: "완료",
  },
  inquiry: {
    key: "inquiry",
    label: "종합문의",
    statuses: ["접수", "확인 중", "답변 완료", "보류"],
    doneStatuses: ["답변 완료"],
    titleLabel: "문의 내용",
    newLabel: "새 종합문의 등록",
    defaultStatus: "접수",
    inProgressStatus: "확인 중",
    doneStatus: "답변 완료",
  },
};

export function getCategory(key: string | null | undefined): CategoryConfig {
  if (key && key in CATEGORIES) return CATEGORIES[key as Category];
  return CATEGORIES.complain;
}

export function isValidCategory(key: string | null | undefined): key is Category {
  return !!key && key in CATEGORIES;
}

// ─── 상태별 색상 (배지) ──────────────────────────────────────────────────────
export const STATUS_BADGE: Record<string, string> = {
  "접수":        "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  "현상파악 중":  "bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300",
  "조치 중":     "bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300",
  "조치 완료":   "bg-green-100 text-green-700 dark:bg-green-900/60 dark:text-green-300",
  "평가":        "bg-purple-100 text-purple-700 dark:bg-purple-900/60 dark:text-purple-300",
  "중지":        "bg-red-100 text-red-700 dark:bg-red-900/60 dark:text-red-300",
  "보류":        "bg-orange-100 text-orange-700 dark:bg-orange-900/60 dark:text-orange-300",
  // business / inquiry 전용 단계
  "요구사항 분석": "bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300",
  "PoC":         "bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300",
  "계약":        "bg-teal-100 text-teal-700 dark:bg-teal-900/60 dark:text-teal-300",
  "완료":        "bg-green-100 text-green-700 dark:bg-green-900/60 dark:text-green-300",
  "확인 중":     "bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300",
  "답변 완료":   "bg-green-100 text-green-700 dark:bg-green-900/60 dark:text-green-300",
};

export function statusBadgeClass(status: string): string {
  return STATUS_BADGE[status] ?? "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300";
}

// ─── 칸반 컬럼 헤더 강조 색 (상단 보더) ───────────────────────────────────────
export const STATUS_ACCENT: Record<string, string> = {
  "접수":        "border-t-gray-400",
  "현상파악 중":  "border-t-blue-500",
  "조치 중":     "border-t-amber-500",
  "조치 완료":   "border-t-green-500",
  "평가":        "border-t-purple-500",
  "중지":        "border-t-red-500",
  "보류":        "border-t-orange-500",
  "요구사항 분석": "border-t-blue-500",
  "PoC":         "border-t-amber-500",
  "계약":        "border-t-teal-500",
  "완료":        "border-t-green-500",
  "확인 중":     "border-t-blue-500",
  "답변 완료":   "border-t-green-500",
};

export function statusAccentClass(status: string): string {
  return STATUS_ACCENT[status] ?? "border-t-gray-400";
}

// ─── 우선순위(Priority) ────────────────────────────────────────────────────────
// QA 이슈 조치기간 기준: Urgent(즉시) / High(7일) / Medium(14일) / Low(협의)

export type Priority = "urgent" | "high" | "medium" | "low";

export const PRIORITIES: Priority[] = ["urgent", "high", "medium", "low"];

export const DEFAULT_PRIORITY: Priority = "medium";

export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: "Urgent",
  high:   "High",
  medium: "Medium",
  low:    "Low",
};

/** 우선순위별 조치기간 안내 (툴팁 등에 사용) */
export const PRIORITY_SLA: Record<Priority, string> = {
  urgent: "즉시 조치",
  high:   "접수 후 7일 내",
  medium: "접수 후 14일 내",
  low:    "고객협의 후 일정 조율",
};

export function isValidPriority(key: string | null | undefined): key is Priority {
  return !!key && (PRIORITIES as string[]).includes(key);
}

export const PRIORITY_BADGE: Record<Priority, string> = {
  urgent: "bg-red-100 text-red-700 dark:bg-red-900/60 dark:text-red-300",
  high:   "bg-orange-100 text-orange-700 dark:bg-orange-900/60 dark:text-orange-300",
  medium: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300",
  low:    "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
};

export function priorityBadgeClass(priority: string): string {
  return PRIORITY_BADGE[priority as Priority] ?? PRIORITY_BADGE.low;
}
