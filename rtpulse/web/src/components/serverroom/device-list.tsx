"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import type { ServerRoomResult, DeviceRow } from "@/app/api/serverroom/[kind]/route";

const REFRESH_INTERVAL = 30_000;

const SEV = ["미분류", "정보", "경고", "보통", "높음", "심각"];
const SEV_CLASS = [
  "bg-gray-500/15 text-gray-400",
  "bg-sky-500/15 text-sky-400",
  "bg-yellow-500/15 text-yellow-400",
  "bg-orange-500/15 text-orange-400",
  "bg-red-500/15 text-red-400",
  "bg-red-600/25 text-red-300",
];

function fmtUptime(sec?: number | string): string {
  const s = typeof sec === "number" ? sec : Number(sec);
  if (!Number.isFinite(s) || s <= 0) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d > 0 ? `${d}일 ${h}시간` : `${h}시간`;
}

/** bps → 사람이 읽는 단위. Zabbix bits 단위 기준. */
function fmtBps(v?: number | string): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} Gbps`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} Mbps`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} Kbps`;
  return `${n.toFixed(0)} bps`;
}

function Bar({ pct }: { pct: number }) {
  const fill = pct > 85 ? "bg-red-500" : pct > 65 ? "bg-amber-500" : "bg-cyan-500";
  return (
    <div className="w-full h-1.5 bg-input rounded-full overflow-hidden">
      <div className={`h-full ${fill} rounded-full transition-all`}
           style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }} />
    </div>
  );
}

function Cell({ label, m }: { label: string; m?: { value: number | string; units: string } }) {
  if (!m) return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-baseline gap-2">
        <span className="text-[11px] text-faint font-medium">{label}</span>
        <span className="text-xs font-mono text-faint">—</span>
      </div>
    </div>
  );
  const isPct = m.units === "%";
  const v = typeof m.value === "number"
    ? (isPct ? `${m.value.toFixed(1)}%` : `${m.value.toLocaleString()}${m.units ? ` ${m.units}` : ""}`)
    : String(m.value);
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-baseline gap-2">
        <span className="text-[11px] text-faint font-medium">{label}</span>
        <span className="text-xs font-mono text-muted truncate">{v}</span>
      </div>
      {isPct && typeof m.value === "number" && <Bar pct={m.value} />}
    </div>
  );
}

function StateDot({ state }: { state: DeviceRow["state"] }) {
  const map = {
    ok:      { c: "bg-emerald-500", t: "응답함" },
    down:    { c: "bg-red-500",     t: "응답 없음" },
    unknown: { c: "bg-gray-500",    t: "판단 불가" },
  }[state];
  return <span className={`inline-block w-2 h-2 rounded-full ${map.c}`} title={map.t} />;
}

function DeviceCard({ d, kind, zabbixUrl, onEdit, onDelete }: {
  d: DeviceRow; kind: string; zabbixUrl: string | null;
  onEdit: (d: DeviceRow) => void; onDelete: (d: DeviceRow) => void;
}) {
  const worst = d.problems.reduce((a, p) => Math.max(a, p.severity), -1);
  return (
    <div className="bg-panel border border-line rounded-xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StateDot state={d.state} />
            <Link href={`/serverroom/host/${d.hostid}?kind=${kind}`}
                  className="text-sm font-semibold text-ink truncate hover:text-cyan-400 transition-colors"
                  title="상세 그래프 보기">
              {d.name}
            </Link>
          </div>
          <p className="text-[11px] text-faint font-mono mt-0.5">{d.ip ?? "—"}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {!d.enabled && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-gray-500/15 text-gray-400">중지</span>
          )}
          {worst >= 0 && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${SEV_CLASS[worst]}`}>
              {SEV[worst]} {d.problems.length}
            </span>
          )}
          <button onClick={() => onEdit(d)} title="수정"
                  className="p-1 text-faint hover:text-cyan-400 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
          <button onClick={() => onDelete(d)} title="삭제"
                  className="p-1 text-faint hover:text-red-400 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {kind !== "switch" ? (
          <>
            <Cell label="CPU"    m={d.metrics.cpu} />
            <Cell label="메모리"  m={d.metrics.mem} />
            <Cell label="디스크"  m={d.metrics.disk} />
            <Cell label="Load"   m={d.metrics.load} />
          </>
        ) : (
          <>
            <Cell label="CPU"    m={d.metrics.cpu} />
            <Cell label="메모리"  m={d.metrics.mem} />
            <Cell label="온도"    m={d.metrics.temp} />
            <Cell label="응답시간" m={d.metrics.rtt} />
          </>
        )}
      </div>

      {d.ports && (
        <div className="pt-2 border-t border-line grid grid-cols-3 gap-2 text-[11px]">
          <div><span className="text-faint">활성 포트</span> <span className="font-mono text-muted">{d.ports.up}</span></div>
          <div><span className="text-faint">최대</span> <span className="font-mono text-muted">{d.ports.maxPct?.toFixed(0) ?? "—"}%</span></div>
          <div className="truncate" title={d.ports.busiest ?? ""}>
            <span className="text-faint">최다</span> <span className="font-mono text-muted">{d.ports.busiest ?? "—"}</span>
          </div>
        </div>
      )}

      {d.gpu && (
        <div className="pt-2 border-t border-line grid grid-cols-3 gap-2 text-[11px]">
          <div><span className="text-faint">GPU</span> <span className="font-mono text-muted">{d.gpu.count}장</span></div>
          <div><span className="text-faint">최대 사용</span> <span className="font-mono text-muted">{d.gpu.utilMax?.toFixed(0) ?? "—"}%</span></div>
          <div><span className="text-faint">최대 온도</span> <span className="font-mono text-muted">{d.gpu.tempMax?.toFixed(0) ?? "—"}°C</span></div>
        </div>
      )}

      {(d.metrics.net_in || d.metrics.net_out) && (
        <div className="pt-2 border-t border-line grid grid-cols-2 gap-2 text-[11px]">
          <div><span className="text-faint">↓ 수신</span> <span className="font-mono text-cyan-500">{fmtBps(d.metrics.net_in?.value)}</span></div>
          <div><span className="text-faint">↑ 송신</span> <span className="font-mono text-amber-500">{fmtBps(d.metrics.net_out?.value)}</span></div>
        </div>
      )}

      {d.problems.length > 0 && (
        <ul className="pt-2 border-t border-line space-y-1">
          {d.problems.slice(0, 3).map((p, i) => (
            <li key={i} className="text-[11px] text-muted truncate">· {p.name}</li>
          ))}
          {d.problems.length > 3 && (
            <li className="text-[10px] text-faint">외 {d.problems.length - 3}건</li>
          )}
        </ul>
      )}

      <div className="flex items-center justify-between pt-1">
        <span className="text-[10px] text-faint">가동 {fmtUptime(d.metrics.uptime?.value)}</span>
        {zabbixUrl && (
          <a href={`${zabbixUrl}/zabbix.php?action=latest.view&filter_hostids[]=&filter_select=${encodeURIComponent(d.host)}`}
             target="_blank" rel="noopener noreferrer"
             className="text-[10px] text-cyan-500 hover:text-cyan-400">Zabbix ↗</a>
        )}
      </div>
    </div>
  );
}

type Filter = "all" | "ok" | "down" | "unknown" | "problem";
const FILTERS: { k: Filter; label: string }[] = [
  { k: "all", label: "전체" }, { k: "ok", label: "정상" }, { k: "down", label: "응답없음" },
  { k: "unknown", label: "판단불가" }, { k: "problem", label: "장애" },
];

const modalInput =
  "w-full px-3 py-2 text-xs bg-panel border border-line2 rounded-lg text-ink " +
  "placeholder-gray-600 focus:outline-none focus:border-cyan-600";

function EditModal({ device, onClose, onSaved }: {
  device: DeviceRow; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName]       = useState(device.name);
  const [ip, setIp]           = useState(device.ip ?? "");
  const [enabled, setEnabled] = useState(device.enabled);
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const res = await fetch(`/api/serverroom/host/${device.hostid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), ip: ip.trim(), enabled }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-panel border border-line rounded-xl p-5 w-full max-w-sm space-y-4"
           onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="text-sm font-semibold text-ink">장비 수정</h2>
          <p className="text-[11px] text-faint font-mono mt-0.5">{device.host}</p>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="block text-[11px] text-faint mb-1">표시 이름</label>
            <input className={modalInput} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="block text-[11px] text-faint mb-1">IP 주소</label>
            <input className={`${modalInput} font-mono`} value={ip}
                   onChange={(e) => setIp(e.target.value)} placeholder="192.0.2.50" />
          </div>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)}
                   className="accent-cyan-600" />
            모니터링 활성화
          </label>
          {err && <p className="text-[11px] text-red-400">{err}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose}
                    className="px-3 py-1.5 text-xs rounded-lg border border-line2 text-muted hover:text-ink">취소</button>
            <button type="submit" disabled={busy}
                    className="px-3 py-1.5 text-xs rounded-lg border border-cyan-700 bg-cyan-900/40 text-cyan-300 hover:bg-cyan-900/60 disabled:opacity-50">
              {busy ? "저장 중…" : "저장"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function DeviceList({ kind, title }: { kind: "switch" | "server" | "cloud"; title: string }) {
  const [data,    setData]    = useState<ServerRoomResult | null>(null);
  const [error,   setError]   = useState("");
  const [loading, setLoading] = useState(true);
  const [search,  setSearch]  = useState("");
  const [filter,  setFilter]  = useState<Filter>("all");
  const [orderIds, setOrderIds] = useState<string[]>([]);
  const [editing, setEditing] = useState<DeviceRow | null>(null);
  const dragId = useRef<string | null>(null);

  const orderKey = `serverroom-order-${kind}`;
  const saveOrder = useCallback((ids: string[]) => {
    try { localStorage.setItem(orderKey, JSON.stringify(ids)); } catch { /* ignore */ }
  }, [orderKey]);

  const load = useCallback(async () => {
    try {
      const res  = await fetch(`/api/serverroom/${kind}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json); setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [kind]);

  // 저장된 순서 복원(장비별)
  useEffect(() => {
    try {
      const s = localStorage.getItem(orderKey);
      if (s) setOrderIds(JSON.parse(s));
    } catch { /* ignore */ }
  }, [orderKey]);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_INTERVAL);
    return () => clearInterval(t);
  }, [load]);

  // 데이터가 오면 저장 순서와 병합(새 장비는 뒤에 붙이고, 사라진 건 제거)
  useEffect(() => {
    if (!data) return;
    const ids = data.devices.map((d) => d.hostid);
    setOrderIds((prev) => {
      const kept  = prev.filter((id) => ids.includes(id));
      const added = ids.filter((id) => !kept.includes(id));
      const next  = [...kept, ...added];
      if (next.length !== prev.length || next.some((id, i) => id !== prev[i])) saveOrder(next);
      return next;
    });
  }, [data, saveOrder]);

  const remove = async (d: DeviceRow) => {
    if (!confirm(`"${d.name}" 을(를) Zabbix 에서 삭제합니다.\n수집 이력도 함께 사라지며 되돌릴 수 없습니다. 계속할까요?`)) return;
    try {
      const res = await fetch(`/api/serverroom/host/${d.hostid}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setOrderIds((prev) => prev.filter((id) => id !== d.hostid));
      await load();
    } catch (e) {
      alert(`삭제 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const reorder = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    setOrderIds((prev) => {
      const arr = prev.filter((x) => x !== fromId);
      const ti  = arr.indexOf(toId);
      arr.splice(ti < 0 ? arr.length : ti, 0, fromId);
      saveOrder(arr);
      return arr;
    });
  };

  const down = data?.devices.filter((d) => d.state === "down").length ?? 0;
  const withProblems = data?.devices.filter((d) => d.problems.length > 0).length ?? 0;

  const idx = (id: string) => { const i = orderIds.indexOf(id); return i === -1 ? 1e9 : i; };
  const q = search.trim().toLowerCase();
  const visible = (data?.devices ?? [])
    .slice()
    .sort((a, b) => idx(a.hostid) - idx(b.hostid))
    .filter((d) => {
      if (filter === "problem" ? d.problems.length === 0 : filter !== "all" && d.state !== filter) return false;
      if (q && !`${d.name} ${d.host} ${d.ip ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">{title}</h1>
          <p className="text-xs text-faint mt-0.5">
            {data ? `${data.devices.length}대` : "…"}
            {down > 0 && <span className="text-red-400"> · 응답 없음 {down}</span>}
            {withProblems > 0 && <span className="text-amber-400"> · 장애 {withProblems}</span>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data && (
            <span className="text-[11px] text-faint">
              {new Date(data.updatedAt).toLocaleTimeString("ko-KR")} 기준 · 30초마다 갱신
            </span>
          )}
          <Link
            href={`/serverroom/register?for=${kind}`}
            className="px-3 py-1.5 text-xs rounded-lg border border-cyan-700 bg-cyan-900/40 text-cyan-300 hover:bg-cyan-900/60 whitespace-nowrap"
          >
            + 장비 등록
          </Link>
        </div>
      </div>

      {/* 검색 + 필터 */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="이름·IP 검색"
          className="px-3 py-1.5 text-xs bg-panel border border-line2 rounded-lg text-ink placeholder-gray-600 focus:outline-none focus:border-cyan-600 w-48"
        />
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button key={f.k} onClick={() => setFilter(f.k)}
              className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
                filter === f.k ? "bg-cyan-900/40 border-cyan-700 text-cyan-300"
                               : "border-line2 text-muted hover:text-ink"}`}>
              {f.label}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-faint ml-auto">카드를 드래그해 순서를 바꿀 수 있어요</span>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-xs text-red-400">
          {error}
        </div>
      )}

      {loading && !data && <p className="text-xs text-faint">불러오는 중…</p>}

      {data && data.devices.length === 0 && !error && (
        <p className="text-xs text-faint">등록된 장비가 없습니다.</p>
      )}
      {data && data.devices.length > 0 && visible.length === 0 && (
        <p className="text-xs text-faint">조건에 맞는 장비가 없습니다.</p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {visible.map((d) => (
          <div
            key={d.hostid}
            draggable
            onDragStart={() => { dragId.current = d.hostid; }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); if (dragId.current) reorder(dragId.current, d.hostid); dragId.current = null; }}
            className="cursor-move"
          >
            <DeviceCard d={d} kind={kind} zabbixUrl={data!.zabbixUrl} onEdit={setEditing} onDelete={remove} />
          </div>
        ))}
      </div>

      {editing && (
        <EditModal device={editing} onClose={() => setEditing(null)}
                   onSaved={() => { setEditing(null); load(); }} />
      )}
    </div>
  );
}
