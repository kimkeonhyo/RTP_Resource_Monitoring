"use client";

import { useState } from "react";
import ComplainList from "@/components/complain/complain-list";
import { CATEGORY_KEYS, CATEGORIES, type Category } from "@/lib/complain-categories";

export default function CsTabs() {
  const [active, setActive] = useState<Category>("complain");

  return (
    <div className="space-y-4">
      {/* 카테고리 탭 */}
      <div className="flex items-center gap-1 border-b border-line">
        {CATEGORY_KEYS.map((key) => {
          const cfg = CATEGORIES[key];
          const isActive = active === key;
          return (
            <button
              key={key}
              onClick={() => setActive(key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                isActive
                  ? "border-cyan-500 text-cyan-400"
                  : "border-transparent text-muted hover:text-ink2"
              }`}
            >
              {cfg.label}
            </button>
          );
        })}
      </div>

      {/* 선택된 카테고리의 대시보드 — key로 강제 리마운트하여 상태 초기화 */}
      <ComplainList key={active} category={active} />
    </div>
  );
}
