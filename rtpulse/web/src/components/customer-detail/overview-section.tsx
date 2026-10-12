"use client";

import { useState, useMemo } from "react";
import { ApiStream } from "@/lib/types";
import HealthBadge from "@/components/health-badge";
import StreamFilterBar, {
  StatusFilter,
  TypeFilter,
  applyFilters,
  displayName,
  streamTypeOf,
} from "./stream-filter-bar";

export default function OverviewSection({ streams }: { streams: ApiStream[] }) {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [type, setType]     = useState<TypeFilter>("all");
  const [search, setSearch] = useState("");

  const filtered = useMemo(
    () => applyFilters(streams, status, type, search),
    [streams, status, type, search]
  );

  return (
    <div className="space-y-3">
      <StreamFilterBar
        streams={streams}
        status={status}
        type={type}
        search={search}
        onStatus={setStatus}
        onType={setType}
        onSearch={setSearch}
      />

      <div className="bg-panel border border-line rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-input text-muted text-xs uppercase">
              <th className="px-4 py-2 text-left">이름</th>
              <th className="px-3 py-2 text-left w-16">유형</th>
              <th className="px-2 py-2 text-left w-14">Proto</th>
              <th className="px-4 py-2 text-right">Bitrate</th>
              <th className="px-4 py-2 text-right">Loss%</th>
              <th className="px-4 py-2 text-right">Jitter</th>
              <th className="px-4 py-2 text-right">FPS</th>
              <th className="px-4 py-2 text-left">상태</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-faint">
                  {streams.length === 0 ? "스트림 없음" : "검색 결과 없음"}
                </td>
              </tr>
            ) : (
              filtered.map((s) => {
                const type = streamTypeOf(s.name);
                return (
                  <tr key={s.id} className="hover:bg-input/50 transition-colors">
                    <td className="px-4 py-2 text-ink font-medium truncate max-w-[200px]">{displayName(s.name)}</td>
                    <td className="px-3 py-2">
                      {type === "main" && (
                        <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400 text-[10px] rounded font-medium">메인</span>
                      )}
                      {type === "sub" && (
                        <span className="px-1.5 py-0.5 bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-400 text-[10px] rounded font-medium">서브</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-muted text-xs">{s.protocol}</td>
                    <td className="px-4 py-2 text-right text-ink2">{s.bitrate_kbps.toFixed(0)} kbps</td>
                    <td className={`px-4 py-2 text-right ${s.packet_loss_pct > 10 ? "text-red-400" : s.packet_loss_pct > 2 ? "text-yellow-400" : "text-ink2"}`}>
                      {s.packet_loss_pct.toFixed(2)}%
                    </td>
                    <td className={`px-4 py-2 text-right ${s.jitter_ms > 50 ? "text-yellow-400" : "text-ink2"}`}>
                      {s.jitter_ms.toFixed(1)}ms
                    </td>
                    <td className="px-4 py-2 text-right text-ink2">{s.fps.toFixed(1)}</td>
                    <td className="px-4 py-2">
                      <HealthBadge health={s.health} />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {filtered.length > 0 && filtered.length < streams.length && (
          <div className="px-4 py-2 border-t border-line text-xs text-faint">
            {filtered.length}개 표시 / 전체 {streams.length}개
          </div>
        )}
      </div>
    </div>
  );
}
