"use client";

import { useState, useMemo } from "react";
import type { AnalysisSummary, Cause, Risk, StreamRow } from "@/lib/webrtc/types";
import { explainCause, riskLevel, shortCause } from "@/lib/webrtc/analyzer";
import Charts from "./charts";

// ── 색상 매핑 ────────────────────────────────────────────────────────────

function badgeRisk(risk: Risk): string {
  if (risk === "bad")  return "bg-rose-900/40 text-rose-300 border-rose-700/50";
  if (risk === "warn") return "bg-amber-900/40 text-amber-300 border-amber-700/50";
  return "bg-emerald-900/40 text-emerald-300 border-emerald-700/50";
}

function badgeCause(c: Cause): string {
  if (c === "네트워크 문제")        return "bg-cyan-900/40 text-cyan-300 border-cyan-700/50";
  if (c === "디코더 병목")          return "bg-purple-900/40 text-purple-300 border-purple-700/50";
  if (c === "렌더링/GPU/CPU 문제")   return "bg-orange-900/40 text-orange-300 border-orange-700/50";
  return "bg-gray-700/40 text-gray-300 border-gray-600/50";
}

function levelHealth(v: number | null): string {
  if (v == null)  return "text-gray-500";
  if (v < 60)     return "text-rose-400";
  if (v < 80)     return "text-amber-300";
  return "text-emerald-300";
}
function levelLoss(v: number | null): string {
  if (v == null)   return "text-gray-500";
  if (v >= 0.05)   return "text-rose-400";
  if (v >= 0.02)   return "text-amber-300";
  return "text-emerald-300";
}
function levelFps(v: number | null): string {
  if (v == null)   return "text-gray-500";
  if (v < 10)      return "text-rose-400";
  if (v < 20)      return "text-amber-300";
  return "text-emerald-300";
}
function levelJitter(v: number | null): string {
  if (v == null)    return "text-gray-500";
  if (v >= 0.05)    return "text-rose-400";
  if (v >= 0.03)    return "text-amber-300";
  return "text-emerald-300";
}
function levelFreeze(v: number): string {
  if (v >= 50) return "text-rose-400";
  if (v >= 20) return "text-amber-300";
  return v > 0 ? "text-gray-300" : "text-gray-600";
}
function levelNack(v: number): string {
  if (v >= 100) return "text-rose-400";
  if (v >= 30)  return "text-amber-300";
  return v > 0 ? "text-gray-300" : "text-gray-600";
}

function fmtPct(v: number | null): string { return v == null ? "n/a" : `${(v * 100).toFixed(1)}%`; }
function fmtSec(v: number | null): string { return v == null ? "n/a" : `${v.toFixed(3)}s`; }
function fmtFps(v: number | null): string { return v == null ? "n/a" : v.toFixed(1); }
function rnd(v: number | null): number    { return Math.round(v ?? 0); }

// ── 셀 값별 동적 설명 (native title 속성으로) ────────────────────────

function tipLoss(v: number | null): string {
  if (v == null) return "패킷 손실율: 데이터 없음";
  const pct = (v * 100).toFixed(2);
  if (v >= 0.05) return `패킷 손실율 ${pct}% — 5% 이상 비정상 (네트워크 점검 필요)`;
  if (v >= 0.02) return `패킷 손실율 ${pct}% — 2~5% 주의`;
  return `패킷 손실율 ${pct}% — 정상 (2% 미만)`;
}
function tipFps(v: number | null): string {
  if (v == null) return "FPS: 데이터 없음";
  if (v < 10)    return `${v.toFixed(1)} FPS — 10 미만 비정상 (영상 뚝뚝 끊김)`;
  if (v < 20)    return `${v.toFixed(1)} FPS — 10~19 주의`;
  return `${v.toFixed(1)} FPS — 정상 (20 이상)`;
}
function tipJitter(v: number | null): string {
  if (v == null) return "Jitter: 데이터 없음";
  const s = v.toFixed(3);
  if (v >= 0.05) return `${s}s — 0.05s 이상 비정상`;
  if (v >= 0.03) return `${s}s — 0.03~0.05s 주의`;
  return `${s}s — 정상 (0.03s 미만)`;
}
function tipFreeze(v: number): string {
  if (v >= 50) return `Freeze ${v}회 — 50+ 심각 (사용자 체감 큼)`;
  if (v >= 20) return `Freeze ${v}회 — 20+ 주의`;
  if (v >= 5)  return `Freeze ${v}회 — 경미`;
  if (v > 0)   return `Freeze ${v}회 — 미미`;
  return "Freeze 없음";
}
function tipNack(v: number): string {
  if (v >= 100) return `NACK ${v}회 — 100+ 비정상 (네트워크 손실 잦음)`;
  if (v >= 30)  return `NACK ${v}회 — 30+ 주의`;
  return `NACK ${v}회 — 정상 범위`;
}
function tipHealth(v: number, grade: string): string {
  return `Health ${v}점 (${grade}) — 80+ 양호 / 60~79 주의 / 60 미만 나쁨`;
}
function tipFrames(received: number, decoded: number, dropped: number): string {
  const ratio = received > 0 ? ((decoded / received) * 100).toFixed(1) : "—";
  return `Recv ${received} / Decoded ${decoded} / Dropped ${dropped}\n디코딩 성공률: ${ratio}%`;
}

// ── 컬럼 헤더용 커스텀 툴팁 (설명 + 임계치) ────────────────────────────

const HEADER_TIPS: Record<string, { desc: string; thresholds?: string }> = {
  위험:     { desc: "Health + Freeze/NACK/Loss 종합 위험도", thresholds: "양호 / 주의 / 높음" },
  Health:   { desc: "스트림 종합 품질 점수 (0~100)",         thresholds: "80+ 양호 / 60~79 주의 / 60 미만 나쁨" },
  원인:     { desc: "가장 취약한 부문 (75점 이하 시 표시)",     thresholds: "네트워크 / 디코더 / 렌더링 / 복합" },
  카메라:   { desc: "track identifier (또는 stream id) 앞부분" },
  Peer:     { desc: "PeerConnection 식별자 (덤프 내 순번)" },
  코덱:     { desc: "사용 중인 비디오 코덱 (H264/H265/VP9 등)" },
  Loss:     { desc: "패킷 손실율 = lost / (received + lost)",  thresholds: "<2% 정상 / 2~5% 주의 / 5%+ 비정상" },
  FPS:      { desc: "초당 프레임 (수신측)",                     thresholds: "20+ 정상 / 10~19 주의 / 10 미만 비정상" },
  Jitter:   { desc: "패킷 도착 간격의 흔들림 (초)",             thresholds: "<0.03s 정상 / ≥0.05s 비정상" },
  Recv:     { desc: "측정 구간 동안 받은 프레임 수 (누적)" },
  Decoded:  { desc: "측정 구간 동안 디코딩 성공한 프레임 수" },
  Dropped:  { desc: "디코딩됐지만 화면에 못 그린 프레임 수" },
  PktLost:  { desc: "측정 구간 누적 손실 패킷 수",              thresholds: "200 이상이면 트래픽 무관 부담" },
  Freeze:   { desc: "1초 이상 영상 정지 이벤트 횟수 증가량",     thresholds: "0~4 경미 / 20+ 주의 / 50+ 심각" },
  NACK:     { desc: "패킷 재전송 요청 횟수 증가량",             thresholds: "<30 정상 / 30~99 주의 / 100+ 비정상" },
};

/** 긴 카메라 ID(UUID 등)을 앞 length 글자 + … 로 축약. 짧으면 그대로. */
function shortCam(id: string, length = 12): string {
  if (!id) return "—";
  return id.length <= length ? id : `${id.slice(0, length)}…`;
}

// ── 메인 ────────────────────────────────────────────────────────────────

interface Props {
  summary:  AnalysisSummary;
  fileName: string;
}

type SortKey = "health" | "freeze" | "loss" | "nack";

export default function ResultView({ summary, fileName }: Props) {
  const [search, setSearch]         = useState("");
  const [riskFilter, setRiskFilter] = useState<"" | Risk>("");
  const [sortBy, setSortBy]         = useState<SortKey>("health");

  // 원인별 카운트 (비정상 기준)
  const causeCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of summary.abnormal) m[r.cause] = (m[r.cause] ?? 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [summary]);

  // 필터 + 정렬
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return summary.rows
      .filter((r) => {
        if (riskFilter && riskLevel(r) !== riskFilter) return false;
        if (q && !`${r.camera} ${r.peer}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => {
        if (sortBy === "freeze") return (b.freezeDelta ?? 0) - (a.freezeDelta ?? 0);
        if (sortBy === "loss")   return (b.lossRatio ?? 0)   - (a.lossRatio ?? 0);
        if (sortBy === "nack")   return (b.nackDelta ?? 0)   - (a.nackDelta ?? 0);
        return (a.health ?? 100) - (b.health ?? 100);
      });
  }, [summary, search, riskFilter, sortBy]);

  function downloadJson() {
    const blob = new Blob([JSON.stringify(summary, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${fileName.replace(/\.(gz|json)$/i, "")}_analysis.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const normalCount = Math.max(0, summary.rows.length - summary.abnormal.length);
  const scoreClass  = summary.avg < 60 ? "text-rose-400" : summary.avg < 80 ? "text-amber-300" : "text-emerald-300";

  return (
    <div className="space-y-6">
      {/* ── 요약 카드 ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="종합 Health" value={summary.avg.toString()} valueClass={scoreClass} />
        <Kpi label="전체 스트림" value={summary.rows.length.toString()} />
        <Kpi label="비정상" value={summary.abnormal.length.toString()} valueClass="text-amber-300" />
        <Kpi label="정상" value={normalCount.toString()} valueClass="text-emerald-300" />
      </div>

      {/* ── 시각화 ── */}
      {summary.rows.length > 0 && <Charts summary={summary} />}

      {/* ── 원인 칩 + 다운로드 ── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500">비정상 주요 원인:</span>
          {causeCounts.length === 0 && <span className="text-xs text-gray-600">없음</span>}
          {causeCounts.map(([cause, n]) => (
            <span
              key={cause}
              className={`px-2 py-0.5 text-[11px] rounded-full border ${badgeCause(cause as Cause)}`}
            >
              {shortCause(cause as Cause)} {n}개
            </span>
          ))}
        </div>
        <button
          onClick={downloadJson}
          className="px-3 py-1.5 text-xs bg-emerald-700 text-white rounded-lg hover:bg-emerald-600 transition-colors"
        >
          ⬇ JSON 다운로드
        </button>
      </div>

      {/* ── 비정상 스트림 표 ── */}
      <section>
        <h2 className="text-sm font-semibold text-gray-400 mb-2">비정상 스트림 (상위 12)</h2>
        <div className="border border-line rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-panel/60 border-b border-line2 text-gray-500">
              <tr>
                <Th>카메라</Th>
                <Th>Peer</Th>
                <Th>Health</Th>
                <Th>원인</Th>
                <Th>설명</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/50">
              {summary.abnormal.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-gray-600">
                    비정상 스트림이 없습니다.
                  </td>
                </tr>
              )}
              {summary.abnormal.slice(0, 12).map((r, i) => (
                <tr key={`${r.peer}-${r.camera}-${i}`} className="hover:bg-input/30 transition-colors">
                  <Td className="font-mono text-gray-300" title={r.camera}>{shortCam(r.camera, 16)}</Td>
                  <Td className="text-gray-400">{r.peer}</Td>
                  <Td className={`font-bold tabular-nums ${levelHealth(r.health)}`}>
                    {r.health} <span className="text-[10px] text-gray-500">({r.grade})</span>
                  </Td>
                  <Td>
                    <span className={`px-2 py-0.5 text-[10px] rounded-full border ${badgeCause(r.cause)}`}>
                      {shortCause(r.cause)}
                    </span>
                  </Td>
                  <Td className="text-gray-400">{explainCause(r)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── 필터 + 전체 표 ── */}
      <section>
        <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
          <h2 className="text-sm font-semibold text-gray-400">전체 스트림 ({filtered.length}/{summary.rows.length})</h2>

          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              placeholder="카메라 / peer 검색…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="px-3 py-1.5 bg-panel border border-line2 rounded-lg text-xs text-ink placeholder-gray-600 focus:outline-none focus:border-emerald-600 w-40"
            />
            <select
              value={riskFilter}
              onChange={(e) => setRiskFilter(e.target.value as "" | Risk)}
              className="px-2 py-1.5 bg-panel border border-line2 rounded-lg text-xs text-ink focus:outline-none focus:border-emerald-600"
            >
              <option value="">위험도 전체</option>
              <option value="bad">높음</option>
              <option value="warn">주의</option>
              <option value="good">양호</option>
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
              className="px-2 py-1.5 bg-panel border border-line2 rounded-lg text-xs text-ink focus:outline-none focus:border-emerald-600"
            >
              <option value="health">Health 낮은순</option>
              <option value="freeze">Freeze 많은순</option>
              <option value="loss">Loss 높은순</option>
              <option value="nack">NACK 많은순</option>
            </select>
          </div>
        </div>

        <div className="border border-line rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-panel/60 border-b border-line2 text-gray-500">
                <tr>
                  <Th tip>위험</Th>
                  <Th tip>Health</Th>
                  <Th tip>원인</Th>
                  <Th tip>카메라</Th>
                  <Th tip>Peer</Th>
                  <Th tip>코덱</Th>
                  <Th tip right>Loss</Th>
                  <Th tip right>FPS</Th>
                  <Th tip right>Jitter</Th>
                  <Th tip right>Recv</Th>
                  <Th tip right>Decoded</Th>
                  <Th tip right>Dropped</Th>
                  <Th tip right>PktLost</Th>
                  <Th tip right>Freeze</Th>
                  <Th tip right>NACK</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/50">
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={15} className="px-3 py-6 text-center text-gray-600">
                      조건에 맞는 스트림이 없습니다.
                    </td>
                  </tr>
                )}
                {filtered.map((r, i) => {
                  const risk   = riskLevel(r);
                  const freeze = rnd(r.freezeDelta);
                  const nack   = rnd(r.nackDelta);
                  const recv   = rnd(r.framesReceivedDelta);
                  const dec    = rnd(r.framesDecodedDelta);
                  const drop   = rnd(r.framesDroppedDelta);
                  const framesT = tipFrames(recv, dec, drop);
                  return (
                    <tr key={`${r.peer}-${r.camera}-${i}`} className="hover:bg-input/30 transition-colors">
                      <Td>
                        <span
                          className={`px-2 py-0.5 text-[10px] rounded-full border ${badgeRisk(risk)}`}
                          title={`종합 위험도: ${risk === "bad" ? "높음" : risk === "warn" ? "주의" : "양호"}`}
                        >
                          {risk === "bad" ? "높음" : risk === "warn" ? "주의" : "양호"}
                        </span>
                      </Td>
                      <Td
                        className={`font-bold tabular-nums ${levelHealth(r.health)}`}
                        title={tipHealth(r.health, r.grade)}
                      >
                        {r.health}
                      </Td>
                      <Td>
                        <span
                          className={`px-2 py-0.5 text-[10px] rounded-full border ${badgeCause(r.cause)}`}
                          title={`원인: ${r.cause}`}
                        >
                          {shortCause(r.cause)}
                        </span>
                      </Td>
                      <Td className="font-mono text-gray-300" title={r.camera}>
                        {shortCam(r.camera, 12)}
                      </Td>
                      <Td className="text-gray-400">{r.peer}</Td>
                      <Td className="text-gray-400" title={r.codec ? `코덱: ${r.codec}` : "코덱 정보 없음"}>
                        {r.codec || "n/a"}
                      </Td>
                      <Td right className={`font-mono tabular-nums ${levelLoss(r.lossRatio)}`} title={tipLoss(r.lossRatio)}>
                        {fmtPct(r.lossRatio)}
                      </Td>
                      <Td right className={`font-mono tabular-nums ${levelFps(r.fps)}`} title={tipFps(r.fps)}>
                        {fmtFps(r.fps)}
                      </Td>
                      <Td right className={`font-mono tabular-nums ${levelJitter(r.jitter)}`} title={tipJitter(r.jitter)}>
                        {fmtSec(r.jitter)}
                      </Td>
                      <Td right className="font-mono tabular-nums text-gray-400" title={framesT}>{recv}</Td>
                      <Td right className="font-mono tabular-nums text-gray-400" title={framesT}>{dec}</Td>
                      <Td right className="font-mono tabular-nums text-gray-400" title={framesT}>{drop}</Td>
                      <Td right className="font-mono tabular-nums text-gray-400" title={`측정 구간 누적 손실 패킷 ${rnd(r.packetsLostDelta)}개`}>
                        {rnd(r.packetsLostDelta)}
                      </Td>
                      <Td right className={`font-mono tabular-nums ${levelFreeze(freeze)}`} title={tipFreeze(freeze)}>
                        {freeze}
                      </Td>
                      <Td right className={`font-mono tabular-nums ${levelNack(nack)}`} title={tipNack(nack)}>
                        {nack}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}

// ── 작은 헬퍼 컴포넌트 ──────────────────────────────────────────────────

function Kpi({ label, value, valueClass = "text-ink" }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="bg-panel border border-line rounded-xl p-3">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold tabular-nums ${valueClass}`}>{value}</p>
    </div>
  );
}

function Th({ children, right, tip }: { children: React.ReactNode; right?: boolean; tip?: boolean }) {
  const label = typeof children === "string" ? children : "";
  const info  = tip && label ? HEADER_TIPS[label] : undefined;

  return (
    <th
      className={`px-3 py-2 font-medium whitespace-nowrap relative group ${right ? "text-right" : "text-left"}`}
    >
      <span className={info ? "border-b border-dashed border-gray-700 cursor-help" : ""}>
        {children}
      </span>
      {info && (
        <span
          role="tooltip"
          className={[
            "pointer-events-none absolute z-20 top-full mt-1 w-56 px-3 py-2 rounded-lg",
            "bg-panel border border-line2 shadow-xl text-left",
            "opacity-0 group-hover:opacity-100 transition-opacity duration-100",
            right ? "right-0" : "left-0",
          ].join(" ")}
        >
          <span className="block text-[11px] text-gray-300 leading-relaxed">{info.desc}</span>
          {info.thresholds && (
            <span className="block mt-1 text-[10px] text-emerald-400 font-mono">{info.thresholds}</span>
          )}
        </span>
      )}
    </th>
  );
}

function Td({
  children, className = "", right, title,
}: {
  children:   React.ReactNode;
  className?: string;
  right?:     boolean;
  title?:     string;
}) {
  return (
    <td className={`px-3 py-2 ${right ? "text-right" : ""} ${className}`} title={title}>
      {children}
    </td>
  );
}
