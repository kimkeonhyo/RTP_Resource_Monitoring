"use client";

import { ApiStats } from "@/lib/types";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { format } from "date-fns";
import { ko } from "date-fns/locale";
import * as XLSX from "xlsx";

const kindColor: Record<string, string> = {
  DOWN: "text-red-400",
  WARNING: "text-yellow-400",
  RECONNECT: "text-green-400",
};

function downloadExcel(stats: ApiStats, customerName: string) {
  const wb = XLSX.utils.book_new();

  // ── Sheet 1: 요약 ──────────────────────────────────────────────
  const summaryRows = [
    ["항목", "값"],
    ["오늘 다운 횟수", stats.summary.downs_today],
    ["7일 다운 횟수", stats.summary.downs_last_7d],
    ["30일 다운 횟수", stats.summary.downs_last_30d],
    [
      "마지막 다운 시각",
      stats.summary.last_down_epoch
        ? format(new Date(stats.summary.last_down_epoch * 1000), "yyyy-MM-dd HH:mm:ss", { locale: ko })
        : "—",
    ],
    ["기간 필터", stats.filter],
    ["추출 시각", format(new Date(), "yyyy-MM-dd HH:mm:ss", { locale: ko })],
  ];
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  wsSummary["!cols"] = [{ wch: 20 }, { wch: 25 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, "요약");

  // ── Sheet 2: 스트림별 통계 ─────────────────────────────────────
  const streamHeader = ["스트림명", "Down 횟수", "Warn 횟수", "Reconnect 횟수", "마지막 이벤트"];
  const streamRows = stats.stream_rows.map((r) => [
    r.stream_name,
    r.down_count,
    r.warn_count,
    r.reconnect_count,
    r.last_event_epoch
      ? format(new Date(r.last_event_epoch * 1000), "yyyy-MM-dd HH:mm:ss", { locale: ko })
      : "—",
  ]);
  const wsStreams = XLSX.utils.aoa_to_sheet([streamHeader, ...streamRows]);
  wsStreams["!cols"] = [{ wch: 30 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, wsStreams, "스트림별 통계");

  // ── Sheet 3: 이벤트 로그 ──────────────────────────────────────
  const logHeader = ["시각", "스트림명", "이벤트", "원인"];
  const logRows = stats.event_log.map((e) => [
    format(new Date(e.happened_at_epoch * 1000), "yyyy-MM-dd HH:mm:ss", { locale: ko }),
    e.stream_name,
    e.event_kind,
    e.cause,
  ]);
  const wsLog = XLSX.utils.aoa_to_sheet([logHeader, ...logRows]);
  wsLog["!cols"] = [{ wch: 22 }, { wch: 30 }, { wch: 12 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, wsLog, "이벤트 로그");

  // ── 다운로드 ──────────────────────────────────────────────────
  const fileName = `RTPulse_${customerName}_${format(new Date(), "yyyyMMdd_HHmm")}.xlsx`;
  XLSX.writeFile(wb, fileName);
}

export default function StatsSection({
  stats,
  customerName = "고객사",
}: {
  stats?: ApiStats;
  customerName?: string;
}) {
  if (!stats) {
    return <p className="text-faint text-sm">통계 데이터 로딩 중...</p>;
  }

  const trendData = stats.filter_trend.map((v, i) => ({ i: i + 1, events: v }));

  return (
    <div className="space-y-4">
      {/* 헤더 + 다운로드 버튼 */}
      <div className="flex items-center justify-end">
        <button
          onClick={() => downloadExcel(stats, customerName)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-400 text-emerald-700 text-xs hover:bg-emerald-100 dark:bg-emerald-900/40 dark:border-emerald-700/50 dark:text-emerald-400 dark:hover:bg-emerald-800/50 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1M12 12v6m0 0l-3-3m3 3l3-3M12 3v9" />
          </svg>
          Excel 다운로드
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="오늘 다운" value={stats.summary.downs_today} color="text-red-400" />
        <StatCard label="7일 다운" value={stats.summary.downs_last_7d} color="text-orange-400" />
        <StatCard label="30일 다운" value={stats.summary.downs_last_30d} color="text-yellow-400" />
        <StatCard
          label="마지막 다운"
          value={
            stats.summary.last_down_epoch
              ? format(new Date(stats.summary.last_down_epoch * 1000), "MM/dd HH:mm", { locale: ko })
              : "—"
          }
          color="text-ink2"
        />
      </div>

      {/* Trend chart */}
      {trendData.length > 0 && (
        <div className="bg-panel border border-line rounded-xl p-4">
          <p className="text-xs text-faint mb-3">이벤트 추이 ({stats.filter})</p>
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={trendData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--c-line))" />
              <XAxis dataKey="i" tick={{ fill: "#6b7280", fontSize: 10 }} />
              <YAxis tick={{ fill: "#6b7280", fontSize: 10 }} />
              <Tooltip
                contentStyle={{ backgroundColor: "#111827", border: "1px solid #374151", borderRadius: 8 }}
                labelStyle={{ color: "#9ca3af" }}
              />
              <Bar dataKey="events" fill="#06b6d4" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Stream rollup */}
      {stats.stream_rows.length > 0 && (
        <div className="bg-panel border border-line rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-input text-muted text-xs uppercase">
                <th className="px-4 py-2 text-left">스트림</th>
                <th className="px-4 py-2 text-right text-red-400">Down</th>
                <th className="px-4 py-2 text-right text-yellow-400">Warn</th>
                <th className="px-4 py-2 text-right text-green-400">Recon</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {stats.stream_rows.map((r) => (
                <tr key={r.stream_id}>
                  <td className="px-4 py-2 text-ink2">{r.stream_name}</td>
                  <td className="px-4 py-2 text-right text-red-400">{r.down_count}</td>
                  <td className="px-4 py-2 text-right text-yellow-400">{r.warn_count}</td>
                  <td className="px-4 py-2 text-right text-green-400">{r.reconnect_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Event log */}
      {stats.event_log.length > 0 && (
        <div className="bg-panel border border-line rounded-xl overflow-hidden">
          <div className="px-4 py-2 border-b border-line">
            <span className="text-xs text-faint">이벤트 로그</span>
          </div>
          <div className="divide-y divide-line">
            {stats.event_log.map((e, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2 text-xs">
                <span className="text-faint w-32 flex-shrink-0">
                  {format(new Date(e.happened_at_epoch * 1000), "MM/dd HH:mm:ss", { locale: ko })}
                </span>
                <span className="text-ink2 w-24 flex-shrink-0 truncate">{e.stream_name}</span>
                <span className={`font-bold w-20 flex-shrink-0 ${kindColor[e.event_kind] ?? "text-muted"}`}>
                  {e.event_kind}
                </span>
                <span className="text-faint truncate">{e.cause}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="bg-panel border border-line rounded-xl p-3">
      <p className="text-xs text-faint mb-1">{label}</p>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
    </div>
  );
}
