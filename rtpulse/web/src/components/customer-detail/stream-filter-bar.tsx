"use client";

import { useMemo } from "react";
import { ApiStream, StreamHealth } from "@/lib/types";

export type StatusFilter = "all" | StreamHealth;
export type TypeFilter = "all" | "main" | "sub";

export function streamTypeOf(name: string): "main" | "sub" | "other" {
  if (name.endsWith("(메인)")) return "main";
  if (name.endsWith("(서브)")) return "sub";
  return "other";
}

export function displayName(name: string) {
  return name.replace(/ \(메인\)$/, "").replace(/ \(서브\)$/, "");
}

export function applyFilters(
  streams: ApiStream[],
  status: StatusFilter,
  type: TypeFilter,
  search: string
): ApiStream[] {
  return streams.filter((s) => {
    if (status !== "all" && s.health !== status) return false;
    if (type === "main" && streamTypeOf(s.name) !== "main") return false;
    if (type === "sub"  && streamTypeOf(s.name) !== "sub")  return false;
    if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });
}

const STATUS_TABS: { key: StatusFilter; label: string; activeClass: string }[] = [
  { key: "all",      label: "전체",    activeClass: "text-gray-300 bg-gray-700" },
  { key: "HEALTHY",  label: "정상",    activeClass: "text-green-400 bg-gray-700" },
  { key: "DEGRADED", label: "저하",    activeClass: "text-yellow-400 bg-gray-700" },
  { key: "DOWN",     label: "중단",    activeClass: "text-red-400 bg-gray-700" },
];

const TYPE_TABS: { key: TypeFilter; label: string }[] = [
  { key: "all",  label: "전체" },
  { key: "main", label: "메인" },
  { key: "sub",  label: "서브" },
];

interface Props {
  streams: ApiStream[];
  status: StatusFilter;
  type: TypeFilter;
  search: string;
  onStatus: (v: StatusFilter) => void;
  onType: (v: TypeFilter) => void;
  onSearch: (v: string) => void;
  compact?: boolean; // smaller variant for Detail section
}

export default function StreamFilterBar({ streams, status, type, search, onStatus, onType, onSearch, compact }: Props) {
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: streams.length, HEALTHY: 0, DEGRADED: 0, DOWN: 0, UNKNOWN: 0 };
    streams.forEach((s) => { c[s.health] = (c[s.health] ?? 0) + 1; });
    return c;
  }, [streams]);

  const px = compact ? "px-2.5 py-1" : "px-3 py-1.5";
  const textSize = "text-xs";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Status */}
      <div className="flex bg-panel border border-line rounded-lg overflow-hidden">
        {STATUS_TABS.map(({ key, label, activeClass }) => (
          <button
            key={key}
            onClick={() => onStatus(key)}
            className={`${px} ${textSize} font-medium transition-colors ${
              status === key ? activeClass : "text-muted hover:text-ink2"
            }`}
          >
            {label}
            <span className="ml-1 opacity-60">({counts[key === "all" ? "all" : key] ?? 0})</span>
          </button>
        ))}
      </div>

      {/* Stream type */}
      <div className="flex bg-panel border border-line rounded-lg overflow-hidden">
        {TYPE_TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => onType(key)}
            className={`${px} ${textSize} font-medium transition-colors ${
              type === key ? "bg-gray-700 text-cyan-400" : "text-muted hover:text-ink2"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Search */}
      <input
        type="text"
        placeholder="카메라 이름..."
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        className="ml-auto px-3 py-1.5 bg-panel border border-line rounded-lg text-xs text-ink placeholder-gray-600 focus:outline-none focus:border-cyan-700 w-40"
      />
    </div>
  );
}
