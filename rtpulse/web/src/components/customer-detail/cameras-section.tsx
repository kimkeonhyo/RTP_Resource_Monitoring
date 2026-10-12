"use client";

/**
 * 6. 카메라 목록
 *
 * PostgreSQL cameras 테이블을 단일 권위 소스로 사용합니다.
 * - 카메라 목록:   GET    /api/cameras/{customerId}        (PostgreSQL)
 * - 활성화 토글:   PUT    /api/cameras/{customerId}/{id}   (PostgreSQL)
 * - 메타 수정:     PUT    /api/cameras/{customerId}/{id}   (PostgreSQL)
 * - 삭제:          DELETE /api/cameras/{customerId}/{id}   (PostgreSQL → rtpulse 즉시 + 30s 폴러 백업)
 * - 실시간 지표:   GET    /api/proxy/{customerId}/api/streams (rtpulse, best-effort — 없어도 목록 표시)
 */

import { useState, useEffect, useCallback } from "react";

// ── 타입 ──────────────────────────────────────────────────────────────────────

interface Camera {
  id: string;
  name: string;
  mainstream_url: string;
  substream_url: string;
  location?: string;
  description?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RtStream {
  url: string;
  health: string;
  bitrate_kbps: number;
  packet_loss_pct: number;
  fps: number;
}

/** Camera + rtpulse 실시간 지표 병합 뷰 */
interface CameraRow extends Camera {
  mainHealth?: string;
  mainBitrate?: number;
  mainLoss?: number;
  subHealth?: string;
}

interface EditDraft {
  name: string;
  location: string;
  description: string;
}

// ── 상수 ──────────────────────────────────────────────────────────────────────

const HEALTH_TEXT: Record<string, string> = {
  HEALTHY:  "text-green-400",
  DEGRADED: "text-yellow-400",
  DOWN:     "text-red-400",
  UNKNOWN:  "text-faint",
};

const HEALTH_ICON: Record<string, string> = {
  HEALTHY:  "●",
  DEGRADED: "▲",
  DOWN:     "✖",
  UNKNOWN:  "○",
};

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export default function CamerasSection({ customerId }: { customerId: string }) {
  const [rows, setRows]             = useState<CameraRow[]>([]);
  const [loading, setLoading]       = useState(true);
  const [rtError, setRtError]       = useState(false);   // rtpulse 연결 실패 여부
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [search, setSearch]         = useState("");

  const [deletingId, setDeletingId]   = useState<string | null>(null);
  const [togglingId, setTogglingId]   = useState<string | null>(null);
  const [editingId, setEditingId]     = useState<string | null>(null);
  const [editDraft, setEditDraft]     = useState<EditDraft | null>(null);
  const [savingId, setSavingId]       = useState<string | null>(null);

  // ── 데이터 로드 ──────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    setRtError(false);
    try {
      // 1. PostgreSQL — 권위 소스 (필수)
      const dbRes = await fetch(`/api/cameras/${customerId}`);
      if (!dbRes.ok) throw new Error(`카메라 목록 조회 실패 (${dbRes.status})`);
      const cameras: Camera[] = await dbRes.json();

      // 2. rtpulse 실시간 지표 — best-effort (실패해도 목록은 표시)
      let rtStreams: RtStream[] = [];
      try {
        const rtRes = await fetch(`/api/proxy/${customerId}/api/streams`, {
          signal: AbortSignal.timeout(4000),
        });
        if (rtRes.ok) {
          rtStreams = await rtRes.json();
        } else {
          setRtError(true);
        }
      } catch {
        setRtError(true);
      }

      // 3. URL 기준으로 rtpulse 지표 매핑
      const metricsByUrl = new Map<string, RtStream>();
      for (const s of rtStreams) metricsByUrl.set(s.url, s);

      // 4. 병합
      setRows(
        cameras.map((cam) => {
          const main = metricsByUrl.get(cam.mainstream_url);
          const sub  = metricsByUrl.get(cam.substream_url);
          return {
            ...cam,
            mainHealth:  main?.health,
            mainBitrate: main?.bitrate_kbps,
            mainLoss:    main?.packet_loss_pct,
            subHealth:   sub?.health,
          };
        })
      );
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : "데이터를 불러올 수 없습니다");
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── 활성화 토글 ──────────────────────────────────────────────────────────────

  async function handleToggleEnabled(cam: CameraRow) {
    setTogglingId(cam.id);
    try {
      const res = await fetch(`/api/cameras/${customerId}/${cam.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !cam.enabled }),
      });
      if (!res.ok) throw new Error("토글 실패");
      const updated: Camera = await res.json();
      setRows((prev) =>
        prev.map((r) => (r.id === cam.id ? { ...r, enabled: updated.enabled } : r))
      );
    } catch {
      alert("상태 변경에 실패했습니다.");
    } finally {
      setTogglingId(null);
    }
  }

  // ── 삭제 ─────────────────────────────────────────────────────────────────────

  async function handleDelete(cam: CameraRow) {
    if (!confirm(`"${cam.name}" 카메라를 삭제하시겠습니까?\nDB에서 삭제되며 rtpulse에서도 30초 내에 자동 제거됩니다.`))
      return;
    setDeletingId(cam.id);
    try {
      await fetch(`/api/cameras/${customerId}/${cam.id}`, { method: "DELETE" });
      setRows((prev) => prev.filter((r) => r.id !== cam.id));
    } finally {
      setDeletingId(null);
    }
  }

  // ── 편집 ─────────────────────────────────────────────────────────────────────

  function startEdit(cam: CameraRow) {
    setEditingId(cam.id);
    setEditDraft({
      name:        cam.name,
      location:    cam.location    ?? "",
      description: cam.description ?? "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft(null);
  }

  async function handleSave(cam: CameraRow) {
    if (!editDraft) return;
    setSavingId(cam.id);
    try {
      const res = await fetch(`/api/cameras/${customerId}/${cam.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name:        editDraft.name.trim()        || cam.name,
          location:    editDraft.location.trim()    || null,
          description: editDraft.description.trim() || null,
        }),
      });
      if (!res.ok) throw new Error("저장 실패");
      const updated: Camera = await res.json();
      setRows((prev) =>
        prev.map((r) =>
          r.id === cam.id
            ? { ...r, name: updated.name, location: updated.location, description: updated.description }
            : r
        )
      );
      setEditingId(null);
      setEditDraft(null);
    } catch {
      alert("저장에 실패했습니다.");
    } finally {
      setSavingId(null);
    }
  }

  // ── 필터 ─────────────────────────────────────────────────────────────────────

  const filtered = rows.filter(
    (r) =>
      !search ||
      r.name.toLowerCase().includes(search.toLowerCase()) ||
      (r.location ?? "").toLowerCase().includes(search.toLowerCase()) ||
      r.mainstream_url.toLowerCase().includes(search.toLowerCase())
  );

  // ── 렌더 ─────────────────────────────────────────────────────────────────────

  const inputCls =
    "w-full px-2 py-1 bg-input border border-line2 rounded text-xs text-ink placeholder-gray-600 focus:outline-none focus:border-cyan-600";

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="text"
          placeholder="이름 · 위치 · URL 검색..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-1.5 bg-panel border border-line rounded-lg text-xs text-ink placeholder-gray-600 focus:outline-none focus:border-cyan-700 w-56"
        />
        <button
          onClick={fetchData}
          disabled={loading}
          className="px-3 py-1.5 text-xs bg-input border border-line2 text-muted hover:text-cyan-400 hover:border-cyan-800 rounded-lg transition-colors disabled:opacity-40"
        >
          {loading ? "로딩 중..." : "↻ 새로고침"}
        </button>

        {/* rtpulse 연결 상태 배지 */}
        <span className={`text-xs px-2 py-0.5 rounded-full border ${
          rtError
            ? "text-yellow-500 border-yellow-900 bg-yellow-950/20"
            : "text-green-500 border-green-900 bg-green-950/20"
        }`}>
          {rtError ? "rtpulse 미연결 (목록만 표시)" : "rtpulse 연결됨"}
        </span>

        <span className="text-xs text-faint ml-auto">
          {filtered.length}개 {search && `/ 전체 ${rows.length}개`}
        </span>
      </div>

      {/* Fetch error */}
      {fetchError && (
        <div className="py-4 text-center text-red-400 text-xs border border-red-900/30 rounded-xl bg-red-950/10">
          ⚠ {fetchError}
        </div>
      )}

      {/* List */}
      {!fetchError && (
        loading ? (
          <p className="text-xs text-faint py-6 text-center">불러오는 중...</p>
        ) : rows.length === 0 ? (
          <div className="py-10 text-center text-faint border border-dashed border-line rounded-xl">
            <p className="text-sm">등록된 카메라가 없습니다</p>
            <p className="text-xs mt-1 text-faint">카메라 관리 버튼으로 추가하세요</p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-faint py-6 text-center">검색 결과 없음</p>
        ) : (
          <div className="bg-panel border border-line rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-input/80 text-muted uppercase text-[10px] tracking-wider">
                  <th className="px-4 py-2 text-left">상태</th>
                  <th className="px-4 py-2 text-left">카메라명</th>
                  <th className="px-4 py-2 text-left">위치</th>
                  <th className="px-4 py-2 text-left">URL</th>
                  <th className="px-4 py-2 text-left">비트레이트</th>
                  <th className="px-3 py-2 text-center">활성</th>
                  <th className="px-3 py-2 w-28" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filtered.map((row) =>
                  editingId === row.id && editDraft ? (
                    /* ── 편집 행 ── */
                    <tr key={row.id} className="bg-input/60">
                      <td className="px-4 py-2">
                        <HealthBadge health={row.mainHealth} />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          className={inputCls}
                          value={editDraft.name}
                          onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
                          placeholder="카메라 이름"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          className={inputCls}
                          value={editDraft.location}
                          onChange={(e) => setEditDraft({ ...editDraft, location: e.target.value })}
                          placeholder="위치"
                        />
                      </td>
                      <td className="px-4 py-2">
                        <div className="font-mono text-[10px] text-blue-400/60 truncate max-w-[180px]">{row.mainstream_url}</div>
                        {row.substream_url && (
                          <div className="font-mono text-[10px] text-purple-400/40 truncate max-w-[180px] mt-0.5">{row.substream_url}</div>
                        )}
                      </td>
                      <td className="px-4 py-2" colSpan={1}>
                        <input
                          className={inputCls}
                          value={editDraft.description}
                          onChange={(e) => setEditDraft({ ...editDraft, description: e.target.value })}
                          placeholder="설명"
                        />
                      </td>
                      <td className="px-3 py-2 text-center">—</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button
                          onClick={() => handleSave(row)}
                          disabled={savingId === row.id}
                          className="px-2 py-1 text-cyan-400 hover:bg-cyan-950/50 rounded text-[11px] transition-colors disabled:opacity-40"
                        >
                          {savingId === row.id ? "저장 중..." : "저장"}
                        </button>
                        <button
                          onClick={cancelEdit}
                          className="px-2 py-1 text-muted hover:text-ink2 rounded text-[11px] transition-colors ml-1"
                        >
                          취소
                        </button>
                      </td>
                    </tr>
                  ) : (
                    /* ── 일반 행 ── */
                    <tr
                      key={row.id}
                      className={`group transition-colors ${
                        row.enabled ? "hover:bg-input/40" : "opacity-40 hover:bg-input/20"
                      }`}
                    >
                      {/* 상태 */}
                      <td className="px-4 py-2.5">
                        <div className="flex flex-col gap-0.5">
                          <HealthBadge health={row.mainHealth} label="메인" />
                          {row.substream_url && <HealthBadge health={row.subHealth} label="서브" />}
                        </div>
                      </td>

                      {/* 카메라명 */}
                      <td className="px-4 py-2.5">
                        <span className="font-medium text-ink">{row.name}</span>
                        {row.description && (
                          <p className="text-[10px] text-faint mt-0.5 truncate max-w-[120px]">{row.description}</p>
                        )}
                      </td>

                      {/* 위치 */}
                      <td className="px-4 py-2.5 text-faint">{row.location || "—"}</td>

                      {/* URL */}
                      <td className="px-4 py-2.5">
                        <div className="font-mono text-[10px] text-blue-400/80 truncate max-w-[180px]">
                          <span className="text-faint mr-1">M</span>{row.mainstream_url}
                        </div>
                        {row.substream_url && (
                          <div className="font-mono text-[10px] text-purple-400/60 truncate max-w-[180px] mt-0.5">
                            <span className="text-faint mr-1">S</span>{row.substream_url}
                          </div>
                        )}
                      </td>

                      {/* 비트레이트 */}
                      <td className="px-4 py-2.5 text-muted">
                        {row.mainBitrate !== undefined ? (
                          <span>{row.mainBitrate.toFixed(0)} kbps</span>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                        {row.mainLoss !== undefined && row.mainLoss > 0 && (
                          <span className="text-red-400 ml-1 text-[10px]">
                            -{row.mainLoss.toFixed(1)}%
                          </span>
                        )}
                      </td>

                      {/* 활성 토글 */}
                      <td className="px-3 py-2.5 text-center">
                        <button
                          onClick={() => handleToggleEnabled(row)}
                          disabled={togglingId === row.id}
                          title={row.enabled ? "비활성화" : "활성화"}
                          className={`w-8 h-4 rounded-full transition-colors relative disabled:opacity-40 ${
                            row.enabled ? "bg-cyan-600" : "bg-gray-700"
                          }`}
                        >
                          <span className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${
                            row.enabled ? "right-0.5" : "left-0.5"
                          }`} />
                        </button>
                      </td>

                      {/* 액션 */}
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <button
                          onClick={() => startEdit(row)}
                          className="opacity-0 group-hover:opacity-100 px-2 py-1 text-cyan-500 hover:bg-cyan-950/50 rounded transition-all text-[11px] mr-1"
                        >
                          편집
                        </button>
                        <button
                          onClick={() => handleDelete(row)}
                          disabled={deletingId === row.id}
                          className="opacity-0 group-hover:opacity-100 px-2 py-1 text-red-500 hover:bg-red-950/50 rounded transition-all disabled:opacity-30 text-[11px]"
                        >
                          {deletingId === row.id ? "삭제 중..." : "삭제"}
                        </button>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
            <div className="px-4 py-2 border-t border-line text-[10px] text-faint flex items-center justify-between">
              <span>총 {rows.length}대 (DB 기준)</span>
              <span>삭제 시 rtpulse에서도 자동 제거됩니다 (최대 30초)</span>
            </div>
          </div>
        )
      )}
    </div>
  );
}

// ── 서브 컴포넌트 ─────────────────────────────────────────────────────────────

function HealthBadge({ health, label }: { health?: string; label?: string }) {
  const h = health ?? "UNKNOWN";
  return (
    <span className={`text-[10px] ${HEALTH_TEXT[h] ?? "text-faint"}`}>
      {HEALTH_ICON[h] ?? "○"}
      {label && <span className="ml-0.5 text-faint">{label}</span>}
    </span>
  );
}
