/**
 * 서버실 장비 등록 — 장비유형별 Zabbix 구성과 에이전트 설치
 *
 * 장비유형을 고르면 그룹·템플릿·인터페이스가 정해진다. 그 매핑은 반드시
 * 서버에서만 결정한다 — 클라이언트가 템플릿 id 를 직접 보내면 아무 템플릿이나
 * 붙일 수 있게 된다.
 *
 * 등록만 하면 watch 서버실 화면에 자동으로 나타난다. 화면이 호스트 그룹을 읽어
 * 그리기 때문에 대시보드를 따로 만들 필요가 없다.
 */
import { zabbix } from "@/lib/zabbix";

export const KINDS = ["server", "workstation", "cloud", "router", "switch", "ap"] as const;
export type Kind = (typeof KINDS)[number];

export const VENDORS = ["mikrotik", "netgear", "tplink", "generic", "none"] as const;
export type Vendor = (typeof VENDORS)[number];

const GROUP_SERVER = "IMS 서버·워크스테이션";
const GROUP_NETWORK = "IMS 네트워크 장비";
const GROUP_CLOUD = "IMS 클라우드";

const VENDOR_TEMPLATE: Record<Vendor, string | null> = {
  mikrotik: "Mikrotik by SNMP",
  netgear: "Netgear Fastpath by SNMP",
  tplink: "TP-LINK by SNMP",
  generic: "Generic by SNMP",
  none: null,
};

/** 에이전트가 응답을 허용해야 하는 출발지.
 *  온프렘: Zabbix(GCP) → tsr → 테일넷 → SNAT 하므로 도착 주소는 <DEV_GPU01_IP> 이다.
 *  같은 VPC 의 GCP VM(클라우드): tsr 을 안 거치고 Zabbix 서버가 직접 오므로 <ZABBIX_SERVER_IP> 이 필요하다.
 *  ansible/inventory/ims/group_vars/all/main.yml 의 zabbix_server_allow 와 같아야 한다. */
const AGENT_ALLOW = process.env.ZABBIX_AGENT_ALLOW ?? "";
/** 액티브 체크가 향하는 주소. 사내망에서는 경로가 없어 실패하지만 설정은 맞춰 둔다. */
const SERVER_ACTIVE = process.env.ZABBIX_SERVER_ACTIVE ?? "";

export type RegisterInput = {
  kind: Kind;
  /** Zabbix 기술명. ASCII 만 — 한글을 넣으면 Zabbix 가 거부한다. */
  host: string;
  /** 화면에 보이는 이름. 한글 가능. */
  name?: string;
  ip: string;
  /** 서버·워크스테이션 */
  gpu?: boolean;
  npu?: boolean;
  /** 네트워크 장비 */
  vendor?: Vendor;
  snmpCommunity?: string;
};

export type Plan = {
  group: string;
  templates: string[];
  interfaceType: 1 | 2;
  port: string;
  needsAgent: boolean;
  macros: { macro: string; value: string }[];
};

/** 장비유형 → Zabbix 구성. 서버에서만 계산한다. */
export function planFor(input: RegisterInput): Plan {
  if (input.kind === "server" || input.kind === "workstation" || input.kind === "cloud") {
    const templates = ["Linux by Zabbix agent", "ICMP Ping"];
    if (input.gpu) templates.push("IMS NVIDIA GPU by Zabbix agent");
    if (input.npu) templates.push("IMS Mobilint NPU by Zabbix agent");
    // 클라우드(GCP VM 등)는 별도 그룹으로 나눠 Cloud 페이지에서 본다.
    const group = input.kind === "cloud" ? GROUP_CLOUD : GROUP_SERVER;
    return { group, templates, interfaceType: 1, port: "10050", needsAgent: true, macros: [] };
  }

  // 공유기는 SNMP 를 내주지 않는 기기가 많다. 사내 IP-Time·KT 공유기가 그랬다.
  if (input.kind === "ap" && (!input.vendor || input.vendor === "none")) {
    // 인터페이스는 IP 를 들고 있으려고 agent 타입으로 둔다. ICMP Ping 은 인터페이스를
    // 쓰지 않는 simple check 라 폴링에는 관여하지 않는다.
    return { group: GROUP_NETWORK, templates: ["ICMP Ping"], interfaceType: 1, port: "10050", needsAgent: false, macros: [] };
  }

  const vendor = (input.vendor ?? "generic") as Vendor;
  const vt = VENDOR_TEMPLATE[vendor];
  const templates = vt ? [vt, "ICMP Ping"] : ["ICMP Ping"];
  const macros = input.snmpCommunity
    ? [{ macro: "{$SNMP_COMMUNITY}", value: input.snmpCommunity }]
    : [];
  return {
    group: GROUP_NETWORK,
    templates,
    interfaceType: vt ? 2 : 1,
    port: vt ? "161" : "10050",
    needsAgent: false,
    macros,
  };
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
/** Zabbix 기술명 제약: ASCII 영숫자와 공백 . - _ 만. 한글은 표시명에만 쓸 수 있다. */
const HOSTNAME_OK = /^[A-Za-z0-9 ._-]{1,120}$/;

export function validate(input: RegisterInput): string | null {
  if (!KINDS.includes(input.kind)) return "장비유형이 올바르지 않습니다";
  if (!input.host?.trim()) return "호스트 이름을 입력하세요";
  if (!HOSTNAME_OK.test(input.host)) {
    return "호스트 이름에는 영문·숫자·공백·. - _ 만 쓸 수 있습니다 (한글은 표시 이름에)";
  }
  if (!IPV4.test(input.ip ?? "")) return "IP 주소 형식이 올바르지 않습니다";
  if (input.vendor && !VENDORS.includes(input.vendor)) return "벤더가 올바르지 않습니다";
  const plan = planFor(input);
  if (plan.interfaceType === 2 && !input.snmpCommunity?.trim()) {
    return "SNMP 커뮤니티를 입력하세요";
  }
  return null;
}

async function idOfGroup(name: string): Promise<string> {
  const r = await zabbix<{ groupid: string }[]>("hostgroup.get", {
    output: ["groupid"], filter: { name: [name] },
  });
  if (r.length) return r[0].groupid;
  // 클라우드 그룹은 처음 등록할 때 없을 수 있으므로 만들어 준다.
  if (name === GROUP_CLOUD) {
    const c = await zabbix<{ groupids: string[] }>("hostgroup.create", { name });
    return c.groupids[0];
  }
  throw new Error(`호스트 그룹 '${name}' 이 Zabbix 에 없습니다`);
}

async function idsOfTemplates(names: string[]): Promise<string[]> {
  const r = await zabbix<{ templateid: string; host: string }[]>("template.get", {
    output: ["templateid", "host"], filter: { host: names },
  });
  const missing = names.filter((n) => !r.some((t) => t.host === n));
  if (missing.length) throw new Error(`템플릿을 찾을 수 없습니다: ${missing.join(", ")}`);
  return r.map((t) => t.templateid);
}

export type RegisterResult = {
  hostid: string;
  host: string;
  group: string;
  templates: string[];
  alreadyExisted: boolean;
};

/** Zabbix 에 호스트를 만든다. 같은 이름이나 같은 IP 가 이미 있으면 만들지 않는다. */
export async function createHost(input: RegisterInput): Promise<RegisterResult> {
  const plan = planFor(input);

  const dupName = await zabbix<{ hostid: string; host: string }[]>("host.get", {
    output: ["hostid", "host"], filter: { host: [input.host] },
  });
  const said = (hostid: string, host: string, alreadyExisted: boolean): RegisterResult =>
    ({ hostid, host, group: plan.group, templates: plan.templates, alreadyExisted });

  if (dupName.length) return said(dupName[0].hostid, dupName[0].host, true);
  const dupIp = await zabbix<{ hostid: string; host: string }[]>("host.get", {
    output: ["hostid", "host"], filter: { ip: input.ip },
  });
  if (dupIp.length) {
    throw new Error(`${input.ip} 는 이미 '${dupIp[0].host}' 에 등록돼 있습니다`);
  }

  const [groupid, templateids] = await Promise.all([
    idOfGroup(plan.group),
    idsOfTemplates(plan.templates),
  ]);

  const iface: Record<string, unknown> = {
    type: plan.interfaceType, main: 1, useip: 1, ip: input.ip, dns: "", port: plan.port,
  };
  // SNMP 인터페이스는 details 가 필수다. bulk 는 기본값(켜짐)을 따른다.
  if (plan.interfaceType === 2) {
    iface.details = { version: 2, community: "{$SNMP_COMMUNITY}", bulk: 1, max_repetitions: 10 };
  }

  const created = await zabbix<{ hostids: string[] }>("host.create", {
    host: input.host,
    ...(input.name?.trim() ? { name: input.name.trim() } : {}),
    groups: [{ groupid }],
    templates: templateids.map((templateid) => ({ templateid })),
    interfaces: [iface],
    ...(plan.macros.length ? { macros: plan.macros } : {}),
  });

  return said(created.hostids[0], input.host, false);
}

/** 자동 등록 액션이 이 값으로 호스트그룹·템플릿을 고른다.
 *  Ansible 인벤토리의 zabbix_host_metadata 와 같은 규칙이어야 한다 —
 *  사내는 linux;ims, GCP VM 은 linux;gcp 다. 장비유형과 무관하게 한 값을 박으면
 *  watch 로 등록한 클라우드 VM 이 사내 그룹으로 분류된다. */
function hostMetadata(kind: Kind): string {
  return kind === "cloud" ? "linux;gcp" : "linux;ims";
}

/** 대상 장비에서 실행되는 에이전트 설치 스크립트.
 *  ansible/roles/zabbix-agent 와 같은 일을 하지만, 등록 한 대만 처리하는 최소판이다. */
export function agentInstallScript(hostname: string, kind: Kind): string {
  return `set -eu
. /etc/os-release

# Ubuntu/Debian(apt) 와 Rocky/RHEL(dnf) 를 모두 지원한다. GCP VM 은 Rocky 다.
install_debian() {
  dpkg -s zabbix-agent2 >/dev/null 2>&1 && return
  if ! apt-cache policy zabbix-agent2 2>/dev/null | grep -q repo.zabbix.com; then
    tmp=\$(mktemp --suffix=.deb)
    curl -fsSL -o "\$tmp" \\
      "https://repo.zabbix.com/zabbix/7.0/ubuntu/pool/main/z/zabbix-release/zabbix-release_7.0-2+ubuntu\${VERSION_ID}_all.deb"
    dpkg -i "\$tmp"
    rm -f "\$tmp"
  fi
  apt-get update || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y zabbix-agent2
}

install_rhel() {
  rpm -q zabbix-agent2 >/dev/null 2>&1 && return
  major=\${VERSION_ID%%.*}
  # rocky 계열은 rocky 경로, 그 외 RHEL 클론은 rhel 경로(패키지는 동일한 el rpm)
  case "\${ID:-}" in rocky) fam=rocky ;; almalinux) fam=alma ;; *) fam=rhel ;; esac
  # 저장소 등록 rpm 은 GPG 키가 아직 없어 dnf 대신 rpm 으로 넣는다(-latest = 버전 무관)
  rpm -q zabbix-release >/dev/null 2>&1 || \\
    rpm -Uvh "https://repo.zabbix.com/zabbix/7.0/\${fam}/\${major}/x86_64/zabbix-release-latest.el\${major}.noarch.rpm"
  dnf -y clean all
  dnf -y install zabbix-agent2
}

case "\${ID:-}\${ID_LIKE:+ }\${ID_LIKE:-}" in
  ubuntu*|debian*) install_debian ;;
  rocky*|rhel*|centos*|almalinux*|ol*|*fedora*|*rhel*) install_rhel ;;
  *) echo "지원하지 않는 OS: \${ID:-unknown}" >&2; exit 1 ;;
esac

mkdir -p /etc/zabbix/zabbix_agent2.d
cat > /etc/zabbix/zabbix_agent2.d/ims.conf <<'CONF'
# watch 서버실 등록으로 생성됨
Server=${AGENT_ALLOW}
ServerActive=${SERVER_ACTIVE}
Hostname=${hostname}
HostMetadata=${hostMetadata(kind)}
Timeout=30
CONF

systemctl enable zabbix-agent2 >/dev/null 2>&1 || true
systemctl restart zabbix-agent2
sleep 2
systemctl is-active zabbix-agent2
`;
}

/** 등록 폼에서 한 번만 받는 접속 정보. 저장하지 않는다.
 *  사내망 전체를 여는 SSH 키를 watch 에 두는 것보다, 그 한 대의 자격증명을
 *  요청 동안만 메모리에 두고 버리는 편이 사고 범위가 훨씬 작다.
 *
 *  password 와 privateKey 중 하나만 있으면 된다. GCP VM 은 OS Login 이라
 *  비밀번호가 아예 없고 키로만 붙으며 sudo 도 NOPASSWD 다 — 그래서 비밀번호
 *  sudo 계정을 따로 만들 필요가 없다. */
export type SshCreds = {
  user: string;
  password?: string;
  /** OpenSSH 개인키 본문. 암호가 걸려 있으면 passphrase 도 같이 준다. */
  privateKey?: string;
  passphrase?: string;
  port?: number;
};

export type InstallResult = { ok: boolean; log: string };

/** 대상 장비에 SSH 로 붙어 에이전트를 설치한다.
 *  onData 를 주면 출력이 오는 대로 실시간으로 흘려보낸다(진행 표시용). */
export async function installAgent(
  ip: string, hostname: string, kind: Kind, creds: SshCreds,
  onData?: (chunk: string) => void,
): Promise<InstallResult> {
  // 라우터 등 에이전트가 없는 장비에서는 호출되지 않으므로 여기서만 ssh2 를 끌어온다.
  const { Client } = await import("ssh2");
  const script = agentInstallScript(hostname, kind);

  return new Promise<InstallResult>((resolve) => {
    const conn = new Client();
    let log = "";
    let settled = false;
    const done = (ok: boolean, extra = "") => {
      if (settled) return;
      settled = true;
      conn.end();
      resolve({ ok, log: (log + extra).slice(-8000) });
    };
    // apt 가 느린 장비가 있어 넉넉히 준다.
    const timer = setTimeout(() => done(false, "\n설치가 5분을 넘겨 중단했습니다."), 300_000);

    // sudo 가 비밀번호를 묻는지 먼저 본다. NOPASSWD 인데 `sudo -S` 로 비밀번호를
    // 흘려보내면 sudo 가 그 줄을 읽지 않아 **스크립트의 첫 줄**이 되어버린다 —
    // 설치가 깨지고 비밀번호가 로그에 그대로 찍힌다. GCP VM 이 전부 이 경우다.
    const sudoNeedsPassword = () => new Promise<boolean>((res) => {
      conn.exec("sudo -n true", (err, s) => {
        if (err) return res(true);
        s.on("close", (code: number) => res(code !== 0));
        s.resume();
        s.stderr.resume();
      });
    });

    conn.on("ready", async () => {
      const needPw = creds.user === "root" ? false : await sudoNeedsPassword();
      if (needPw && !creds.password) {
        clearTimeout(timer);
        return done(false,
          "\nsudo 가 비밀번호를 요구하는데 비밀번호를 받지 못했습니다. " +
          "비밀번호를 입력하거나, 대상 장비에서 NOPASSWD sudo 를 허용하세요.");
      }
      const cmd = creds.user === "root" ? "bash -s"
                : needPw ? "sudo -S -p '' bash -s"
                : "sudo -n bash -s";

      conn.exec(cmd, (err, stream) => {
        if (err) return done(false, `\nexec 실패: ${err.message}`);
        stream.on("data", (d: Buffer) => { const s = d.toString(); log += s; onData?.(s); });
        stream.stderr.on("data", (d: Buffer) => { const s = d.toString(); log += s; onData?.(s); });
        stream.on("close", (code: number) => {
          clearTimeout(timer);
          done(code === 0, `\n종료 코드 ${code}`);
        });
        if (needPw) stream.write(`${creds.password}\n`);
        stream.end(script);
      });
    });
    conn.on("error", (e: Error) => {
      clearTimeout(timer);
      done(false, `\nSSH 접속 실패: ${e.message}`);
    });
    // 키가 있으면 키로, 없으면 비밀번호로 붙는다. GCP VM 은 비밀번호 인증 자체가 꺼져 있다.
    conn.connect({
      host: ip, port: creds.port && creds.port > 0 ? creds.port : 22,
      username: creds.user,
      ...(creds.privateKey
        ? { privateKey: creds.privateKey,
            ...(creds.passphrase ? { passphrase: creds.passphrase } : {}) }
        : { password: creds.password }),
      readyTimeout: 20_000,
    });
  });
}
