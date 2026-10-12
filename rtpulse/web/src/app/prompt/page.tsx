"use client";

import { useState } from "react";
import PromptIntro from "@/components/prompt/prompt-intro";
import PromptRecordsTable from "@/components/prompt/prompt-records-table";
import CsvToJsonSection from "@/components/prompt/csv-to-json-section";
import PromptPerformance from "@/components/prompt/prompt-performance";

type Tab = "intro" | "records" | "performance" | "csv";

export default function PromptPage() {
  const [tab, setTab] = useState<Tab>("intro");

  return (
    <div className="flex flex-col h-full bg-canvas">
      {/* Page header */}
      <div className="border-b border-line px-8 pt-6 pb-0">
        <div className="flex items-center gap-3 mb-4">
          <span className="text-xl">🧠</span>
          <div>
            <h1 className="text-base font-bold text-ink">Prompt 관리</h1>
            <p className="text-xs text-faint">VMS 프롬프트 버전 관리 &amp; NAS 업로드</p>
          </div>
        </div>

        {/* Tabs */}
        <nav className="flex gap-1">
          {(
            [
              { key: "intro",       label: "소개 / 가이드" },
              { key: "records",     label: "프롬프트 리스트" },
              { key: "performance", label: "프롬프트 성능" },
              { key: "csv",         label: "CSV → JSON" },
            ] as { key: Tab; label: string }[]
          ).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-5 py-2.5 text-sm font-medium rounded-t-lg transition-colors border-b-2 ${
                tab === key
                  ? "text-cyan-400 border-cyan-500 bg-panel/60"
                  : "text-muted border-transparent hover:text-ink2"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-8 py-7">
        {tab === "intro"       && <PromptIntro />}
        {tab === "records"     && <PromptRecordsTable />}
        {tab === "performance" && <PromptPerformance />}
        {tab === "csv"         && <CsvToJsonSection />}
      </div>
    </div>
  );
}
