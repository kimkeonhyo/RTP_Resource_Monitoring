"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { TopoResult, TopoElement } from "@/app/api/serverroom/topology/route";

const REFRESH_INTERVAL = 30_000;
const GRID = 20;   // Zabbix 맵 격자와 같은 값

const SEV_COLOR = ["#9ca3af", "#38bdf8", "#facc15", "#fb923c", "#ef4444", "#dc2626"];
const SEV_NAME = ["미분류", "정보", "경고", "보통", "높음", "심각"];

function stateColor(e: TopoElement): string {
  if (e.state === "disabled") return "#9ca3af";
  if (e.state === "problem") return SEV_COLOR[Math.min(e.severity, 5)];
  if (e.state === "ok") return "#16a34a";
  return "#6b7280";
}

function stateText(e: TopoElement): string {
  if (e.state === "disabled") return "사용 안 함";
  if (e.state === "problem") return e.problems.length > 1 ? `장애 ${e.problems.length}건` : "장애";
  if (e.state === "ok") return "정상";
  return "";
}

const snap = (v: number) => Math.round(v / GRID) * GRID;

export default function Topology({ embedded = false }: { embedded?: boolean }) {
  const router = useRouter();
  const [data, setData] = useState<TopoResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fit, setFit] = useState(true);
  const [hover, setHover] = useState<TopoElement | null>(null);

  // 편집 모드 — 아이콘을 끌어 옮기고 저장하면 Zabbix 맵에 반영된다.
  const [edit, setEdit] = useState(false);
  const [moved, setMoved] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/serverroom/topology");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setData(j);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 편집 중에는 갱신하지 않는다 — 서버 좌표가 끌고 있던 위치를 덮어쓴다.
  useEffect(() => {
    if (edit) return;
    const t = setInterval(load, REFRESH_INTERVAL);
    return () => clearInterval(t);
  }, [load, edit]);

  const pos = useCallback(
    (e: { id: string; x: number; y: number }) => moved.get(e.id) ?? { x: e.x, y: e.y },
    [moved],
  );

  const center = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const e of data?.elements ?? []) {
      const p = pos(e);
      m.set(e.id, { x: p.x + e.w / 2, y: p.y + e.h / 2 });
    }
    return m;
  }, [data, pos]);

  function toSvg(clientX: number, clientY: number) {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    return new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  }

  function onDown(e: React.PointerEvent, el: TopoElement) {
    if (!edit) return;
    const p = toSvg(e.clientX, e.clientY);
    if (!p) return;
    const cur = pos(el);
    drag.current = { id: el.id, dx: p.x - cur.x, dy: p.y - cur.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  function onMove(e: React.PointerEvent) {
    if (!drag.current) return;
    const p = toSvg(e.clientX, e.clientY);
    if (!p) return;
    const { id, dx, dy } = drag.current;
    setMoved((prev) => new Map(prev).set(id, { x: snap(p.x - dx), y: snap(p.y - dy) }));
  }

  const onUp = () => { drag.current = null; };

  async function save() {
    if (!moved.size) return;
    setSaving(true);
    setSaved(null);
    try {
      const r = await fetch("/api/serverroom/topology", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          positions: [...moved].map(([id, p]) => ({ id, x: p.x, y: p.y })),
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setSaved(`${j.saved}개 위치를 저장했습니다`);
      setMoved(new Map());
      setEdit(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (error && !data) {
    return (
      <div className="p-6">
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-xs text-red-400">{error}</div>
      </div>
    );
  }
  if (!data) return <p className="p-6 text-xs text-faint">불러오는 중…</p>;

  const down = data.elements.filter((e) => e.state === "problem").length;
  const height = Math.max(data.height, ...data.elements.map((e) => pos(e).y + e.h + 40));

  return (
    <div className={`${embedded ? "" : "p-6 "}space-y-4`}>
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-ink">인프라 구성도</h1>
          <p className="text-xs text-faint mt-0.5">
            장비 {data.elements.filter((e) => e.hostid).length}대
            {down > 0 && <span className="text-red-400"> · 장애 {down}</span>}
            {" · "}
            {edit ? "아이콘을 끌어 옮긴 뒤 저장하세요" : "아이콘을 누르면 그 장비 화면으로 갑니다"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {edit ? (
            <>
              <span className="text-[11px] text-faint">{moved.size}개 이동</span>
              <button onClick={save} disabled={saving || !moved.size}
                className="px-2.5 py-1.5 text-xs rounded-lg border border-cyan-700 bg-cyan-900/40
                           text-cyan-300 hover:bg-cyan-900/60 disabled:opacity-50">
                {saving ? "저장 중…" : "저장"}
              </button>
              <button onClick={() => { setMoved(new Map()); setEdit(false); }}
                className="px-2.5 py-1.5 text-xs rounded-lg border border-line2 text-muted hover:text-ink">
                취소
              </button>
            </>
          ) : (
            <button onClick={() => { setEdit(true); setSaved(null); }}
              className="px-2.5 py-1.5 text-xs rounded-lg border border-line2 text-muted hover:text-ink">
              배치 편집
            </button>
          )}
          <button onClick={() => setFit((v) => !v)}
            className="px-2.5 py-1.5 text-xs rounded-lg border border-line2 text-muted hover:text-ink">
            {fit ? "원본 크기" : "화면에 맞추기"}
          </button>
          {data.zabbixWeb && (
            <a href={`${data.zabbixWeb}/sysmaps.php`} target="_blank" rel="noreferrer"
               className="text-[11px] text-cyan-400 hover:underline">Zabbix 에서 편집 →</a>
          )}
        </div>
      </div>

      {saved && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-2 text-[11px] text-emerald-400">
          {saved}
        </div>
      )}
      {error && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-2 text-[11px] text-amber-400">
          {error}
        </div>
      )}

      <div className="rounded-lg border border-line2 bg-white overflow-auto">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${data.width} ${height}`}
          width={fit ? "100%" : data.width}
          height={fit ? undefined : height}
          style={{ display: "block", ...(fit ? {} : { maxWidth: "none" }), touchAction: edit ? "none" : undefined }}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={onUp}
          role="img"
          aria-label={data.name}
        >
          {data.shapes.map((s, i) => (
            <g key={`s${i}`}>
              <rect x={s.x} y={s.y} width={s.w} height={s.h}
                    fill={s.fill} stroke={s.stroke} strokeWidth={s.strokeWidth} rx={4} />
              {s.text && (
                <text x={s.x + 10} y={s.y + s.fontSize + 6} fontSize={s.fontSize} fill={s.fontColor}>{s.text}</text>
              )}
            </g>
          ))}

          {data.links.map((l, i) => {
            const a = center.get(l.from), b = center.get(l.to);
            if (!a || !b) return null;
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            return (
              <g key={`l${i}`}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                      stroke={l.color} strokeWidth={l.bold ? 2.5 : 1}
                      strokeDasharray={l.dash ? "5 4" : undefined} />
                {l.label && (
                  <text x={mx} y={my - 3} fontSize={10} fill="#555" textAnchor="middle"
                        stroke="#fff" strokeWidth={3} paintOrder="stroke">
                    {l.label.split(/\r?\n/).map((t, j) => (
                      <tspan key={j} x={mx} dy={j === 0 ? 0 : 11}>{t}</tspan>
                    ))}
                  </text>
                )}
              </g>
            );
          })}

          {data.elements.map((e) => {
            const p = pos(e);
            const cx = p.x + e.w / 2;
            const labelY = e.labelLocation === 3 ? p.y - 6 : p.y + e.h + 12;
            const clickable = !edit && !!e.hostid;
            const lines = e.label.split(/\r?\n/).filter(Boolean);
            const isMoved = moved.has(e.id);
            return (
              <g key={e.id}
                 onPointerDown={(ev) => onDown(ev, e)}
                 onClick={clickable ? () => router.push(`/serverroom/host/${e.hostid}`) : undefined}
                 onMouseEnter={() => setHover(e)}
                 onMouseLeave={() => setHover((h) => (h?.id === e.id ? null : h))}
                 style={{ cursor: edit ? "grab" : clickable ? "pointer" : "default" }}>
                <rect x={p.x - 6} y={p.y - 6} width={e.w + 12} height={e.h + 22 + 12 * lines.length}
                      fill={hover?.id === e.id ? "#0ea5e91a" : "transparent"}
                      stroke={isMoved ? "#0891b2" : "none"} strokeDasharray="4 3" rx={6} />
                {e.state === "problem" && (
                  <rect x={p.x - 4} y={p.y - 4} width={e.w + 8} height={e.h + 8}
                        fill="none" stroke={stateColor(e)} strokeWidth={2} rx={5} />
                )}
                <image href={data.icons[e.iconId] ?? ""} x={p.x} y={p.y} width={e.w} height={e.h} />
                {/* 맵 라벨은 여러 줄일 수 있다({HOST.NAME}\n{HOST.IP} 등).
                    SVG <text> 는 개행을 무시하므로 tspan 으로 나눠 그린다. */}
                <text x={cx} y={labelY} fontSize={11} fill="#222" textAnchor="middle">
                  {lines.map((t, j) => (
                    <tspan key={j} x={cx} dy={j === 0 ? 0 : 12}>{t}</tspan>
                  ))}
                </text>
                {e.state !== "none" && (
                  <text x={cx} y={labelY + 12 * lines.length} fontSize={10} fill={stateColor(e)}
                        textAnchor="middle" fontWeight={600}>{stateText(e)}</text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {hover?.problems.length ? (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
          <p className="text-xs text-red-400 font-medium">{hover.label}</p>
          <ul className="mt-1 space-y-0.5">
            {hover.problems.map((p, i) => <li key={i} className="text-[11px] text-muted">· {p}</li>)}
          </ul>
        </div>
      ) : null}

      <p className="text-[10px] text-faint">
        배치는 Zabbix 맵이 원본입니다. 여기서 옮겨 저장하면 Zabbix 맵에도 반영되고, 반대로 Zabbix
        화면에서 옮긴 것도 여기 나옵니다. 새로 등록한 장비는 구성도 맨 아래에 놓이니 끌어다 배치하세요.
        선·그룹 박스 편집은 Zabbix 화면에서 합니다. 장애 표시는 맵 속성의 최소 심각도
        ({SEV_NAME[data.severityMin] ?? data.severityMin}) 이상만 나옵니다. 편집 중이 아니면 30초마다 갱신합니다.
      </p>
    </div>
  );
}
