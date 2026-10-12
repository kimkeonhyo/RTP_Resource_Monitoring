"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { NetworkType } from "@/lib/types";

const DEFAULT_RTPULSE_PORT = 9999;
const DEFAULT_DB_PORT = 3306;
const DEFAULT_DB_USER = "ops";

export default function NewCustomerPage() {
  const router = useRouter();
  const [networkType, setNetworkType] = useState<NetworkType>("remote");
  const [form, setForm] = useState({
    name: "",
    ip: "",
    rtpulsePort: String(DEFAULT_RTPULSE_PORT),
    timezone: "Asia/Seoul",
    description: "",
    slackWebhook: "",
    vip: "",
    dbName: "",
    dbPort: String(DEFAULT_DB_PORT),
    dbUser: DEFAULT_DB_USER,
    dbPassword: "",
    sshUser: "",
    sshPassword: "",
    nasPath: "/rtpulse",
    metricsLabel: "",
  });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const apiUrl = form.ip ? `http://${form.ip}:${form.rtpulsePort || DEFAULT_RTPULSE_PORT}` : "";

  async function testConnection() {
    if (!apiUrl) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`${apiUrl}/api/info`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const info = await res.json();
      setTestResult({ ok: true, msg: `연결 성공 — rtpulse v${info.version}, 스트림 ${info.stream_count}개` });
    } catch (e: unknown) {
      setTestResult({ ok: false, msg: `연결 실패: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setTesting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (networkType === "remote" && !form.ip) return alert("서버 IP를 입력하세요.");
    setSaving(true);
    try {
      const computedApiUrl = networkType === "remote"
        ? `http://${form.ip}:${form.rtpulsePort || DEFAULT_RTPULSE_PORT}`
        : `http://${form.vip || "0.0.0.0"}:${DEFAULT_RTPULSE_PORT}`; // onprem은 dummy URL

      const payload = {
        name: form.name,
        networkType,
        apiUrl: computedApiUrl,
        ip: networkType === "remote" ? form.ip : undefined,
        rtpulsePort: networkType === "remote" ? (Number(form.rtpulsePort) || DEFAULT_RTPULSE_PORT) : undefined,
        timezone: form.timezone || "Asia/Seoul",
        description: form.description,
        slackWebhook: networkType === "remote" ? form.slackWebhook : undefined,
        vip: form.vip,
        dbName: form.dbName,
        dbPort: Number(form.dbPort) || DEFAULT_DB_PORT,
        dbUser: form.dbUser || DEFAULT_DB_USER,
        dbPassword: form.dbPassword,
        sshUser: form.sshUser || form.dbUser || DEFAULT_DB_USER,
        sshPassword: form.sshPassword,
        nasPath: form.nasPath || "/rtpulse",
        metricsLabel: form.metricsLabel.trim() || undefined,
      };

      const res = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("저장 실패");
      const customer = await res.json();

      if (networkType === "remote" && form.slackWebhook.trim()) {
        await fetch(`/api/proxy/${customer.id}/api/alerts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slack_webhook: form.slackWebhook.trim() }),
        }).catch(() => {});
      }

      router.push("/");
      router.refresh();
    } catch (err) {
      alert(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-xl font-bold text-ink mb-1">고객사 등록</h1>
      <p className="text-sm text-faint mb-6">고객사 유형을 선택하고 정보를 입력하세요.</p>

      <form onSubmit={handleSubmit} className="space-y-6">

        {/* 네트워크 유형 선택 */}
        <Section title="네트워크 유형">
          <div className="grid grid-cols-2 gap-3">
            <TypeCard
              selected={networkType === "remote"}
              onClick={() => setNetworkType("remote")}
              icon="◉"
              label="원격 고객사"
              desc="VPN/Headscale로 연결된 원격 서버 (rtpulse 스트림 모니터링)"
              color="cyan"
            />
            <TypeCard
              selected={networkType === "onprem"}
              onClick={() => setNetworkType("onprem")}
              icon="◈"
              label="폐쇄망 고객사"
              desc="망분리 환경 (데이터 추출 스크립트 + NAS 업로드)"
              color="amber"
            />
          </div>
        </Section>

        {/* 기본 정보 */}
        <Section title="기본 정보">
          <Field label="고객사 이름 *" placeholder="예: (주)예시고객" value={form.name}
            onChange={(v) => setForm({ ...form, name: v })} required />
          <Field label="설명 (선택)" placeholder="예: 물류센터 CCTV 모니터링" value={form.description}
            onChange={(v) => setForm({ ...form, description: v })} />
          <TimezoneSelect value={form.timezone} onChange={(v) => setForm({ ...form, timezone: v })} />
        </Section>

        {/* 온프레미스 서버 IP (관리용) */}
        {networkType === "onprem" && (
          <Section title="서버 정보 (관리용)">
            <Field label="서버 IP" placeholder="예: 192.0.2.10" value={form.ip}
              onChange={(v) => setForm({ ...form, ip: v })} />
            <p className="text-xs text-faint mt-1">
              고객사 서버 IP — 망분리 환경에서 통신은 불가하지만 관리 기록용으로 저장됩니다.
            </p>
          </Section>
        )}

        {/* 서버 연결 — 원격 고객사만 */}
        {networkType === "remote" && (
          <Section title="서버 연결 (rtpulse)">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Field label="서버 IP *" placeholder="예: 192.0.2.10" value={form.ip}
                  onChange={(v) => { setForm({ ...form, ip: v }); setTestResult(null); }} required />
              </div>
              <Field label="rtpulse 포트" placeholder="9999" value={form.rtpulsePort}
                onChange={(v) => setForm({ ...form, rtpulsePort: v })} />
            </div>
            <div className="flex items-center gap-3 mt-2">
              {apiUrl && <span className="text-xs text-faint font-mono">{apiUrl}</span>}
              <button type="button" onClick={testConnection} disabled={!apiUrl || testing}
                className="px-3 py-1.5 text-xs bg-input text-cyan-400 border border-line2 rounded-lg hover:bg-gray-700 disabled:opacity-40">
                {testing ? "연결 중..." : "연결 테스트"}
              </button>
            </div>
            {testResult && (
              <p className={`text-xs mt-1 ${testResult.ok ? "text-green-400" : "text-red-400"}`}>{testResult.msg}</p>
            )}
          </Section>
        )}

        {/* VMS 연결 (DB + MinIO) */}
        <Section title="VMS 연결 (MariaDB / MinIO)">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field
                label="VIP (Virtual-IP) *"
                placeholder="예: 192.0.2.100"
                value={form.vip}
                onChange={(v) => setForm({ ...form, vip: v })}
                required
              />
              <p className="text-xs text-faint mt-1">MariaDB, MinIO 등 VMS 서비스가 사용하는 IP</p>
            </div>
            <Field label="DB 이름 *" placeholder="예: ims-db" value={form.dbName}
              onChange={(v) => setForm({ ...form, dbName: v })} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="DB 포트" placeholder="3306" value={form.dbPort}
              onChange={(v) => setForm({ ...form, dbPort: v })} />
            <Field label="DB 사용자" placeholder="ops" value={form.dbUser}
              onChange={(v) => setForm({ ...form, dbUser: v })} />
            <Field label="DB 비밀번호 *" placeholder="••••••" value={form.dbPassword}
              onChange={(v) => setForm({ ...form, dbPassword: v })} type="password" />
          </div>
        </Section>

        {/* 서버 SSH 연결 (Status Watch용) */}
        <Section title="서버 SSH 연결 (선택)">
          <div className="grid grid-cols-2 gap-3">
            <Field label="SSH 사용자" placeholder="root (미입력 시 DB 사용자)" value={form.sshUser}
              onChange={(v) => setForm({ ...form, sshUser: v })} />
            <Field label="SSH 비밀번호" placeholder="••••••" value={form.sshPassword}
              onChange={(v) => setForm({ ...form, sshPassword: v })} type="password" />
          </div>
          <p className="text-xs text-faint mt-1">
            서버 IP(하드웨어 IP)로 SSH 접속 — Status Watch 탭의 K8s 노드 상태 조회에 사용됩니다.
          </p>
        </Section>

        {/* NAS 설정 */}
        <Section title="NAS 설정 (선택)">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-muted mb-1.5">SSH 사용자</label>
              <div className="w-full px-3 py-2 bg-panel/50 border border-line2 rounded-lg text-sm text-faint cursor-not-allowed select-none">ops</div>
            </div>
            <Field label="NAS 마운트 경로" placeholder="/rtpulse" value={form.nasPath}
              onChange={(v) => setForm({ ...form, nasPath: v })} />
          </div>
          <p className="text-xs text-faint mt-2">
            📌 NAS SSH 비밀번호는 서버 환경변수(NAS_SSH_PASSWORD)로 관리됩니다.
          </p>
        </Section>

        {/* 중앙 메트릭 연결 */}
        <Section title="중앙 메트릭 (선택)">
          <Field label="메트릭 라벨 (customer)" placeholder="site-b"
            value={form.metricsLabel} onChange={(v) => setForm({ ...form, metricsLabel: v })} />
          <p className="text-xs text-faint mt-2">
            📌 고객사 Prometheus 의 <span className="font-mono">external_labels.customer</span> 값과 같아야 합니다.
            입력하면 Status Watch 가 중앙 메트릭(GPU·스트림·이력)으로 전환됩니다. 비우면 기존 SSH 조회를 씁니다.
          </p>
        </Section>

        {/* Slack — 원격 고객사만 */}
        {networkType === "remote" && (
          <Section title="알림 (선택)">
            <Field label="Slack Webhook URL" placeholder="https://hooks.slack.com/services/..."
              value={form.slackWebhook} onChange={(v) => setForm({ ...form, slackWebhook: v })} />
            <p className="text-xs text-faint mt-1">스트림 상태 변경 시 Slack으로 알람을 보냅니다.</p>
          </Section>
        )}

        <div className="flex gap-3 pt-2">
          <button type="submit" disabled={saving || !form.name || (networkType === "remote" && !form.ip)}
            className="px-5 py-2 bg-cyan-700 text-white rounded-lg text-sm hover:bg-cyan-600 disabled:opacity-40">
            {saving ? "저장 중..." : "등록"}
          </button>
          <button type="button" onClick={() => router.back()}
            className="px-5 py-2 bg-input text-ink2 rounded-lg text-sm hover:bg-gray-700">
            취소
          </button>
        </div>
      </form>
    </div>
  );
}

function TypeCard({
  selected, onClick, icon, label, desc, color,
}: {
  selected: boolean;
  onClick: () => void;
  icon: string;
  label: string;
  desc: string;
  color: "cyan" | "amber";
}) {
  const borderColor = selected
    ? color === "amber" ? "border-amber-600 bg-amber-900/20" : "border-cyan-600 bg-cyan-900/20"
    : "border-line2 hover:border-gray-600";
  const textColor = color === "amber" ? "text-amber-400" : "text-cyan-400";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left p-4 rounded-xl border-2 transition-all ${borderColor}`}
    >
      <div className={`text-lg mb-1 ${selected ? textColor : "text-faint"}`}>{icon}</div>
      <div className={`text-sm font-semibold mb-1 ${selected ? textColor : "text-muted"}`}>{label}</div>
      <div className="text-xs text-faint">{desc}</div>
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-line rounded-xl p-4 space-y-3">
      <h3 className="text-xs font-semibold text-muted uppercase tracking-wider">{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, placeholder, value, onChange, required, type = "text" }: {
  label: string; placeholder: string; value: string;
  onChange: (v: string) => void; required?: boolean; type?: string;
}) {
  return (
    <div>
      <label className="block text-sm text-muted mb-1.5">{label}</label>
      <input type={type} placeholder={placeholder} value={value}
        onChange={(e) => onChange(e.target.value)} required={required}
        className="w-full px-3 py-2 bg-panel border border-line2 rounded-lg text-sm text-ink placeholder-gray-600 focus:outline-none focus:border-cyan-600" />
    </div>
  );
}

const TIMEZONE_OPTIONS: { group: string; options: { value: string; label: string }[] }[] = [
  { group: "아시아-태평양", options: [
    { value: "Asia/Seoul",     label: "한국 (UTC+9)" },
    { value: "Asia/Tokyo",     label: "일본 (UTC+9)" },
    { value: "Asia/Shanghai",  label: "중국 (UTC+8)" },
    { value: "Asia/Singapore", label: "싱가포르 (UTC+8)" },
    { value: "Asia/Taipei",    label: "대만 (UTC+8)" },
    { value: "Asia/Hong_Kong", label: "홍콩 (UTC+8)" },
    { value: "Asia/Bangkok",   label: "태국 (UTC+7)" },
    { value: "Asia/Jakarta",   label: "인도네시아 서부 (UTC+7)" },
    { value: "Asia/Kolkata",   label: "인도 (UTC+5:30)" },
    { value: "Asia/Dubai",     label: "UAE (UTC+4)" },
    { value: "Asia/Riyadh",    label: "사우디아라비아 (UTC+3)" },
    { value: "Australia/Sydney",   label: "호주 동부 (UTC+10/11)" },
    { value: "Pacific/Auckland",   label: "뉴질랜드 (UTC+12/13)" },
  ]},
  { group: "유럽", options: [
    { value: "Europe/London", label: "영국 (UTC+0/1)" },
    { value: "Europe/Paris",  label: "프랑스 / 중부유럽 (UTC+1/2)" },
    { value: "Europe/Berlin", label: "독일 (UTC+1/2)" },
    { value: "Europe/Moscow", label: "러시아 모스크바 (UTC+3)" },
  ]},
  { group: "아메리카", options: [
    { value: "America/New_York",    label: "미국 동부 (UTC-5/-4)" },
    { value: "America/Chicago",     label: "미국 중부 (UTC-6/-5)" },
    { value: "America/Denver",      label: "미국 산악 (UTC-7/-6)" },
    { value: "America/Los_Angeles", label: "미국 서부 (UTC-8/-7)" },
    { value: "America/Sao_Paulo",   label: "브라질 (UTC-3/-2)" },
  ]},
  { group: "기타", options: [
    { value: "UTC", label: "UTC" },
  ]},
];

function TimezoneSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-sm text-muted mb-1.5">타임존</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 bg-panel border border-line2 rounded-lg text-sm text-ink focus:outline-none focus:border-cyan-600"
      >
        {TIMEZONE_OPTIONS.map((g) => (
          <optgroup key={g.group} label={g.group}>
            {g.options.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <p className="text-xs text-faint mt-1">
        이벤트 날짜 조회 및 표시에 사용됩니다. 기본값: 한국 (UTC+9)
      </p>
    </div>
  );
}
