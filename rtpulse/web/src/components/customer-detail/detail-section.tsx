"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { ApiStream } from "@/lib/types";
import StreamFilterBar, {
  StatusFilter,
  TypeFilter,
  applyFilters,
  displayName,
  streamTypeOf,
} from "./stream-filter-bar";
import HealthBadge from "@/components/health-badge";

// ---------------------------------------------------------------------------
// Searchable dropdown
// ---------------------------------------------------------------------------

function StreamDropdown({
  streams,
  selected,
  onSelect,
}: {
  streams: ApiStream[];
  selected: ApiStream | null;
  onSelect: (s: ApiStream) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const listFiltered = useMemo(() => {
    if (!query) return streams;
    const q = query.toLowerCase();
    return streams.filter((s) => s.name.toLowerCase().includes(q));
  }, [streams, query]);

  const healthDot: Record<string, string> = {
    HEALTHY:  "bg-green-500",
    DEGRADED: "bg-yellow-500",
    DOWN:     "bg-red-500",
    UNKNOWN:  "bg-gray-500",
  };

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-2.5 bg-panel border border-line2 rounded-xl text-sm hover:border-gray-600 transition-colors"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          {selected ? (
            <>
              <span className={`shrink-0 w-2 h-2 rounded-full ${healthDot[selected.health]}`} />
              {streamTypeOf(selected.name) === "main" && (
                <span className="shrink-0 px-1.5 py-0.5 bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400 text-[10px] rounded font-medium">메인</span>
              )}
              {streamTypeOf(selected.name) === "sub" && (
                <span className="shrink-0 px-1.5 py-0.5 bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-400 text-[10px] rounded font-medium">서브</span>
              )}
              <span className="text-ink font-medium truncate">{displayName(selected.name)}</span>
              <span className="text-faint text-xs shrink-0">{selected.bitrate_kbps.toFixed(0)} kbps</span>
            </>
          ) : (
            <span className="text-faint">카메라를 선택하세요</span>
          )}
        </div>
        <svg
          className={`w-4 h-4 text-muted shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute z-30 mt-1 w-full bg-canvas border border-line2 rounded-xl shadow-2xl overflow-hidden">
          {/* Search inside dropdown */}
          <div className="px-3 py-2 border-b border-line">
            <input
              ref={inputRef}
              type="text"
              placeholder="카메라 이름 검색..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full px-3 py-1.5 bg-panel border border-line2 rounded-lg text-xs text-ink placeholder-gray-600 focus:outline-none focus:border-cyan-700"
            />
          </div>

          {/* List */}
          <div className="max-h-64 overflow-y-auto">
            {listFiltered.length === 0 ? (
              <p className="px-4 py-3 text-xs text-faint">검색 결과 없음</p>
            ) : (
              listFiltered.map((s) => {
                const t = streamTypeOf(s.name);
                const isSelected = s.id === selected?.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => { onSelect(s); setOpen(false); setQuery(""); }}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left text-xs transition-colors border-b border-panel last:border-0 ${
                      isSelected
                        ? "bg-cyan-900/30 text-cyan-400"
                        : "text-ink2 hover:bg-input"
                    }`}
                  >
                    <span className={`shrink-0 w-2 h-2 rounded-full ${healthDot[s.health]}`} />
                    {t === "main" && (
                      <span className="shrink-0 px-1.5 py-0.5 bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400 text-[9px] rounded font-medium">메인</span>
                    )}
                    {t === "sub" && (
                      <span className="shrink-0 px-1.5 py-0.5 bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-400 text-[9px] rounded font-medium">서브</span>
                    )}
                    <span className="flex-1 truncate font-medium">{displayName(s.name)}</span>
                    <HealthBadge health={s.health} />
                    <span className="text-faint shrink-0 tabular-nums">{s.bitrate_kbps.toFixed(0)} kbps</span>
                  </button>
                );
              })
            )}
          </div>

          <div className="px-4 py-1.5 border-t border-line text-[10px] text-faint">
            {listFiltered.length}개 / 전체 {streams.length}개
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main section
// ---------------------------------------------------------------------------

export default function DetailSection({ streams }: { streams: ApiStream[] }) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [type, setType]     = useState<TypeFilter>("all");
  const [search, setSearch] = useState("");

  const filtered = useMemo(
    () => applyFilters(streams, status, type, search),
    [streams, status, type, search]
  );

  const selectedStream =
    filtered.find((s) => s.id === selectedId) ??
    filtered[0] ??
    null;

  if (streams.length === 0) {
    return <p className="text-faint text-sm">스트림 없음</p>;
  }

  const metrics = selectedStream
    ? [
        { label: "Bitrate (kbps)",  value: selectedStream.bitrate_kbps.toFixed(1),   color: "#22d3ee" },
        { label: "Packet Loss (%)", value: selectedStream.packet_loss_pct.toFixed(2), color: "#ef4444" },
        { label: "Jitter (ms)",     value: selectedStream.jitter_ms.toFixed(2),       color: "#eab308" },
        { label: "FPS",             value: selectedStream.fps.toFixed(1),             color: "#a78bfa" },
      ]
    : [];

  return (
    <div className="space-y-4">
      {/* Filter bar — narrows which streams appear in the dropdown */}
      <StreamFilterBar
        streams={streams}
        status={status}
        type={type}
        search={search}
        onStatus={setStatus}
        onType={setType}
        onSearch={setSearch}
        compact
      />

      {filtered.length === 0 ? (
        <p className="text-faint text-sm py-4 text-center">검색 결과 없음</p>
      ) : (
        <>
          {/* Dropdown selector */}
          <StreamDropdown
            streams={filtered}
            selected={selectedStream}
            onSelect={(s) => setSelectedId(s.id)}
          />

          {/* Detail panel */}
          {selectedStream && (
            <>
              {/* Metric cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {metrics.map(({ label, value, color }) => (
                  <div key={label} className="bg-panel border border-line rounded-xl p-3">
                    <p className="text-xs text-faint mb-1">{label}</p>
                    <p className="text-xl font-bold" style={{ color }}>{value}</p>
                  </div>
                ))}
              </div>

              {/* Counters */}
              <div className="bg-panel border border-line rounded-xl p-4">
                <h4 className="text-xs text-faint mb-3">Counters</h4>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                  <Counter label="Uptime"   value={formatUptime(selectedStream.uptime_secs)} />
                  <Counter label="Protocol" value={selectedStream.protocol} />
                  <Counter label="Health"   value={selectedStream.health} />
                  <Counter
                    label="유형"
                    value={
                      streamTypeOf(selectedStream.name) === "main" ? "메인스트림"
                      : streamTypeOf(selectedStream.name) === "sub" ? "서브스트림"
                      : "—"
                    }
                  />
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Counter({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-faint">{label}</p>
      <p className="text-ink font-mono">{value}</p>
    </div>
  );
}

function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}
