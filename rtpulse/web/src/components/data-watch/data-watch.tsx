"use client";

import { useState } from "react";
import { Customer } from "@/lib/types";
import PromptHistory from "./prompt-history";
import DataList from "./data-list";
import EventStats from "./event-stats";
import DetectionStats from "./detection-stats";

interface Props {
  customer: Customer;
}

export default function DataWatch({ customer }: Props) {
  const [dbStatus, setDbStatus] = useState<"idle" | "checking" | "ok" | "error">("idle");
  const [dbMsg, setDbMsg] = useState("");
  const [initing, setIniting] = useState(false);

  const hasDb = !!(customer.dbPassword);

  async function initDb() {
    setIniting(true);
    setDbStatus("checking");
    setDbMsg("");
    try {
      const res = await fetch(`/api/db/${customer.id}/init`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setDbStatus("error");
        setDbMsg(data.error ?? "초기화 실패");
      } else {
        setDbStatus("ok");
        setDbMsg(data.message ?? "완료");
      }
    } catch (e: unknown) {
      setDbStatus("error");
      setDbMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setIniting(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* DB 연결 상태 */}
      <section>
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-3 border-b border-line pb-2">
          1. DB 연결 설정
        </h2>
        <div className="border border-line rounded-xl p-4 space-y-3">
          <div className="grid grid-cols-2 gap-4 text-xs">
            <InfoRow label="서버 IP" value={customer.ip ?? new URL(customer.apiUrl).hostname} />
            <InfoRow
              label="VIP"
              value={customer.vip || `${customer.ip ?? new URL(customer.apiUrl).hostname} (서버 IP 사용)`}
            />
            <InfoRow label="DB 이름" value={customer.dbName || "미설정"} accent={!customer.dbName ? "error" : undefined} />
            <InfoRow label="포트" value={String(customer.dbPort ?? 3306)} />
            <InfoRow label="사용자" value={customer.dbUser ?? "ops"} />
            <InfoRow label="비밀번호" value={hasDb ? "●●●●●●" : "미설정"} accent={!hasDb ? "error" : undefined} />
          </div>

          {(!customer.dbName || !hasDb) && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 dark:text-amber-400 dark:bg-amber-900/20 dark:border-amber-800">
              {!customer.dbName ? "DB 이름이 설정되지 않았습니다." : "DB 비밀번호가 설정되지 않았습니다."}{" "}
              고객사 수정 페이지에서 DB 정보를 입력하세요.
            </p>
          )}

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={initDb}
              disabled={!hasDb || !customer.dbName || initing}
              className="px-3 py-1.5 text-xs bg-input text-cyan-400 border border-line2 rounded-lg hover:bg-gray-700 disabled:opacity-40"
            >
              {initing ? "확인 중..." : "DB 연결 테스트"}
            </button>
            <span className="text-xs text-faint">
              {customer.dbName ? `${customer.dbName}.camera_events 연결 및 테이블 확인` : "DB 이름을 먼저 설정하세요"}
            </span>
          </div>

          {dbStatus !== "idle" && (
            <p className={`text-xs ${dbStatus === "ok" ? "text-green-400" : dbStatus === "error" ? "text-red-400" : "text-muted"}`}>
              {dbStatus === "checking" ? "연결 중..." : dbMsg}
            </p>
          )}
        </div>
      </section>

      {/* Prompt 배포 이력 */}
      <section>
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-3 border-b border-line pb-2">
          2. Prompt 배포 이력
        </h2>
        <PromptHistory customerId={customer.id} />
      </section>

      {/* Data List */}
      <section>
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-3 border-b border-line pb-2">
          3. Data List
        </h2>
        <DataList customer={customer} />
      </section>

      {/* 이벤트 통계 */}
      <section>
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-3 border-b border-line pb-2">
          4. 이벤트 통계
        </h2>
        <div className="space-y-4">
          <EventStats customer={customer} />
          <DetectionStats customer={customer} />
        </div>
      </section>
    </div>
  );
}

function InfoRow({ label, value, accent }: { label: string; value: string; accent?: "error" }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-faint w-20 shrink-0">{label}</span>
      <span className={`font-mono ${accent === "error" ? "text-red-400" : "text-ink2"}`}>{value}</span>
    </div>
  );
}
