"use client";

import { useEffect, useState, useCallback } from "react";

const SETTING_KEY = "prompt-domain-table";

interface TableData {
  columns: string[];
  rows: string[][];
}

const DEFAULT_DATA: TableData = {
  columns: ["classes", "model", "domain"],
  rows: [
    ["falldown_fire_smoke_smoking", "PE-Core-L14-336", "customer-a"],
    ["falldown_fire_smoke", "", "customer-b"],
    ["esfalldown", "", "customer-c"],
    ["falldown_fire_smoke_esfalldown", "", "site-d"],
    ["", "", "site-a"],
    ["", "", "customer-e"],
  ],
};

export default function PromptDomainTable() {
  const [data, setData]         = useState<TableData | null>(null);
  const [editing, setEditing]   = useState(false);
  const [draft, setDraft]       = useState<TableData>(DEFAULT_DATA);
  const [saving, setSaving]     = useState(false);
  const [saveErr, setSaveErr]   = useState<string | null>(null);

  // ── 로드 ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch(`/api/site-settings/${SETTING_KEY}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.value) {
          try { setData(JSON.parse(d.value)); return; } catch { /* fallback */ }
        }
        setData(DEFAULT_DATA);
      })
      .catch(() => setData(DEFAULT_DATA));
  }, []);

  // ── 편집 시작 ──────────────────────────────────────────────────────────────
  const startEdit = () => {
    setDraft(JSON.parse(JSON.stringify(data ?? DEFAULT_DATA)));
    setSaveErr(null);
    setEditing(true);
  };

  const cancelEdit = () => { setEditing(false); setSaveErr(null); };

  // ── 저장 ──────────────────────────────────────────────────────────────────
  const save = async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      const res = await fetch(`/api/site-settings/${SETTING_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: JSON.stringify(draft) }),
      });
      if (!res.ok) throw new Error("저장 실패");
      setData(JSON.parse(JSON.stringify(draft)));
      setEditing(false);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  };

  // ── 드래프트 조작 헬퍼 ────────────────────────────────────────────────────

  const setCell = useCallback((ri: number, ci: number, val: string) => {
    setDraft((prev) => {
      const rows = prev.rows.map((r) => [...r]);
      rows[ri][ci] = val;
      return { ...prev, rows };
    });
  }, []);

  const setHeader = useCallback((ci: number, val: string) => {
    setDraft((prev) => {
      const columns = [...prev.columns];
      columns[ci] = val;
      return { ...prev, columns };
    });
  }, []);

  const addRow = useCallback(() => {
    setDraft((prev) => ({
      ...prev,
      rows: [...prev.rows, Array(prev.columns.length).fill("")],
    }));
  }, []);

  const removeRow = useCallback((ri: number) => {
    setDraft((prev) => ({ ...prev, rows: prev.rows.filter((_, i) => i !== ri) }));
  }, []);

  const addColumn = useCallback(() => {
    setDraft((prev) => ({
      columns: [...prev.columns, "새 열"],
      rows: prev.rows.map((r) => [...r, ""]),
    }));
  }, []);

  const removeColumn = useCallback((ci: number) => {
    setDraft((prev) => ({
      columns: prev.columns.filter((_, i) => i !== ci),
      rows: prev.rows.map((r) => r.filter((_, i) => i !== ci)),
    }));
  }, []);

  // ── 렌더 ──────────────────────────────────────────────────────────────────
  if (data === null) {
    return <div className="text-xs text-faint animate-pulse py-4">불러오는 중...</div>;
  }

  const display = editing ? draft : data;

  return (
    <section>
      {/* 섹션 헤더 */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-purple-400 uppercase tracking-widest">도메인 / 클래스 매핑</h2>
        {!editing ? (
          <button
            onClick={startEdit}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-muted hover:text-ink border border-line2 hover:border-gray-500 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            편집
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={cancelEdit}
              disabled={saving}
              className="px-3 py-1.5 rounded-lg text-xs text-muted hover:text-ink border border-line2 hover:border-gray-600 transition-colors disabled:opacity-50"
            >
              취소
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-purple-700 hover:bg-purple-600 text-white font-medium transition-colors disabled:opacity-50"
            >
              {saving ? (
                <span className="animate-spin inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full" />
              ) : (
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
              저장
            </button>
          </div>
        )}
      </div>

      {/* 테이블 */}
      <div className="border border-line2 rounded-lg overflow-auto">
        <table className="text-xs min-w-full">
          {/* 헤더 */}
          <thead>
            <tr className="bg-input/80 border-b border-line2">
              {/* 번호 컬럼 */}
              <th className="w-10 px-3 py-2.5 text-center text-faint font-medium select-none">#</th>

              {/* 데이터 컬럼 헤더 */}
              {display.columns.map((col, ci) => (
                <th key={ci} className="px-3 py-2 text-left font-medium text-muted min-w-[140px]">
                  {editing ? (
                    <div className="flex items-center gap-1 group/hd">
                      <input
                        value={draft.columns[ci]}
                        onChange={(e) => setHeader(ci, e.target.value)}
                        className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-ink font-medium placeholder:text-faint focus:outline-none focus:border-purple-500 min-w-0"
                      />
                      {draft.columns.length > 1 && (
                        <button
                          onClick={() => removeColumn(ci)}
                          title="열 삭제"
                          className="opacity-0 group-hover/hd:opacity-100 p-0.5 text-faint hover:text-red-400 transition-all flex-shrink-0"
                        >
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <svg className="w-3 h-3 text-faint flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" />
                      </svg>
                      {col}
                    </span>
                  )}
                </th>
              ))}

              {/* 열 추가 버튼 */}
              {editing && (
                <th className="w-10 px-2 py-2">
                  <button
                    onClick={addColumn}
                    title="열 추가"
                    className="w-6 h-6 flex items-center justify-center rounded text-faint hover:text-cyan-400 hover:bg-gray-700 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                    </svg>
                  </button>
                </th>
              )}
            </tr>
          </thead>

          {/* 바디 */}
          <tbody className="divide-y divide-line">
            {display.rows.map((row, ri) => (
              <tr key={ri} className="hover:bg-input/20 group/row transition-colors">
                {/* 번호 */}
                <td className="px-3 py-2 text-center text-faint select-none">
                  {editing ? (
                    <button
                      onClick={() => removeRow(ri)}
                      title="행 삭제"
                      className="opacity-0 group-hover/row:opacity-100 w-5 h-5 flex items-center justify-center mx-auto rounded text-faint hover:text-red-400 hover:bg-red-900/30 transition-all"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  ) : (
                    <span className="text-faint">{ri}</span>
                  )}
                </td>

                {/* 셀 */}
                {row.map((cell, ci) => (
                  <td key={ci} className="px-3 py-2 align-top">
                    {editing ? (
                      <textarea
                        value={draft.rows[ri][ci]}
                        onChange={(e) => setCell(ri, ci, e.target.value)}
                        rows={Math.max(1, (draft.rows[ri][ci] || "").split("\n").length)}
                        className="w-full bg-input/60 border border-line2 rounded px-2 py-1 text-xs text-gray-200 font-mono placeholder:text-faint focus:outline-none focus:border-purple-500 resize-none leading-relaxed min-w-[120px]"
                        placeholder="—"
                      />
                    ) : (
                      <span className={`block whitespace-pre-wrap leading-relaxed ${cell ? "text-ink2 font-mono" : "text-faint"}`}>
                        {cell || "—"}
                      </span>
                    )}
                  </td>
                ))}

                {/* 편집 모드 — 열 추가 자리 맞춤 */}
                {editing && <td />}
              </tr>
            ))}
          </tbody>
        </table>

        {/* 행 추가 */}
        {editing && (
          <div className="border-t border-line px-3 py-2">
            <button
              onClick={addRow}
              className="flex items-center gap-1.5 text-xs text-faint hover:text-cyan-400 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              행 추가
            </button>
          </div>
        )}
      </div>

      {/* 에러 */}
      {saveErr && (
        <p className="mt-2 text-xs text-red-400 bg-red-900/20 border border-red-800/40 rounded px-3 py-2">{saveErr}</p>
      )}
    </section>
  );
}
