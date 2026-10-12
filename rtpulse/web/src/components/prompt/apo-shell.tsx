"use client";

import { useState } from "react";
import ApoConfig, { type ApoDbTab, type VmsConn } from "./apo-config";
import ApoList from "./apo-list";
import ApoTuning from "./apo-tuning";

type PageState = "config" | "list" | "tuning";

export default function ApoShell() {
  const [state,          setState]          = useState<PageState>("config");
  const [connTab,        setConnTab]        = useState<ApoDbTab>("watch");
  const [connCustomerId, setConnCustomerId] = useState<string | undefined>(undefined);
  const [vmsConn,       setVmsConn]       = useState<VmsConn | undefined>(undefined);
  const [connStartDate,  setConnStartDate]  = useState<string | undefined>(undefined);
  const [connEndDate,    setConnEndDate]    = useState<string | undefined>(undefined);

  const handleConnect = (tab: ApoDbTab, vmsConn?: VmsConn, customerId?: string, dateRange?: { startDate?: string; endDate?: string }) => {
    setConnTab(tab);
    setVmsConn(vmsConn);
    setConnCustomerId(customerId);
    setConnStartDate(dateRange?.startDate);
    setConnEndDate(dateRange?.endDate);
    setState("list");
  };

  const handleGoToTuning = () => setState("tuning");
  const handleBackToList = () => setState("list");

  return (
    <div className="flex flex-col h-full bg-canvas">
      {/* ── 헤더 ── */}
      <div className="border-b border-line px-8 pt-6 pb-0">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <span className="text-xl">🤖</span>
            <div>
              <h1 className="text-base font-bold text-ink">APO</h1>
              <p className="text-xs text-faint">
                Auto Prompt Optimization — 이벤트 라벨링 &amp; 검수
              </p>
            </div>
          </div>

          {(state === "list" || state === "tuning") && (
            <div className="flex items-center gap-2">
              {/* 접속 방식 뱃지 */}
              <span className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border ${
                connTab === "vms"
                  ? "bg-amber-900/30 text-amber-300 border-amber-700/40"
                  : "bg-purple-900/30 text-purple-300 border-purple-700/40"
              }`}>
                {connTab === "vms" ? "VMS DB" : "Watch DB"}
              </span>

              {/* 튜닝 뱃지 */}
              {state === "tuning" && (
                <span className="px-2.5 py-1 rounded-full text-[10px] font-semibold border bg-blue-900/30 text-blue-300 border-blue-700/40">
                  튜닝 설정
                </span>
              )}

              <button
                onClick={() => setState("config")}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted hover:text-ink border border-line2 hover:border-gray-600 rounded-lg transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                DB 설정
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── 콘텐츠 ── */}
      <div className="flex-1 overflow-y-auto px-8 py-7">
        {state === "config" && (
          <ApoConfig onConnect={handleConnect} />
        )}
        {state === "list" && (
          <ApoList defaultCustomerId={connCustomerId} defaultStartDate={connStartDate} defaultEndDate={connEndDate} connTab={connTab} vmsConn={vmsConn} onNext={handleGoToTuning} />
        )}
        {state === "tuning" && (
          <ApoTuning connTab={connTab} onBack={handleBackToList} />
        )}
      </div>
    </div>
  );
}
