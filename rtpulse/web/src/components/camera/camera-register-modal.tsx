"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Camera } from "@/lib/cameras";

interface ManualCamera {
  name: string;
  mainstream_url: string;
  substream_url: string;
  description: string;
  location: string;
}

const EMPTY_CAMERA: ManualCamera = {
  name: "",
  mainstream_url: "",
  substream_url: "",
  description: "",
  location: "",
};

type Tab = "manual" | "csv" | "list";

interface Props {
  customerId: string;
  onClose: () => void;
  onDone: (count: number) => void;
}

export default function CameraRegisterModal({ customerId, onClose, onDone }: Props) {
  const [tab, setTab] = useState<Tab>("manual");

  // --- 수동 입력 ---
  const [manual, setManual] = useState<ManualCamera>(EMPTY_CAMERA);

  // --- CSV ---
  const [csvText, setCsvText] = useState("");
  const [csvPreview, setCsvPreview] = useState<ManualCamera[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // --- 공통 ---
  const [register, setRegister] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- 등록 목록 ---
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchCameras = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetch(`/api/cameras/${customerId}`);
      setCameras(await res.json());
    } finally {
      setLoadingList(false);
    }
  }, [customerId]);

  useEffect(() => {
    if (tab === "list") fetchCameras();
  }, [tab, fetchCameras]);

  // --- CSV parsing ---
  function handleCsvFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setCsvText(text);
      parsePreview(text);
    };
    reader.readAsText(file);
  }

  function parsePreview(text: string) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const start =
      lines[0]?.toLowerCase().includes("이름") || lines[0]?.toLowerCase().includes("스트리밍") ? 1 : 0;
    const parsed = lines
      .slice(start)
      .map((line) => {
        const cols = line.split(",").map((c) => c.trim());
        return {
          name: cols[0] ?? "",
          mainstream_url: cols[1] ?? "",
          substream_url: cols[2] ?? "",
          description: cols[3] ?? "",
          location: "",
        };
      })
      .filter((c) => c.name && c.mainstream_url);
    setCsvPreview(parsed);
  }

  // --- 등록 ---
  async function handleSubmit() {
    setSaving(true);
    setError(null);
    try {
      const body =
        tab === "manual"
          ? { cameras: [manual], register }
          : { csv: csvText, register };

      const res = await fetch(`/api/cameras/${customerId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`서버 오류 ${res.status}`);
      const data = await res.json();
      onDone(data.saved?.length ?? 0);
    } catch (e: unknown) {
      setError(`오류: ${e instanceof Error ? e.message : String(e)}`);
      setSaving(false);
    }
  }

  // --- 삭제 ---
  async function handleDelete(cameraId: string) {
    if (!confirm("이 카메라를 삭제하시겠습니까?")) return;
    setDeletingId(cameraId);
    try {
      await fetch(`/api/cameras/${customerId}/${cameraId}`, { method: "DELETE" });
      setCameras((prev) => prev.filter((c) => c.id !== cameraId));
    } finally {
      setDeletingId(null);
    }
  }

  const canSubmit =
    tab === "manual"
      ? manual.name.trim() !== "" && manual.mainstream_url.trim() !== ""
      : csvPreview.length > 0;

  const TABS: { key: Tab; label: string }[] = [
    { key: "manual", label: "수동 입력" },
    { key: "csv",    label: "CSV 일괄 등록" },
    { key: "list",   label: "등록 목록" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-canvas border border-line rounded-xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line">
          <h2 className="text-base font-semibold text-ink">카메라 관리</h2>
          <button onClick={onClose} className="text-muted hover:text-ink text-xl leading-none">&times;</button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-line px-6">
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => { setTab(key); setError(null); }}
              className={`py-3 pr-6 text-sm font-medium border-b-2 transition-colors ${
                tab === key
                  ? "border-cyan-500 text-cyan-400"
                  : "border-transparent text-muted hover:text-ink2"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5">
          {/* ── 수동 입력 ── */}
          {tab === "manual" && (
            <div className="space-y-4">
              <Row label="카메라 이름 *">
                <Input placeholder="예: 차고지" value={manual.name}
                  onChange={(v) => setManual({ ...manual, name: v })} />
              </Row>
              <Row label="메인스트림 URL *" hint="분석 서버용 고화질 스트림">
                <Input placeholder="rtsp://admin:pass@192.0.2.10:554/h264"
                  value={manual.mainstream_url}
                  onChange={(v) => setManual({ ...manual, mainstream_url: v })} mono />
              </Row>
              <Row label="서브스트림 URL" hint="라이브 모니터링용 저화질 스트림">
                <Input placeholder="rtsp://admin:pass@192.0.2.10:554/h264-2"
                  value={manual.substream_url}
                  onChange={(v) => setManual({ ...manual, substream_url: v })} mono />
              </Row>
              <Row label="위치 (선택)">
                <Input placeholder="예: 본관 1층" value={manual.location}
                  onChange={(v) => setManual({ ...manual, location: v })} />
              </Row>
              <Row label="설명 (선택)">
                <Input placeholder="예: 정문 출입 감시용" value={manual.description}
                  onChange={(v) => setManual({ ...manual, description: v })} />
              </Row>
              <RegisterToggle value={register} onChange={setRegister} />
              {error && <p className="text-xs text-red-400">{error}</p>}
            </div>
          )}

          {/* ── CSV 일괄 등록 ── */}
          {tab === "csv" && (
            <div className="space-y-4">
              <div>
                <p className="text-xs text-faint mb-2">
                  CSV 형식:{" "}
                  <code className="text-muted">이름, 스트리밍 경로(rtsp://), 서브스트림 경로(rtsp://), 설명</code>
                </p>
                <div className="flex gap-2 items-center">
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="px-3 py-1.5 text-xs bg-input text-ink2 border border-line2 rounded-lg hover:bg-gray-700"
                  >
                    파일 선택
                  </button>
                  <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleCsvFile} className="hidden" />
                  {csvPreview.length > 0 && (
                    <span className="text-xs text-green-400">{csvPreview.length}개 카메라 파싱됨</span>
                  )}
                </div>
              </div>

              {csvPreview.length > 0 && (
                <div className="overflow-x-auto border border-line rounded-lg">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-input text-muted">
                        <th className="px-3 py-2 text-left">이름</th>
                        <th className="px-3 py-2 text-left">메인스트림</th>
                        <th className="px-3 py-2 text-left">서브스트림</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {csvPreview.slice(0, 10).map((c, i) => (
                        <tr key={i} className="hover:bg-input/40">
                          <td className="px-3 py-1.5 text-ink font-medium">{c.name}</td>
                          <td className="px-3 py-1.5 text-muted font-mono truncate max-w-[200px]">{c.mainstream_url}</td>
                          <td className="px-3 py-1.5 text-muted font-mono truncate max-w-[200px]">{c.substream_url || "—"}</td>
                        </tr>
                      ))}
                      {csvPreview.length > 10 && (
                        <tr>
                          <td colSpan={3} className="px-3 py-2 text-faint text-center">… 외 {csvPreview.length - 10}개</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              <RegisterToggle value={register} onChange={setRegister} />
              {error && <p className="text-xs text-red-400">{error}</p>}
            </div>
          )}

          {/* ── 등록 목록 ── */}
          {tab === "list" && (
            <div>
              {loadingList ? (
                <p className="text-xs text-faint py-4 text-center">불러오는 중...</p>
              ) : cameras.length === 0 ? (
                <p className="text-xs text-faint py-8 text-center">등록된 카메라가 없습니다.</p>
              ) : (
                <div className="space-y-2">
                  {cameras.map((cam) => (
                    <div
                      key={cam.id}
                      className="flex items-start justify-between gap-3 bg-panel border border-line rounded-lg px-4 py-3"
                    >
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-ink">{cam.name}</span>
                          {cam.location && (
                            <span className="text-xs text-faint">{cam.location}</span>
                          )}
                        </div>
                        <p className="text-xs text-blue-400/80 font-mono truncate">
                          <span className="text-faint mr-1">메인</span>{cam.mainstream_url}
                        </p>
                        {cam.substream_url && (
                          <p className="text-xs text-purple-400/80 font-mono truncate">
                            <span className="text-faint mr-1">서브</span>{cam.substream_url}
                          </p>
                        )}
                        {cam.description && (
                          <p className="text-xs text-faint">{cam.description}</p>
                        )}
                      </div>
                      <button
                        onClick={() => handleDelete(cam.id)}
                        disabled={deletingId === cam.id}
                        className="shrink-0 px-2.5 py-1 text-xs text-red-400 border border-red-900 rounded-lg hover:bg-red-950/50 disabled:opacity-40 transition-colors"
                      >
                        {deletingId === cam.id ? "삭제 중..." : "삭제"}
                      </button>
                    </div>
                  ))}
                  <p className="text-xs text-faint pt-1">총 {cameras.length}대</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer — 등록 목록 탭에서는 닫기만 */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-line">
          {tab === "list" ? (
            <button
              onClick={onClose}
              className="px-4 py-2 bg-input text-ink2 rounded-lg text-sm hover:bg-gray-700"
            >
              닫기
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 bg-input text-ink2 rounded-lg text-sm hover:bg-gray-700"
              >
                취소
              </button>
              <button
                onClick={handleSubmit}
                disabled={saving || !canSubmit}
                className="px-5 py-2 bg-cyan-700 text-white rounded-lg text-sm hover:bg-cyan-600 disabled:opacity-40"
              >
                {saving
                  ? "등록 중..."
                  : `등록${tab === "csv" && csvPreview.length > 0 ? ` (${csvPreview.length}대)` : ""}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function RegisterToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2.5 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 rounded accent-cyan-500"
      />
      <span className="text-sm text-muted">
        rtpulse에 즉시 등록{" "}
        <span className="text-faint">(메인/서브 스트림 모니터링 시작)</span>
      </span>
    </label>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm text-muted mb-1">
        {label}
        {hint && <span className="ml-2 text-xs text-faint">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

function Input({
  placeholder, value, onChange, mono,
}: {
  placeholder: string; value: string; onChange: (v: string) => void; mono?: boolean;
}) {
  return (
    <input
      type="text"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full px-3 py-2 bg-panel border border-line2 rounded-lg text-sm text-ink placeholder-gray-600 focus:outline-none focus:border-cyan-600 ${mono ? "font-mono text-xs" : ""}`}
    />
  );
}
