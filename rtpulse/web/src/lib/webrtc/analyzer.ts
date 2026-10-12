// webrtc-internals 덤프 분석 로직.
// 원본: webrtc-lens(web/index.html) 의 parseDump / computeScores 등을 TS 화.

import type {
  AnalysisSummary, Cause, RawDump, RawPeerConnection, RawStatEntry, Risk, StreamRow,
} from "./types";

// ── 작은 유틸 ────────────────────────────────────────────────────────────

function parseValues(raw: RawStatEntry["values"]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw == null)        return [];
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [v];
    } catch { return [raw]; }
  }
  return [raw];
}

function asNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 시리즈의 마지막값 - 첫값 */
function delta(arr: unknown[] | undefined): number | null {
  if (!arr || arr.length < 2) return null;
  const a = asNum(arr[0]);
  const b = asNum(arr[arr.length - 1]);
  if (a == null || b == null) return null;
  return b - a;
}

function last<T>(arr: T[] | undefined): T | null {
  return arr && arr.length ? arr[arr.length - 1] : null;
}

/** "IT01V123-packetsReceived" → ["IT01V123", "packetsReceived"] */
function splitStatKey(key: string): [string, string] {
  const idx = key.lastIndexOf("-");
  if (idx < 0) return [key, ""];
  return [key.slice(0, idx), key.slice(idx + 1)];
}

/** codecId 와 raw stats 를 보고 "H264"/"H265"/"VP9" 등 정규화 */
function resolveCodec(codecId: string, rawStats: Record<string, RawStatEntry>): string {
  if (!codecId) return "";
  const mimeKey = `${codecId}-mimeType`;
  const entry = rawStats[mimeKey];
  if (entry) {
    const vals = parseValues(entry.values);
    if (vals.length) {
      const up = String(vals[vals.length - 1]).toUpperCase();
      const s = up.includes("/") ? (up.split("/").pop() ?? "") : up;
      if (s.includes("HEVC")) return "H265";
      return s;
    }
  }
  const up = String(codecId).toUpperCase();
  for (const c of ["H265", "HEVC", "H264", "VP9", "VP8", "AV1"]) {
    if (up.includes(c)) return c === "HEVC" ? "H265" : c;
  }
  return "";
}

// ── 점수 계산 ────────────────────────────────────────────────────────────

interface ScoreResult { health: number; n: number; d: number; r: number; rec: number; cause: Cause }

function computeScores(row: StreamRow): ScoreResult {
  const loss   = row.lossRatio           ?? 0;
  const jitter = row.jitter              ?? 0;
  const lost   = row.packetsLostDelta    ?? 0;
  const recvF  = row.framesReceivedDelta ?? 0;
  const decF   = row.framesDecodedDelta  ?? 0;
  const dropF  = row.framesDroppedDelta  ?? 0;
  const fps    = row.fps                 ?? 0;
  const freeze = row.freezeDelta         ?? 0;
  const nack   = row.nackDelta           ?? 0;

  // 네트워크 점수
  let n = 100;
  if      (loss >= 0.10) n -= 45;
  else if (loss >= 0.05) n -= 30;
  else if (loss >= 0.02) n -= 15;
  if      (jitter >= 0.05) n -= 30;
  else if (jitter >= 0.03) n -= 18;
  if (lost > 200) n -= 15;
  n = Math.max(0, n);

  // 디코더 점수
  let d = 100;
  const decodeRatio = recvF > 0 ? decF / recvF : 1;
  if      (recvF > 0 && decodeRatio < 0.80) d -= 45;
  else if (recvF > 0 && decodeRatio < 0.90) d -= 25;
  d = Math.max(0, d);

  // 렌더링 점수
  let r = 100;
  if      (dropF > Math.max(20, decF * 0.15)) r -= 45;
  else if (dropF > Math.max(10, decF * 0.08)) r -= 25;
  if      (fps < 10) r -= 30;
  else if (fps < 20) r -= 15;
  if      (freeze >= 100) r -= 45;
  else if (freeze >= 50)  r -= 30;
  else if (freeze >= 20)  r -= 20;
  else if (freeze >= 5)   r -= 10;
  else if (freeze > 0)    r -= 5;
  r = Math.max(0, r);

  // 복구 점수
  let rec = 100;
  if      (nack >= 100) rec -= 35;
  else if (nack >=  30) rec -= 20;
  rec = Math.max(0, rec);

  const health = Math.max(0, Math.min(100, Math.round(n * 0.35 + d * 0.25 + r * 0.25 + rec * 0.15)));

  // 가장 낮은 점수 ≤ 75 면 그것을 원인으로
  const subs: Array<[Cause, number]> = [
    ["네트워크 문제", n],
    ["디코더 병목", d],
    ["렌더링/GPU/CPU 문제", r],
  ];
  subs.sort((a, b) => a[1] - b[1]);
  const cause: Cause = subs[0][1] <= 75 ? subs[0][0] : "복합/기타";

  return { health, n, d, r, rec, cause };
}

// ── 등급 / 위험도 / 원인 설명 ──────────────────────────────────────────

export function grade(score: number): string {
  if (score >= 80) return "양호";
  if (score >= 60) return "주의";
  return "나쁨";
}

export function riskLevel(row: StreamRow): Risk {
  const hs = row.health ?? 100;
  if (hs < 60) return "bad";
  if (hs < 80) return "warn";
  if ((row.freezeDelta ?? 0) >= 20) return "warn";
  if ((row.nackDelta   ?? 0) >= 30) return "warn";
  if ((row.lossRatio   ?? 0) >= 0.02) return "warn";
  return "good";
}

/** 원인을 짧게 요약 ("loss=5.2%, jitter=0.040s" 형태) */
export function explainCause(r: StreamRow): string {
  const parts: string[] = [];
  const loss = r.lossRatio ?? 0;
  if (loss >= 0.03) parts.push(`loss=${(loss * 100).toFixed(1)}%`);
  if ((r.jitter ?? 0) >= 0.03) parts.push(`jitter=${(r.jitter ?? 0).toFixed(3)}s`);
  if ((r.freezeDelta ?? 0) >= 20) parts.push(`freeze=${Math.round(r.freezeDelta ?? 0)}`);
  const recvF = r.framesReceivedDelta ?? 0;
  const decF  = r.framesDecodedDelta  ?? 0;
  if (recvF > 0 && decF < recvF * 0.8) parts.push("decoded ≪ received");
  if ((r.nackDelta ?? 0) >= 30) parts.push(`nack=${Math.round(r.nackDelta ?? 0)}`);
  return parts.join(", ") || "복합 영향";
}

/** 짧은 원인 라벨 (배지용) */
export function shortCause(c: Cause): string {
  if (c === "네트워크 문제")          return "네트워크";
  if (c === "디코더 병목")            return "디코더";
  if (c === "렌더링/GPU/CPU 문제")    return "렌더링/GPU/CPU";
  return "복합/기타";
}

// ── 메인 분석기 ────────────────────────────────────────────────────────

export function analyzeDump(dump: RawDump): AnalysisSummary {
  const pcs = dump.PeerConnections ?? {};
  const rows: StreamRow[] = [];
  let idx = 0;

  for (const [, pc] of Object.entries(pcs) as [string, RawPeerConnection][]) {
    idx += 1;
    const display = `PC${String(idx).padStart(2, "0")}`;
    const stats   = pc.stats ?? {};

    // statsType 별로 그룹화
    const byType: Record<string, Record<string, Record<string, unknown[]>>> = {};
    for (const [k, entry] of Object.entries(stats)) {
      const type = entry.statsType;
      if (!type) continue;
      const [sid, metric] = splitStatKey(k);
      byType[type] ??= {};
      byType[type][sid] ??= {};
      byType[type][sid][metric] = parseValues(entry.values);
    }

    const inbound = byType["inbound-rtp"] ?? {};
    for (const [sid, m] of Object.entries(inbound)) {
      // 비디오 스트림만 (kind=video 또는 비디오 전용 메트릭 보유)
      const kind = String(last(m.kind) ?? "").toLowerCase();
      const isVideo = kind === "video" || !!m.framesPerSecond || !!m.framesDropped;
      if (!isVideo) continue;

      const recvP = delta(m.packetsReceived);
      const lostP = delta(m.packetsLost);
      const lossRatio = (recvP != null && lostP != null && (recvP + lostP) > 0)
        ? lostP / (recvP + lostP)
        : null;
      const codecId = String(last(m.codecId) ?? "");

      const baseRow: StreamRow = {
        peer:   display,
        camera: String(last(m.trackIdentifier) ?? sid),
        codec:  resolveCodec(codecId, stats),

        fps:                  asNum(last(m.framesPerSecond)),
        jitter:               asNum(last(m.jitter)),
        lossRatio,
        packetsLostDelta:     lostP,
        framesReceivedDelta:  delta(m.framesReceived),
        framesDecodedDelta:   delta(m.framesDecoded),
        framesDroppedDelta:   delta(m.framesDropped),
        freezeDelta:          delta(m.freezeCount),
        nackDelta:            delta(m.nackCount),

        // 점수는 아래에서 계산해서 채움
        health: 100, grade: "양호", cause: "복합/기타",
        networkScore: 100, decodeScore: 100, renderScore: 100, recoveryScore: 100,
      };

      const s = computeScores(baseRow);
      baseRow.health        = s.health;
      baseRow.grade         = grade(s.health);
      baseRow.cause         = s.cause;
      baseRow.networkScore  = s.n;
      baseRow.decodeScore   = s.d;
      baseRow.renderScore   = s.r;
      baseRow.recoveryScore = s.rec;
      rows.push(baseRow);
    }
  }

  rows.sort((a, b) => a.health - b.health);

  const avg = rows.length
    ? Math.round(rows.reduce((p, c) => p + c.health, 0) / rows.length)
    : 100;

  const abnormal = rows.filter((r) =>
    r.health < 80 || (r.freezeDelta ?? 0) >= 20 || (r.nackDelta ?? 0) >= 30,
  );

  return { rows, avg, abnormal };
}
