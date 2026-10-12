"use client";

import { useState } from "react";
import { ApiStream, ApiAggregate, StreamHealth } from "@/lib/types";
import HealthBadge from "@/components/health-badge";
import StreamFilterBar, {
  StatusFilter,
  TypeFilter,
  applyFilters,
  streamTypeOf,
  displayName,
} from "./stream-filter-bar";

function HealthCard({ stream }: { stream: ApiStream }) {
  const borderColor: Record<StreamHealth, string> = {
    HEALTHY: "border-l-green-500",
    DEGRADED: "border-l-yellow-500",
    DOWN: "border-l-red-500",
    UNKNOWN: "border-l-gray-600",
  };
  const type = streamTypeOf(stream.name);
  return (
    <div className={`bg-panel border border-line border-l-2 ${borderColor[stream.health]} flex items-center gap-2 px-3 py-2 rounded-lg`}>
      {type === "main" && (
        <span className="shrink-0 px-1.5 py-0.5 bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400 text-[10px] rounded font-medium">메인</span>
      )}
      {type === "sub" && (
        <span className="shrink-0 px-1.5 py-0.5 bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-400 text-[10px] rounded font-medium">서브</span>
      )}
      {type === null && (
        <span className="shrink-0 w-8" />
      )}
      <span className="flex-1 text-sm text-ink truncate">{displayName(stream.name)}</span>
      <HealthBadge health={stream.health} />
    </div>
  );
}

export default function DashboardSection({
  streams,
  aggregate,
}: {
  streams: ApiStream[];
  aggregate?: ApiAggregate;
}) {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [type, setType]     = useState<TypeFilter>("all");
  const [search, setSearch] = useState("");

  const filtered = applyFilters(streams, status, type, search);
  const problems = streams.filter((s) => s.health === "DOWN" || s.health === "DEGRADED");

  return (
    <div className="space-y-4">
      {/* Aggregate metrics — always show totals, not filtered */}
      {aggregate && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "전체",   value: aggregate.total,   color: "text-ink2" },
            { label: "정상",   value: aggregate.healthy,  color: "text-green-400" },
            { label: "경고",   value: aggregate.degraded, color: "text-yellow-400" },
            { label: "다운",   value: aggregate.down,     color: "text-red-400" },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-panel border border-line rounded-xl p-3 text-center">
              <p className={`text-2xl font-bold ${color}`}>{value}</p>
              <p className="text-xs text-faint mt-1">{label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Filter bar */}
      <StreamFilterBar
        streams={streams}
        status={status}
        type={type}
        search={search}
        onStatus={setStatus}
        onType={setType}
        onSearch={setSearch}
      />

      {/* Stream health cards */}
      {filtered.length === 0 ? (
        <p className="text-faint text-sm py-4 text-center">검색 결과 없음</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-1.5">
          {filtered.map((s) => (
            <HealthCard key={s.id} stream={s} />
          ))}
        </div>
      )}
      {filtered.length > 0 && filtered.length < streams.length && (
        <p className="text-xs text-faint">{filtered.length}개 표시 / 전체 {streams.length}개</p>
      )}

      {/* Problem streams — always visible regardless of filter */}
      {problems.length > 0 && (
        <div>
          <h3 className="text-xs text-red-400 font-semibold mb-2">⚠ 이상 스트림</h3>
          <div className="space-y-2">
            {problems.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-3 bg-red-950/30 border border-red-900 rounded-lg px-3 py-2 text-sm"
              >
                <HealthBadge health={s.health} />
                <span className="text-ink">{displayName(s.name)}</span>
                <span className="text-muted text-xs truncate">{s.url}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
