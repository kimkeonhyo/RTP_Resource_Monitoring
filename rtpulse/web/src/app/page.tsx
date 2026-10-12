import { Suspense } from "react";
import { getCustomers } from "@/lib/customers";
import { getCustomerStatus } from "@/lib/rtpulse-client";
import CustomerCard from "@/components/dashboard/customer-card";
import IntegratedEventStats from "@/components/dashboard/integrated-event-stats";
import IntegratedDetectionStats from "@/components/dashboard/integrated-detection-stats";
import Topology from "@/components/serverroom/topology";
import type { Customer } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** 클라이언트에 전달하는 안전한 고객사 요약 (비밀번호 제외) */
export interface CustomerInfo {
  id: string;
  name: string;
  hasDb: boolean;       // dbName + dbPassword 설정 여부 (이벤트 통계용)
  networkType: string;  // "remote" | "onprem"
}

// ── 원격 고객사 Node Status (서버 Streaming) ──────────────────────────────────

async function RemoteNodeSection({ customers }: { customers: Customer[] }) {
  const statuses = await Promise.all(customers.map(getCustomerStatus));
  const reachable = statuses.filter((s) => s.reachable).length;
  return (
    <div className="space-y-3">
      <p className="text-xs text-faint">연결 {reachable} / {customers.length}</p>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {statuses.map((s) => (
          <CustomerCard key={s.customer.id} status={s} />
        ))}
      </div>
    </div>
  );
}

function NodeSkeleton({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {Array.from({ length: Math.max(count, 1) }).map((_, i) => (
        <div key={i} className="bg-panel border border-line rounded-xl p-5 animate-pulse space-y-3">
          <div className="h-4 bg-input rounded w-2/5" />
          <div className="h-3 bg-input rounded w-1/3" />
          <div className="flex gap-2 pt-1">
            <div className="h-6 bg-input rounded w-16" />
            <div className="h-6 bg-input rounded w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── 메인 페이지 ───────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const customers  = await getCustomers();
  const remote     = customers.filter((c) => c.networkType !== "onprem");
  const onprem     = customers.filter((c) => c.networkType === "onprem");

  // 클라이언트 컴포넌트용 안전한 요약 데이터
  const infos: CustomerInfo[] = customers.map((c) => ({
    id:          c.id,
    name:        c.name,
    hasDb:       !!(c.dbName && c.dbPassword),
    networkType: c.networkType ?? "remote",
  }));

  return (
    <div className="p-6 space-y-10">
      <h1 className="text-xl font-bold text-ink">통합 대시보드</h1>

      {/* ── 0. 인프라 구성도 (자체 제목 포함) ─────────────────────────────── */}
      <Topology embedded />

      {/* ── 1. 고객사 카드 ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 max-w-sm">
        <StatCard label="원격 고객사"      value={remote.length} color="text-cyan-400"   />
        <StatCard label="폐쇄망 고객사" value={onprem.length} color="text-purple-400" />
      </div>

      {/* ── 2. 원격 고객사 Node Status ────────────────────────────────────── */}
      {remote.length > 0 && (
        <section className="space-y-4">
          <SectionHeading>원격 고객사</SectionHeading>
          <Suspense fallback={<NodeSkeleton count={remote.length} />}>
            <RemoteNodeSection customers={remote} />
          </Suspense>
        </section>
      )}

      {/* ── 3. 이벤트 통계 ────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <SectionHeading>이벤트 통계</SectionHeading>
        <IntegratedEventStats customers={infos} />
      </section>

      {/* ── 4. 탐지결과 통계 ──────────────────────────────────────────────── */}
      <section className="space-y-4">
        <SectionHeading>탐지결과 통계</SectionHeading>
        <IntegratedDetectionStats customers={infos} />
      </section>
    </div>
  );
}

// ── 공용 UI ───────────────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-panel border border-line rounded-xl p-4">
      <p className="text-xs text-faint">{label}</p>
      <p className={`text-3xl font-bold mt-1 ${color}`}>{value}</p>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">
      {children}
    </h2>
  );
}
