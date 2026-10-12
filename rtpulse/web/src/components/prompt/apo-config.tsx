"use client";

import { useState, useEffect } from "react";

export type ApoDbTab    = "vms" | "watch";
export type PeCategory  = "falldown_fire_smoke" | "esfalldown";

export interface VmsConn {
  host:        string;
  port:        string;
  user:        string;
  password:    string;
  dbName:      string;
  savePath:    string;
  peCategory:  PeCategory;
}

interface VmsConfig extends VmsConn {
  fnVideoPath: string;
}

interface WatchDbInfo {
  host:   string;
  port:   string;
  dbName: string;
  user:   string;
}

interface PromptRecord {
  id:           number;
  project_name: string;
  version:      string;
  nas_path:     string | null;
  applied_at:   string | null;
}

interface RemoteCustomer {
  id:          string;
  name:        string;
  networkType: string;
  vip?:        string;
  ip?:         string;
  dbPort?:     number;
  dbUser?:     string;
  dbPassword?: string;
  dbName?:     string;
}

const DEFAULT_VMS: VmsConfig = {
  host: "", port: "3306", user: "", password: "", dbName: "",
  savePath: "", fnVideoPath: "", peCategory: "falldown_fire_smoke",
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-input/20 border border-line rounded-xl p-5 space-y-4">
      <h3 className="text-[11px] font-semibold text-muted uppercase tracking-wider">{title}</h3>
      {children}
    </div>
  );
}

function Field({
  label, desc, value, onChange, placeholder, type = "text",
}: {
  label: string; desc?: string; value: string;
  onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-faint">{label}</label>
      {desc && <p className="text-[10px] text-faint opacity-60 -mt-0.5 leading-relaxed">{desc}</p>}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className="bg-input border border-line2 rounded-lg px-3 py-2 text-xs text-ink placeholder:text-faint/40 focus:outline-none focus:border-purple-600 transition-colors"
      />
    </div>
  );
}

function ReadField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-faint">{label}</label>
      <div className="bg-input/50 border border-line rounded-lg px-3 py-2 text-xs text-ink2 font-mono select-all">
        {value || "—"}
      </div>
    </div>
  );
}

// ─── Prompt JSON 선택기 ───────────────────────────────────────────────────────

function PromptJsonSelector({
  label = "JSON 경로 (선택)",
  value,
  onChange,
}: {
  label?:   string;
  value:    string;
  onChange: (path: string) => void;
}) {
  const [prompts,  setPrompts]  = useState<PromptRecord[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [selected, setSelected] = useState<number | "">("");

  useEffect(() => {
    fetch("/api/prompt-records")
      .then((r) => r.json())
      .then((list: PromptRecord[]) => {
        setPrompts(list);
        // 저장된 경로와 일치하는 항목 자동 선택
        if (value) {
          const match = list.find((p) => p.nas_path === value);
          if (match) setSelected(match.id);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelect = (idStr: string) => {
    if (!idStr) {
      setSelected("");
      onChange("");
      return;
    }
    const id = Number(idStr);
    setSelected(id);
    const found = prompts.find((p) => p.id === id);
    onChange(found?.nas_path ?? "");
  };

  const withPath  = prompts.filter((p) => p.nas_path);
  const noPath    = prompts.filter((p) => !p.nas_path);

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs text-faint">{label}</label>
      <p className="text-[10px] text-faint opacity-60 leading-relaxed">
        프롬프트 관리에 등록된 목록에서 선택하면 해당 NAS 저장경로를 APO에 전달합니다.
      </p>

      {loading ? (
        <div className="bg-input border border-line2 rounded-lg px-3 py-2 text-xs text-faint animate-pulse">
          프롬프트 목록 불러오는 중...
        </div>
      ) : (
        <select
          value={String(selected)}
          onChange={(e) => handleSelect(e.target.value)}
          className="bg-input border border-line2 rounded-lg px-3 py-2 text-xs text-ink focus:outline-none focus:border-purple-600 transition-colors"
        >
          <option value="">— 프롬프트 선택 —</option>
          {withPath.length > 0 && (
            <optgroup label="JSON 업로드됨">
              {withPath.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.project_name}  v{p.version}
                  {p.applied_at ? `  (적용: ${p.applied_at.slice(0, 10)})` : ""}
                </option>
              ))}
            </optgroup>
          )}
          {noPath.length > 0 && (
            <optgroup label="JSON 미업로드">
              {noPath.map((p) => (
                <option key={p.id} value={p.id} disabled>
                  {p.project_name}  v{p.version}  (경로 없음)
                </option>
              ))}
            </optgroup>
          )}
        </select>
      )}

      {/* 선택된 경로 표시 */}
      {value ? (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-900/20 border border-green-800/40">
          <svg className="w-3 h-3 text-green-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          <span className="text-[10px] font-mono text-green-300 break-all">{value}</span>
        </div>
      ) : (
        <p className="text-[10px] text-faint opacity-50">선택 시 NAS JSON 경로가 표시됩니다.</p>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ApoConfig({
  onConnect,
}: {
  onConnect: (tab: ApoDbTab, vmsConn?: VmsConn, customerId?: string, dateRange?: { startDate?: string; endDate?: string }) => void;
}) {
  const [tab,             setTab]             = useState<ApoDbTab>("vms");
  const [vms,            setVms]            = useState<VmsConfig>(DEFAULT_VMS);
  const [jsonPath,        setJsonPath]        = useState("");
  const [watchInfo,       setWatchInfo]       = useState<WatchDbInfo | null>(null);
  const [allCustomers,    setAllCustomers]    = useState<RemoteCustomer[]>([]);  // Watch DB 필터용 전체
  const [remoteCustomers, setRemoteCustomers] = useState<RemoteCustomer[]>([]);  // VMS DB 원격 전용
  const [selectedCustId,  setSelectedCustId]  = useState("");   // VMS DB 고객사
  const [watchCustId,     setWatchCustId]     = useState("");   // Watch DB 고객사 필터
  const [startDate,       setStartDate]       = useState("");   // 접속(build) 조회 범위 시작
  const [endDate,         setEndDate]         = useState("");   // 접속(build) 조회 범위 종료
  const [connecting,      setConnecting]      = useState(false);
  const [saved,           setSaved]           = useState(false);
  const [error,           setError]           = useState("");

  // localStorage에서 설정 복원 — 경로/카테고리만. 고객사·DB 접속정보는
  // 복원하지 않아 매번 "고객사 선택"부터 시작한다(특정 고객사에 고정되지 않도록).
  useEffect(() => {
    try {
      const s = localStorage.getItem("apo-vms-config");
      if (s) {
        const parsed = JSON.parse(s);
        setVms((prev) => ({
          ...prev,
          savePath:    parsed.savePath    ?? prev.savePath,
          fnVideoPath: parsed.fnVideoPath ?? prev.fnVideoPath,
          peCategory:  parsed.peCategory  ?? prev.peCategory,
        }));
        if (parsed.jsonPath) setJsonPath(parsed.jsonPath);
      }
    } catch { /* ignore */ }
  }, []);

  // 고객사 목록 로드
  useEffect(() => {
    fetch("/api/customers")
      .then((r) => r.json())
      .then((list: RemoteCustomer[]) => {
        setAllCustomers(list);
        setRemoteCustomers(list.filter((c) => (c.networkType ?? "remote") === "remote"));
      })
      .catch(console.error);
  }, []);

  // Watch DB 정보 로드
  useEffect(() => {
    fetch("/api/apo/db-info")
      .then((r) => r.json())
      .then(setWatchInfo)
      .catch(console.error);
  }, []);

  // 고객사 선택 → DB 접속 정보 자동 입력
  const handleCustomerSelect = (id: string) => {
    setSelectedCustId(id);
    if (!id) return;
    const cust = remoteCustomers.find((c) => c.id === id);
    if (!cust) return;
    setVms((prev) => ({
      ...prev,
      host:     cust.vip ?? cust.ip ?? "",
      port:     String(cust.dbPort ?? 3306),
      user:     cust.dbUser     ?? "ops",
      password: cust.dbPassword ?? "",
      dbName:   cust.dbName     ?? "",
    }));
  };

  const setM = (key: keyof VmsConfig) => (v: string) =>
    setVms((p) => ({ ...p, [key]: v }));

  const handleSave = () => {
    const { password: _, ...rest } = vms;
    localStorage.setItem("apo-vms-config", JSON.stringify({ ...rest, jsonPath, selectedCustId, watchCustId }));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleConnect = async () => {
    setConnecting(true);
    setError("");
    try {
      if (tab === "vms") {
        if (!vms.host || !vms.user || !vms.dbName) {
          throw new Error("고객사를 선택하거나 Host, User, DB 이름을 입력하세요.");
        }
        const res = await fetch("/api/apo/vms/connections", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            host:       vms.host,
            port:       vms.port,
            user:       vms.user,
            password:   vms.password,
            dbName:     vms.dbName,
            savePath:   vms.savePath,
            // 접속 시 copy_camera_events 빌드/썸네일 검증 범위 제한(데이터 과다 대응)
            // APO 백엔드는 camelCase(startDate/endDate)로 받음
            startDate:  startDate || undefined,
            endDate:    endDate   || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? "VMS DB 연결 실패");
        const { fnVideoPath: __, password: _pw, ...rest } = vms;
        localStorage.setItem("apo-vms-config", JSON.stringify({ ...rest, jsonPath, selectedCustId, watchCustId }));
        const vmsConn: VmsConn = {
          host: vms.host, port: vms.port, user: vms.user,
          password: vms.password, dbName: vms.dbName,
          savePath: vms.savePath, peCategory: vms.peCategory,
        };
        // 접속 시 지정한 조회 범위를 목록 필터로 이어줌(endDate는 원본 값 — 목록 쿼리가 당일 포함 처리)
        onConnect("vms", vmsConn, selectedCustId || undefined, { startDate: startDate || undefined, endDate: endDate || undefined });
      } else {
        if (!vms.savePath) throw new Error("저장 경로는 필수입니다.");
        const res = await fetch("/api/apo/watch/connections", { method: "POST" });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? "Watch DB 연결 실패");
        const { password: _, ...rest } = vms;
        localStorage.setItem("apo-vms-config", JSON.stringify({ ...rest, jsonPath, selectedCustId, watchCustId }));
        onConnect("watch", undefined, watchCustId || undefined);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">

      {/* 헤더 */}
      <div>
        <h2 className="text-sm font-bold text-ink">DB 연결 설정</h2>
        <p className="text-xs text-faint mt-1">
          APO에서 사용할 DB 접속 방식을 선택하고 정보를 입력하세요.
        </p>
      </div>

      {/* 탭 */}
      <div className="flex gap-1 bg-input/40 p-1 rounded-xl w-fit">
        {(["vms", "watch"] as ApoDbTab[]).map((key) => (
          <button
            key={key}
            onClick={() => { setTab(key); setError(""); }}
            className={`px-6 py-2 rounded-lg text-xs font-semibold transition-colors ${
              tab === key
                ? "bg-purple-700 text-white shadow-sm"
                : "text-muted hover:text-ink"
            }`}
          >
            {key === "vms" ? "VMS DB" : "Watch DB"}
          </button>
        ))}
      </div>

      {/* ── VMS DB 폼 ── */}
      {tab === "vms" && (
        <div className="space-y-4">
          <Section title="DB 접속 정보">
            {/* 고객사 선택 드롭다운 */}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-faint">원격 고객사 선택</label>
              <p className="text-[10px] text-faint opacity-60 leading-relaxed">
                선택하면 해당 고객사의 VMS DB 접속 정보가 자동으로 입력됩니다.
              </p>
              <select
                value={selectedCustId}
                onChange={(e) => handleCustomerSelect(e.target.value)}
                className="bg-input border border-line2 rounded-lg px-3 py-2 text-xs text-ink focus:outline-none focus:border-purple-600 transition-colors"
              >
                <option value="">— 고객사 선택 —</option>
                {remoteCustomers.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>

            {/* 구분선 */}
            <div className="flex items-center gap-2">
              <div className="flex-1 border-t border-line" />
              <span className="text-[10px] text-faint">또는 직접 입력</span>
              <div className="flex-1 border-t border-line" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Host" value={vms.host} onChange={setM("host")} placeholder="192.0.2.100" />
              <Field label="Port" value={vms.port} onChange={setM("port")} placeholder="3306" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="User"     value={vms.user}     onChange={setM("user")}     placeholder="root" />
              <Field label="Password" value={vms.password} onChange={setM("password")} placeholder="••••••••" type="password" />
            </div>
            <Field label="DB 이름" value={vms.dbName} onChange={setM("dbName")} placeholder="vmsdb" />
          </Section>

          <Section title="조회 범위 (선택)">
            <p className="text-[10px] text-faint opacity-60 -mt-1 leading-relaxed">
              접속 시 이 기간의 이벤트만 copy_camera_events로 빌드·썸네일 검증합니다. 비우면 전체(느릴 수 있음).
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-faint">시작일</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="bg-input border border-line2 rounded-lg px-3 py-2 text-xs text-ink focus:outline-none focus:border-purple-600 transition-colors"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-faint">종료일</label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="bg-input border border-line2 rounded-lg px-3 py-2 text-xs text-ink focus:outline-none focus:border-purple-600 transition-colors"
                />
              </div>
            </div>
          </Section>

          <Section title="경로 설정">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-faint">PE 카테고리 (필수)</label>
              <select
                value={vms.peCategory}
                onChange={(e) => setVms((p) => ({ ...p, peCategory: e.target.value as PeCategory }))}
                className="bg-input border border-line2 rounded-lg px-3 py-2 text-xs text-ink focus:outline-none focus:border-purple-600 transition-colors"
              >
                <option value="falldown_fire_smoke">falldown_fire_smoke</option>
                <option value="esfalldown">esfalldown</option>
              </select>
            </div>
            <Field
              label="저장 경로 (필수)"
              desc="NAS 경로로 입력하세요. 예: /rtpulse/apo/{폴더명} (APO 전송 시 /mnt 자동 부여)"
              value={vms.savePath}
              onChange={setM("savePath")}
              placeholder="/rtpulse/apo/apo_test"
            />
            <Field
              label="미탐영상 경로 (선택)"
              desc="NAS에 저장된 미탐(FN) 영상이 모여있는 폴더 경로"
              value={vms.fnVideoPath}
              onChange={setM("fnVideoPath")}
              placeholder="/rtpulse/apo/fn_videos"
            />
            <PromptJsonSelector label="JSON 경로 (선택)" value={jsonPath} onChange={setJsonPath} />
          </Section>
        </div>
      )}

      {/* ── Watch DB 폼 ── */}
      {tab === "watch" && (
        <div className="space-y-4">
          <Section title="고객사 필터">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-faint">고객사 선택</label>
              <p className="text-[10px] text-faint opacity-60 leading-relaxed">
                선택한 고객사의 이벤트만 표시합니다. 미선택 시 전체 고객사 데이터를 불러옵니다.
              </p>
              <select
                value={watchCustId}
                onChange={(e) => setWatchCustId(e.target.value)}
                className="bg-input border border-line2 rounded-lg px-3 py-2 text-xs text-ink focus:outline-none focus:border-purple-600 transition-colors"
              >
                <option value="">— 전체 고객사 —</option>
                {allCustomers.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          </Section>

          <Section title="rtpulse DB 연결 정보">
            <p className="text-xs text-faint -mt-1">
              Watch 서버 환경변수에서 자동으로 읽어옵니다. 접속 후 APO 백엔드에 이 정보를 제공합니다.
            </p>
            {watchInfo ? (
              <div className="grid grid-cols-2 gap-3">
                <ReadField label="Host"    value={watchInfo.host} />
                <ReadField label="Port"    value={watchInfo.port} />
                <ReadField label="DB 이름" value={watchInfo.dbName} />
                <ReadField label="User"    value={watchInfo.user} />
              </div>
            ) : (
              <p className="text-xs text-faint animate-pulse">DB 정보 불러오는 중...</p>
            )}
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-purple-900/20 border border-purple-800/40 text-xs text-purple-300 leading-relaxed">
              <svg className="w-3.5 h-3.5 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>
                접속 후 <code className="text-purple-200">rtpulse.copy_camera_events</code> 테이블의 이벤트 목록을 표시합니다.
              </span>
            </div>
          </Section>

          <Section title="경로 설정">
            <Field
              label="저장 경로 (필수)"
              desc="NAS 경로로 입력하세요. 예: /rtpulse/apo/{폴더명} (APO 전송 시 /mnt 자동 부여)"
              value={vms.savePath}
              onChange={setM("savePath")}
              placeholder="/rtpulse/apo/apo_test"
            />
            <Field
              label="미탐영상 경로 (선택)"
              desc="NAS에 저장된 미탐(FN) 영상이 모여있는 폴더 경로"
              value={vms.fnVideoPath}
              onChange={setM("fnVideoPath")}
              placeholder="/rtpulse/apo/fn_videos"
            />
            <PromptJsonSelector label="JSON 경로 (선택)" value={jsonPath} onChange={setJsonPath} />
          </Section>
        </div>
      )}

      {/* 에러 */}
      {error && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-red-900/20 border border-red-800/40 text-xs text-red-400">
          <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {error}
        </div>
      )}

      {/* 액션 버튼 */}
      <div className="flex items-center gap-3 pt-1">
        {tab === "vms" && (
          <button
            onClick={handleSave}
            className="px-5 py-2 rounded-lg text-xs border border-line2 text-muted hover:text-ink hover:border-gray-600 transition-colors"
          >
            {saved ? "✓ 저장됨" : "저장"}
          </button>
        )}
        <button
          onClick={handleConnect}
          disabled={connecting}
          className="px-7 py-2 rounded-lg text-xs bg-purple-700 hover:bg-purple-600 text-white font-semibold transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          {connecting ? (
            <>
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              접속 중...
            </>
          ) : "접속"}
        </button>
      </div>
    </div>
  );
}
