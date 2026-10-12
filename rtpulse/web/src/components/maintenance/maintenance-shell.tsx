"use client";

import { useState } from "react";
import InspectionList from "./inspection-list";
import MaintenanceCalendar from "./maintenance-calendar";
import MaintenanceTimeline from "./maintenance-timeline";

type Tab = "list" | "calendar" | "timeline";

export default function MaintenanceShell() {
  const [tab, setTab] = useState<Tab>("list");

  return (
    <div className="space-y-4">
      {/* 뷰 탭 */}
      <div className="flex items-center gap-1 border-b border-line">
        {([
          { key: "list",     label: "고객별 점검 리스트" },
          { key: "calendar", label: "달력" },
          { key: "timeline", label: "타임라인" },
        ] as { key: Tab; label: string }[]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === key ? "border-cyan-500 text-cyan-400" : "border-transparent text-muted hover:text-ink2"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "list" && <InspectionList />}
      {tab === "calendar" && <MaintenanceCalendar />}
      {tab === "timeline" && <MaintenanceTimeline />}
    </div>
  );
}
