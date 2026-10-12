"use client";

import { useState } from "react";
import Link from "next/link";

/** 장비유형. 고른 유형에 따라 아래 입력칸이 바뀐다.
 *  그룹·템플릿은 서버에서 정한다 (src/lib/serverroom-register.ts). */
const KINDS = [
  { k: "server",      label: "서버",         hint: "Linux · Zabbix Agent" },
  { k: "workstation", label: "워크스테이션",  hint: "Linux · Zabbix Agent" },
  { k: "cloud",       label: "클라우드 VM",   hint: "Linux · Zabbix Agent" },
  { k: "router",      label: "라우터",       hint: "SNMP" },
  { k: "switch",      label: "스위치",       hint: "SNMP" },
  { k: "ap",          label: "공유기",       hint: "ICMP" },
] as const;
type Kind = (typeof KINDS)[number]["k"];
const isKind = (v: string | undefined): v is Kind => KINDS.some((x) => x.k === v);

const VENDORS = [
  { v: "mikrotik", label: "MikroTik" },
  { v: "netgear",  label: "NETGEAR" },
  { v: "tplink",   label: "TP-Link" },
  { v: "generic",  label: "기타 (범용 SNMP)" },
  { v: "none",     label: "SNMP 없음 (ICMP 만)" },
] as const;

const AGENT = (k: Kind) => k === "server" || k === "workstation" || k === "cloud";

type Resp = {
  hostid?: string; host?: string; group?: string; templates?: string[];
  alreadyExisted?: boolean; error?: string;
  install?: { ok: boolean; log: string } | null;
};

const input =
  "w-full px-3 py-2 text-xs bg-panel border border-line2 rounded-lg text-ink " +
  "placeholder-gray-600 focus:outline-none focus:border-cyan-600";
const label = "block text-[11px] text-faint font-medium mb-1";

export default function RegisterForm({ defaultKind }: { defaultKind?: string }) {
  const [kind, setKind] = useState<Kind>(isKind(defaultKind) ? defaultKind : "server");
  const [host, setHost] = useState("");
  const [name, setName] = useState("");
  const [ip, setIp] = useState("");
  const [gpu, setGpu] = useState(false);
  const [npu, setNpu] = useState(false);
  const [vendor, setVendor] = useState<string>("generic");
  const [community, setCommunity] = useState("");
  const [sshUser, setSshUser] = useState("");
  const [sshPass, setSshPass] = useState("");
  // GCP VM 은 OS Login 이라 비밀번호가 없고 키로만 붙는다. sudo 도 NOPASSWD 라
  // 비밀번호 sudo 계정을 따로 만들 필요가 없다.
  const [sshAuth, setSshAuth] = useState<"password" | "key">("password");
  const [sshKey, setSshKey] = useState("");
  const [sshKeyPass, setSshKeyPass] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Resp | null>(null);
  const [liveLog, setLiveLog] = useState("");

  // 공유기는 SNMP 를 안 내주는 기기가 많아 기본을 ICMP 로 둔다.
  const pickKind = (k: Kind) => {
    setKind(k);
    setRes(null);
    if (k === "ap") setVendor("none");
    else if (vendor === "none") setVendor("generic");
  };

  const snmp = !AGENT(kind) && vendor !== "none";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setRes(null);
    setLiveLog("");
    try {
      const r = await fetch("/api/serverroom/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind, host: host.trim(), name: name.trim(), ip: ip.trim(),
          ...(AGENT(kind)
            ? { gpu, npu, ...(sshUser ? { ssh: {
                  user: sshUser, port: Number(sshPort) || 22,
                  ...(sshAuth === "key"
                    ? { privateKey: sshKey, ...(sshKeyPass ? { passphrase: sshKeyPass } : {}) }
                    : { password: sshPass }),
                } } : {}) }
            : { vendor, ...(snmp ? { snmpCommunity: community.trim() } : {}) }),
        }),
      });

      // 검증 오류 등은 일반 JSON, 등록 진행은 NDJSON 스트림으로 온다
      if (!r.body || !r.headers.get("content-type")?.includes("ndjson")) {
        setRes(await r.json());
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let msg: { type: string; data?: string; error?: string } & Resp;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type === "log")         setLiveLog((p) => (p + (msg.data ?? "")).slice(-20000));
          else if (msg.type === "result") setRes(msg);
          else if (msg.type === "error")  setRes({ error: msg.error, install: msg.install });
        }
      }
    } catch (err) {
      setRes({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      // 자격증명은 화면에도 남기지 않는다
      setSshPass("");
      setSshKey("");
      setSshKeyPass("");
      setBusy(false);
    }
  }

  return (
    <div className="p-6 space-y-4 max-w-2xl">
      <div>
        <h1 className="text-lg font-semibold text-ink">장비 등록</h1>
        <p className="text-xs text-faint mt-0.5">
          등록하면 서버실 목록에 바로 나타납니다. 서버·워크스테이션은 접속 정보를 함께 넣으면
          Zabbix 에이전트까지 설치합니다.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <div>
          <span className={label}>장비유형</span>
          <div className="flex gap-1 flex-wrap">
            {KINDS.map(({ k, label: l, hint }) => (
              <button key={k} type="button" onClick={() => pickKind(k)} title={hint}
                className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                  kind === k ? "bg-cyan-900/40 border-cyan-700 text-cyan-300"
                             : "border-line2 text-muted hover:text-ink"}`}>
                {l}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label} htmlFor="host">호스트 이름 (영문)</label>
            <input id="host" className={input} value={host} required
                   onChange={(e) => setHost(e.target.value)}
                   placeholder="ws-hong" />
            <p className="text-[10px] text-faint mt-1">Zabbix 기술명. 영문·숫자·. - _ 만.</p>
          </div>
          <div>
            <label className={label} htmlFor="name">표시 이름 (선택)</label>
            <input id="name" className={input} value={name}
                   onChange={(e) => setName(e.target.value)}
                   placeholder="WS (홍길동)" />
            <p className="text-[10px] text-faint mt-1">비우면 호스트 이름을 그대로 씁니다.</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label} htmlFor="ip">IP 주소</label>
            <input id="ip" className={`${input} font-mono`} value={ip} required
                   onChange={(e) => setIp(e.target.value)}
                   placeholder="192.0.2.51" />
          </div>
          {!AGENT(kind) && (
            <div>
              <label className={label} htmlFor="vendor">벤더</label>
              <select id="vendor" className={input} value={vendor}
                      onChange={(e) => setVendor(e.target.value)}>
                {VENDORS.map(({ v, label: l }) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          )}
        </div>

        {AGENT(kind) && (
          <div className="space-y-3 border border-line2 rounded-lg p-3">
            <p className="text-[11px] text-faint font-medium">가속기 (있으면 체크)</p>
            <div className="flex gap-4">
              {([["GPU (NVIDIA)", gpu, setGpu], ["NPU (Mobilint)", npu, setNpu]] as const).map(
                ([l, v, set]) => (
                  <label key={l} className="flex items-center gap-2 text-xs text-muted">
                    <input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)}
                           className="accent-cyan-600" />
                    {l}
                  </label>
                ))}
            </div>
          </div>
        )}

        {snmp && (
          <div>
            <label className={label} htmlFor="community">SNMP 커뮤니티</label>
            <input id="community" className={`${input} font-mono`} value={community} required
                   onChange={(e) => setCommunity(e.target.value)} placeholder="public" />
          </div>
        )}

        {AGENT(kind) && (
          <div className="space-y-3 border border-line2 rounded-lg p-3">
            <div>
              <p className="text-[11px] text-faint font-medium">SSH 접속 정보 (에이전트 설치용)</p>
              {/* 저장하지 않는 편이 사고 범위가 작다. 이미 에이전트가 깔려 있으면 비워도 된다. */}
              <p className="text-[10px] text-faint mt-1">
                이 요청에만 쓰고 저장하지 않습니다. 이미 에이전트가 설치돼 있으면 비워 두세요.
              </p>
            </div>
            <div className="flex gap-1">
              {([["password", "비밀번호"], ["key", "SSH 키"]] as const).map(([k, l]) => (
                <button key={k} type="button" onClick={() => setSshAuth(k)}
                  className={`px-2.5 py-1 text-[11px] rounded-lg border transition-colors ${
                    sshAuth === k ? "bg-cyan-900/40 border-cyan-700 text-cyan-300"
                                  : "border-line2 text-muted hover:text-ink"}`}>
                  {l}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label} htmlFor="ssh-user">계정</label>
                <input id="ssh-user" className={input} value={sshUser} autoComplete="off"
                       onChange={(e) => setSshUser(e.target.value)} placeholder="ops" />
              </div>
              {sshAuth === "password" ? (
                <div>
                  <label className={label} htmlFor="ssh-pass">비밀번호</label>
                  <input id="ssh-pass" type="password" className={input} value={sshPass}
                         autoComplete="new-password" required={!!sshUser}
                         onChange={(e) => setSshPass(e.target.value)} />
                  <p className="text-[10px] text-faint mt-1">sudo 가 물어보면 같은 비밀번호를 씁니다.</p>
                </div>
              ) : (
                <div>
                  <label className={label} htmlFor="ssh-keypass">키 암호 (없으면 비움)</label>
                  <input id="ssh-keypass" type="password" className={input} value={sshKeyPass}
                         autoComplete="new-password"
                         onChange={(e) => setSshKeyPass(e.target.value)} />
                </div>
              )}
            </div>

            {sshAuth === "key" && (
              <div>
                <label className={label} htmlFor="ssh-key">개인키</label>
                <textarea id="ssh-key" rows={5} value={sshKey} required={!!sshUser}
                          onChange={(e) => setSshKey(e.target.value)}
                          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                          className={`${input} font-mono text-[10px] resize-y`} />
                {/* GCP VM 은 sudo 가 NOPASSWD 라 키만으로 설치까지 끝난다. */}
                <p className="text-[10px] text-faint mt-1">
                  GCP VM(OS Login)은 계정이 <code>infra_example_com</code> 형태이고
                  sudo 에 비밀번호가 없어 키만 있으면 됩니다.
                </p>
              </div>
            )}
            <div className="w-32">
              <label className={label} htmlFor="ssh-port">SSH 포트</label>
              <input id="ssh-port" className={`${input} font-mono`} value={sshPort} inputMode="numeric"
                     onChange={(e) => setSshPort(e.target.value.replace(/[^0-9]/g, ""))} placeholder="22" />
              <p className="text-[10px] text-faint mt-1">기본 22. 다르면 바꿔 주세요.</p>
            </div>
          </div>
        )}

        <button type="submit" disabled={busy}
          className="px-4 py-2 text-xs rounded-lg border border-cyan-700 bg-cyan-900/40
                     text-cyan-300 hover:bg-cyan-900/60 disabled:opacity-50">
          {busy ? (AGENT(kind) && sshUser ? "설치하고 등록하는 중…" : "등록하는 중…") : "등록"}
        </button>
      </form>

      {/* 실시간 진행 로그 (설치 스트림) */}
      {(busy || liveLog) && (
        <div className="bg-panel border border-line rounded-lg p-3 space-y-2">
          <p className="text-[11px] text-cyan-400 flex items-center gap-2">
            {busy && <span className="inline-block w-3 h-3 border-2 border-line2 border-t-cyan-500 rounded-full animate-spin" />}
            {busy ? "진행 중… (완료까지 이 화면을 유지하세요)" : "진행 로그"}
          </p>
          {liveLog && (
            <pre className="text-[10px] text-muted whitespace-pre-wrap max-h-64 overflow-auto"
                 ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}>
              {liveLog}
            </pre>
          )}
        </div>
      )}

      {res?.error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 space-y-2">
          <p className="text-xs text-red-400">{res.error}</p>
          {res.install && (
            <pre className="text-[10px] text-muted whitespace-pre-wrap max-h-64 overflow-auto">
              {res.install.log}
            </pre>
          )}
        </div>
      )}

      {res?.hostid && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 space-y-1">
          <p className="text-xs text-emerald-400">
            {res.alreadyExisted ? `${res.host} 는 이미 등록돼 있습니다.` : `${res.host} 등록 완료`}
          </p>
          <p className="text-[11px] text-muted">
            {res.group} · {res.templates?.join(", ")}
          </p>
          {res.install && (
            <p className="text-[11px] text-muted">에이전트 설치 완료</p>
          )}
          <Link href={kind === "cloud" ? "/serverroom/cloud" : AGENT(kind) ? "/serverroom/server" : "/serverroom/switch"}
                className="inline-block text-[11px] text-cyan-400 hover:underline pt-1">
            목록에서 보기 →
          </Link>
          <p className="text-[10px] text-faint">첫 수집까지 1~2분 걸립니다.</p>
        </div>
      )}
    </div>
  );
}
