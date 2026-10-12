// webrtc-internals 덤프 분석 결과 타입

export type Risk  = "good" | "warn" | "bad";
export type Cause = "네트워크 문제" | "디코더 병목" | "렌더링/GPU/CPU 문제" | "복합/기타";

/** 단일 inbound-rtp video 스트림에서 추출한 분석 결과 */
export interface StreamRow {
  peer:   string;       // "PC01" 형태
  camera: string;       // trackIdentifier 또는 stream id
  codec:  string;       // "H264" / "H265" / "VP9" 등

  fps:                  number | null;
  jitter:               number | null;   // 초
  lossRatio:            number | null;   // 0.0 ~ 1.0
  packetsLostDelta:     number | null;
  framesReceivedDelta:  number | null;
  framesDecodedDelta:   number | null;
  framesDroppedDelta:   number | null;
  freezeDelta:          number | null;
  nackDelta:            number | null;

  health: number;       // 0~100
  grade:  string;       // 양호/주의/나쁨
  cause:  Cause;

  // 4개 부문 점수 (각 0~100) — 차트/레이더용
  networkScore:   number;
  decodeScore:    number;
  renderScore:    number;
  recoveryScore:  number;
}

/** 분석 함수 최종 산출물 */
export interface AnalysisSummary {
  rows:     StreamRow[];     // 전체 스트림 (health 낮은 순 정렬)
  avg:      number;          // 평균 health 점수
  abnormal: StreamRow[];     // 주의/문제 있는 스트림 부분집합
}

/** 원본 webrtc-internals 덤프 최상위 구조 (단순화) */
export interface RawDump {
  PeerConnections?: Record<string, RawPeerConnection>;
  UserAgent?:       string;
  [k: string]: unknown;
}

export interface RawPeerConnection {
  url?:       string;
  updateLog?: Array<{ type: string; value: unknown }>;
  stats?:     Record<string, RawStatEntry>;
}

export interface RawStatEntry {
  statsType?: string;            // "inbound-rtp" | "candidate-pair" | "codec" | ...
  values?:    string | unknown[]; // JSON 문자열 또는 배열
}
