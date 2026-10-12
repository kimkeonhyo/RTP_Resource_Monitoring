"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import type { HostDetail, Series } from "@/app/api/serverroom/host/[hostid]/route";

const RANGES = [{ h: 6, label: "6시간" }, { h: 24, label: "24시간" }, { h: 72, label: "3일" }];
const REFRESH = 60_000;

const SEV = ["미분류", "정보", "경고", "보통", "높음", "심각"];

function hhmm(t: number): string {
  return new Date(t).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** 시계열 값 포맷 — 단위에 맞춰. %/bps/s는 단위까지 포함해 반환한다. */
function fmtVal(v: number, units: string): string {
  const a = Math.abs(v);
  if (/bps|bits/i.test(units)) {
    if (a >= 1e9) return `${(v / 1e9).toFixed(1)}G`;
    if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
    return v.toFixed(0);
  }
  if (units === "%") return `${v.toFixed(0)}%`;
  // 초 단위(응답시간 등)는 작을 때 ms로 — 0.005s → 5ms
  if (units === "s") return a > 0 && a < 1 ? `${(v * 1000).toFixed(a < 0.001 ? 2 : 0)}ms` : `${v.toFixed(1)}s`;
  if (a === 0) return "0";
  if (a >= 100) return v.toFixed(0);
  if (a >= 1)   return v.toFixed(1);
  if (a >= 0.001) return v.toFixed(3);
  return v.toExponential(1);
}

function color(label: string): string {
  if (label.includes("온도")) return "#f59e0b";
  if (label.includes("송신")) return "#f59e0b";
  if (label.includes("수신")) return "#06b6d4";
  if (label.startsWith("CPU")) return "#06b6d4";
  if (label.includes("메모리")) return "#22c55e";
  if (label.includes("사용률")) return "#a855f7";
  return "#38bdf8";
}

function Chart({ s }: { s: Series }) {
  const c = color(s.label);
  const data = s.points.map((p) => ({ t: p.t, v: p.v }));
  const last = data[data.length - 1]?.v;
  return (
    <div className="bg-panel border border-line rounded-xl p-4">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-xs font-semibold text-ink2">{s.label}</span>
        <span className="text-xs font-mono text-muted">
          {last !== undefined ? fmtVal(last, s.units) : "—"}{s.units && !/bps|bits|%|^s$/i.test(s.units) ? ` ${s.units}` : ""}
        </span>
      </div>
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line, #2a2a35)" vertical={false} />
            <XAxis dataKey="t" tickFormatter={hhmm} minTickGap={48}
                   tick={{ fontSize: 10, fill: "#8b8b96" }} stroke="#3a3a45" />
            <YAxis width={44} tickFormatter={(v) => fmtVal(Number(v), s.units)}
                   tick={{ fontSize: 10, fill: "#8b8b96" }} stroke="#3a3a45"
                   domain={s.units === "%" ? [0, 100] : ["auto", "auto"]} />
            <Tooltip
              labelFormatter={(t) => new Date(Number(t)).toLocaleString("ko-KR", { hour12: false })}
              formatter={(v: number) => [fmtVal(v, s.units), s.label]}
              contentStyle={{ background: "#15151c", border: "1px solid #2a2a35", borderRadius: 8, fontSize: 12 }} />
            <Line type="monotone" dataKey="v" stroke={c} strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default function HostDetail({ hostid, kind }: { hostid: string; kind: string }) {
  const [hours, setHours] = useState(6);
  const [data, setData]   = useState<HostDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/serverroom/host/${hostid}?hours=${hours}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json); setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [hostid, hours]);

  useEffect(() => {
    setLoading(true);
    load();
    const t = setInterval(load, REFRESH);
    return () => clearInterval(t);
  }, [load]);

  const backHref = kind === "switch" || kind === "server" ? `/serverroom/${kind}` : "/serverroom/server";

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link href={backHref} className="text-xs text-faint hover:text-ink">‹ 목록</Link>
          <div>
            <h1 className="text-lg font-bold text-ink">{data?.name ?? "…"}</h1>
            {data?.ip && <p className="text-xs text-faint font-mono">{data.ip}</p>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {RANGES.map((r) => (
            <button key={r.h} onClick={() => setHours(r.h)}
              className={`px-2.5 py-1 text-xs rounded-lg border transition-colors ${
                hours === r.h ? "bg-cyan-900/40 border-cyan-700 text-cyan-300"
                              : "border-line2 text-muted hover:text-ink"}`}>
              {r.label}
            </button>
          ))}
          {data?.zabbixUrl && (
            <a href={`${data.zabbixUrl}/zabbix.php?action=latest.view&hostids[]=${hostid}`}
               target="_blank" rel="noopener noreferrer"
               className="px-2.5 py-1 text-xs rounded-lg border border-line2 text-cyan-500 hover:text-cyan-400">Zabbix ↗</a>
          )}
        </div>
      </div>

      {error && <div className="px-4 py-3 bg-red-950/30 border border-red-800/60 rounded-xl text-xs text-red-400">✕ {error}</div>}

      {data && data.problems.length > 0 && (
        <div className="bg-panel border border-red-900/40 rounded-xl p-4 space-y-1">
          <p className="text-xs font-semibold text-red-400 mb-1">장애 {data.problems.length}건</p>
          {data.problems.slice(0, 8).map((p, i) => (
            <p key={i} className="text-[11px] text-muted truncate">
              · <span className="text-faint">[{SEV[p.severity] ?? p.severity}]</span> {p.name}
            </p>
          ))}
        </div>
      )}

      {loading && !data && <p className="text-sm text-faint animate-pulse py-12 text-center">불러오는 중…</p>}

      {data && (data.series.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {data.series.map((s) => <Chart key={s.label} s={s} />)}
        </div>
      ) : (
        <p className="text-sm text-faint py-12 text-center">그래프로 표시할 시계열 데이터가 없습니다.</p>
      ))}
    </div>
  );
}
