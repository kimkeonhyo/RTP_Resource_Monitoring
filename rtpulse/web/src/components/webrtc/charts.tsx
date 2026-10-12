"use client";

import { useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie,
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
} from "recharts";
import type { AnalysisSummary, Cause, StreamRow } from "@/lib/webrtc/types";
import { shortCause } from "@/lib/webrtc/analyzer";

// 원인별 색 — Result View 의 배지 색과 일치
const CAUSE_COLORS: Record<Cause, string> = {
  "네트워크 문제":          "#06b6d4",
  "디코더 병목":            "#a855f7",
  "렌더링/GPU/CPU 문제":    "#f97316",
  "복합/기타":              "#9ca3af",
};

// Health 점수 → 색
function healthColor(v: number): string {
  if (v < 60) return "#fb7185"; // rose-400
  if (v < 80) return "#fcd34d"; // amber-300
  return "#34d399";              // emerald-400
}

const TOOLTIP_STYLE = {
  backgroundColor: "#111827",
  border:          "1px solid #374151",
  borderRadius:    8,
  fontSize:        11,
};

// ────────────────────────────────────────────────────────────────────────

interface Props { summary: AnalysisSummary }

export default function Charts({ summary }: Props) {
  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-400 mb-2">📊 시각화</h2>
      <div className="grid lg:grid-cols-3 gap-4">
        <HealthBars rows={summary.rows} />
        <CauseDonut rows={summary.rows} />
        <SubScoreRadar rows={summary.rows} />
      </div>
    </section>
  );
}

// ── 1. 스트림별 Health 막대 ──────────────────────────────────────────

function HealthBars({ rows }: { rows: StreamRow[] }) {
  const data = useMemo(
    () => rows.map((r) => ({
      name:   `${r.peer} ${r.camera.slice(0, 6)}`,
      health: r.health,
      cause:  r.cause,
      camera: r.camera,
    })),
    [rows],
  );

  return (
    <ChartCard title="스트림별 Health" subtitle="색상 = 원인 추정">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, bottom: 4, left: 12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
          <XAxis type="number" domain={[0, 100]} tick={{ fill: "#6b7280", fontSize: 10 }} />
          <YAxis type="category" dataKey="name" tick={{ fill: "#6b7280", fontSize: 10 }} width={90} />
          <Tooltip
            cursor={{ fill: "#1f2937", opacity: 0.4 }}
            contentStyle={TOOLTIP_STYLE}
            labelStyle={{ color: "#9ca3af" }}
            itemStyle={{ fontSize: 11 }}
            formatter={(v: number, _n, p) => [
              `${v}점 / 원인: ${shortCause((p.payload as { cause: Cause }).cause)}`,
              "Health",
            ]}
          />
          <Bar dataKey="health" radius={[0, 4, 4, 0]}>
            {data.map((d, i) => (
              <Cell key={i} fill={CAUSE_COLORS[d.cause]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// ── 2. 원인별 도넛 ─────────────────────────────────────────────────

function CauseDonut({ rows }: { rows: StreamRow[] }) {
  const data = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.cause] = (counts[r.cause] ?? 0) + 1;
    return Object.entries(counts)
      .map(([name, value]) => ({ name, value, color: CAUSE_COLORS[name as Cause] }))
      .sort((a, b) => b.value - a.value);
  }, [rows]);

  const total = rows.length;

  return (
    <ChartCard title="원인 분포" subtitle={`전체 ${total}개 스트림`}>
      <div className="relative">
        <ResponsiveContainer width="100%" height={220}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius={48}
              outerRadius={80}
              paddingAngle={2}
              stroke="none"
            >
              {data.map((d, i) => <Cell key={i} fill={d.color} />)}
            </Pie>
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              labelStyle={{ color: "#9ca3af" }}
              // 도넛 조각 색이 옅은 경우(복합=회색 등) 텍스트가 안 보여서 명시적으로 라이트 그레이 고정
              itemStyle={{ fontSize: 11, color: "#e5e7eb", fontWeight: 500 }}
              formatter={(v: number, name: string) => {
                const pct = total > 0 ? ((v / total) * 100).toFixed(0) : "0";
                return [`${v}개 (${pct}%)`, shortCause(name as Cause)];
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        {/* 가운데 총합 */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-[10px] text-gray-500">총</span>
          <span className="text-2xl font-bold text-emerald-300 leading-tight">{total}</span>
        </div>
      </div>
      {/* 범례 */}
      <ul className="mt-3 space-y-1 text-[11px]">
        {data.map((d) => (
          <li key={d.name} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm" style={{ background: d.color }} />
            <span className="text-gray-400 flex-1">{shortCause(d.name as Cause)}</span>
            <span className="text-gray-500 tabular-nums">{d.value}</span>
          </li>
        ))}
      </ul>
    </ChartCard>
  );
}

// ── 3. 4부문 평균 레이더 ─────────────────────────────────────────────

function SubScoreRadar({ rows }: { rows: StreamRow[] }) {
  const data = useMemo(() => {
    if (rows.length === 0) return [];
    const avg = (key: keyof StreamRow) =>
      Math.round(rows.reduce((s, r) => s + (r[key] as number), 0) / rows.length);
    return [
      { axis: "네트워크",  score: avg("networkScore"),  full: 100 },
      { axis: "디코더",    score: avg("decodeScore"),   full: 100 },
      { axis: "렌더링",    score: avg("renderScore"),   full: 100 },
      { axis: "복구",      score: avg("recoveryScore"), full: 100 },
    ];
  }, [rows]);

  return (
    <ChartCard title="부문별 평균" subtitle="100 에 가까울수록 양호">
      <ResponsiveContainer width="100%" height={260}>
        <RadarChart data={data} cx="50%" cy="50%" outerRadius="75%">
          <PolarGrid stroke="#374151" />
          <PolarAngleAxis dataKey="axis" tick={{ fill: "#9ca3af", fontSize: 11 }} />
          <PolarRadiusAxis angle={90} domain={[0, 100]} tick={{ fill: "#6b7280", fontSize: 9 }} />
          <Radar
            name="평균 점수"
            dataKey="score"
            stroke="#34d399"
            fill="#34d399"
            fillOpacity={0.4}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            itemStyle={{ fontSize: 11, color: "#34d399" }}
            formatter={(v: number) => [`${v}점`, "평균"]}
          />
        </RadarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// ── 공용 카드 ─────────────────────────────────────────────────────

function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-panel border border-line rounded-xl p-4">
      <div className="mb-2">
        <p className="text-sm font-semibold text-gray-300">{title}</p>
        {subtitle && <p className="text-[11px] text-gray-600">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

// healthColor 는 추후 사용 예정 (스트림별 막대 외 페이즈)
void healthColor;
