# IMS 관제 Ansible

`dc-infra/ansible` 과 같은 구조입니다 — `inventory/<환경>/` + `playbooks/`(롤 호출) + `roles/`.

```
inventory/ims/hosts.ini              사내 서버 (호스트명 = NetBox 자산명 = DNS)
inventory/ims/group_vars/all.yml     환경별 변수 (zabbix_server 등)
inventory/gcp/hosts.ini                GCP VM (별칭 = Zabbix 호스트명)
playbooks/install-zabbix-agent.yml     → roles/zabbix-agent          (사내, Ubuntu)
playbooks/install-zabbix-cloud.yml     → roles/install-zabbix-cloud  (GCP, Ubuntu/Rocky)
playbooks/setup-bmc-user.yml           → roles/bmc-user
```

인벤토리가 두 개인 이유: GCP VM 은 OS Login 으로 sudo NOPASSWD 라 become 비밀번호가
없는데, 사내 `group_vars/all` 은 vault 비밀번호를 `mandatory` 로 요구합니다.
같이 두면 GCP 실행이 "어느 호스트가 vault.yml 에 없다" 로 멈춥니다.
**GCP 플레이북은 `-i inventory/gcp/hosts.ini` 를 반드시 줘야 합니다** —
`ansible.cfg` 의 기본 인벤토리는 사내입니다.

## 롤

| 롤 | 하는 일 |
|---|---|
| `zabbix-agent` | 사내 서버. Ubuntu 전용. Agent2 설치 + GPU/NPU UserParameter + ufw |
| `install-zabbix-cloud` | GCP VM. Ubuntu(apt)·Rocky 계열(dnf) 지원. Agent2 설치 + firewalld/ufw |
| `bmc-user` | BMC LAN 채널 탐색 → 관제 계정(USER 권한) 생성 → 검증 |

## sudo 비밀번호 (서버별로 다름)

Ansible Vault 에 서버별 비밀번호를 한 파일로 모아둡니다. 실행할 때는 Vault 비밀번호 하나만 입력합니다.

**`vault.yml` 은 레포에 없습니다.** 암호화되어 있지만 `.gitignore` 로 커밋을 막아
두었습니다. 새로 합류하셨다면 레포에서 받는 것이 아니라 **인프라 담당자에게 파일을
받아** `inventory/ims/group_vars/all/` 에 두세요.

받는 방법과 Vault 비밀번호 위치는 [../SECRETS.md](../SECRETS.md) 에 정리해 두었습니다.
파일 구조는 같은 디렉터리의 `vault.yml.example` 을 보세요.

```bash
# 이후 수정
ansible-vault edit inventory/ims/group_vars/all/vault.yml

# 실행 — -K 대신 --ask-vault-pass
ansible-playbook playbooks/install-zabbix-agent.yml --ask-vault-pass
```

vault.yml 에 없는 호스트는 **어느 호스트가 빠졌는지 이름을 알려주며** 실패합니다.

## 실행

```bash
cd ansible

# 변경 예정만 확인
# 한 대 시험 → 전체 (--check 는 저장소 추가 단계 때문에 의미가 없어 쓰지 않는다)
ansible-playbook playbooks/install-zabbix-agent.yml --ask-vault-pass --limit dev-gpu01
ansible-playbook playbooks/install-zabbix-agent.yml --ask-vault-pass

# BMC 현황만 조회 (변경 없음, 비밀번호 불필요)
ansible-playbook playbooks/setup-bmc-user.yml --ask-vault-pass -e bmc_report_only=true

# BMC 계정 생성 — 카나리(1대 → 2대 → 전체)로 자동 진행, 실패 시 즉시 중단
# 비밀번호는 실행 시 입력하며 파일·로그에 남지 않습니다.
ansible-playbook playbooks/setup-bmc-user.yml --ask-vault-pass

# 되돌리기 (계정 비활성화)
ansible <호스트> -m shell -a 'ipmitool user disable <ID>' --become --ask-vault-pass
```

## GCP VM

```bash
ansible-playbook -i inventory/gcp/hosts.ini playbooks/install-zabbix-cloud.yml --check
ansible-playbook -i inventory/gcp/hosts.ini playbooks/install-zabbix-cloud.yml
ansible-playbook -i inventory/gcp/hosts.ini playbooks/install-zabbix-cloud.yml --limit rtpulse
```

### 접속 (인증 체계가 두 가지로 섞여 있습니다)

VM 메타데이터 `enable-oslogin` 값으로 갈립니다. 인벤토리에 반영해 뒀으니 그냥 실행하면 됩니다.

| | 대수 | 계정 | 키 |
|---|---|---|---|
| `TRUE` | 20 | `infra_example_com` | **OS Login 프로필에 등록된 키만.** 프로젝트 메타데이터 `ssh-keys` 는 무시됩니다 |
| `FALSE` | `ims`, `zabbix` | `deploy` | `~/.ssh/google_compute_engine` |

OS Login 쪽이 `Permission denied (publickey)` 로 막히면 이 장비의 키가 프로필에
없는 것입니다. **한 번 등록하면 프로젝트 전체 VM 에 적용됩니다** — 장비마다
배포할 필요가 없습니다.

```bash
gcloud compute os-login ssh-keys add --project=demo-infra --key-file=~/.ssh/id_ed25519.pub
gcloud compute os-login describe-profile --project=demo-infra    # 등록 확인
```

sudo 는 IAM 이 정합니다. `roles/owner` 나 `roles/compute.osAdminLogin` 이면 NOPASSWD 로
됩니다. `roles/compute.osLogin` 만 있으면 접속은 되고 sudo 가 안 되므로 become 이 실패합니다.

인벤토리 목록 갱신:

```bash
gcloud compute instances list --project=demo-infra \
  --format="table[no-heading](name,networkInterfaces[0].networkIP,status,disks[0].licenses[0].basename())"
```

### 시작 전에 확인할 두 가지 (둘 다 Ansible 밖의 일)

1. **Zabbix 자동 등록 액션에 `HostMetadata` `linux;gcp` 조건**이 있어야 호스트가 등록됩니다.
   없으면 에이전트는 정상인데 Zabbix 에 아무것도 나타나지 않습니다.
2. ~~GCP VPC 방화벽~~ — **이미 열려 있습니다** (2026-09-09 확인).
   `demo-infra-allow-zabbix-agent` 가 `<ZABBIX_SERVER_IP>/32 → icmp, tcp:10050` 을 대상 태그 없이,
   즉 VPC 전체 인스턴스에 허용합니다. 액티브 체크용 `10051` 인바운드도
   `demo-infra-o11y-zabbix-allow-agent-active` 로 열려 있습니다
   (`<OFFICE_SUBNET_CIDR>`, `<GCP_VPC_CIDR>`, `<TAILNET_CIDR>`).

관제 대상은 **13대**입니다 (2026-09-09 등록 완료). 아래 6대는 관제하지 않기로
했습니다 — 기술적으로 막혀 있고 뚫는 비용이 얻는 것보다 큽니다.

### 제외한 VM

| VM | 사유 |
|---|---|
| `gatus`, `infisical` | COS — 패키지 매니저가 없어 설치 불가. ICMP·HTTP 로 봐야 합니다 |
| `n8n`, `vms-cloud` | 테일넷 경로에서 ICMP·22 둘 다 안 닿습니다. VM 안쪽 방화벽으로 보이나 들어갈 수가 없어 미검증. `gcp_iap_only` 그룹으로 남겨 뒀습니다 — 되살리려면 IAP 터널 ProxyCommand 가 필요합니다 |
| `vms-production` (<VMS_PRODUCTION_IP>), `derp-th` (<DERP_TH_IP>) | 다른 VPC·리전. <ZABBIX_SERVER_IP> 경로를 먼저 확인해야 합니다 |
| `zabbix` (<ZABBIX_SERVER_IP>) | Zabbix 서버 자신. 컨테이너 서버와 호스트 에이전트가 같은 이름으로 섞입니다 |
| `gbrain-poc`, `bastion` | TERMINATED |

SELinux 는 끄지 않습니다. Rocky 는 기본 enforcing 이고 10050/tcp 는 배포된 zabbix
정책에 이미 있어 기본 수집은 그냥 됩니다. 막히는 것은 UserParameter 로 외부
스크립트를 돌릴 때인데 클라우드 VM 에는 그런 게 없습니다. 상태만 결과에 찍습니다.

## 알아둘 점

- **호스트명은 NetBox 자산명**을 씁니다. OS 내부 호스트명(`gpusystem`)이 3대에서 중복되어 식별자로 쓸 수 없습니다.
- 에이전트는 **Active 모드**라 서버 쪽 인바운드 포트를 열지 않습니다.
- BMC LAN 채널 번호는 보드마다 다릅니다(8/1/없음). 매 실행 시 탐색하고, 미설정 서버는 건너뜁니다.
- BMC 계정 권한은 `USER`(2) — 센서 읽기만 되고 **원격 전원 제어는 불가**합니다.
- `unreachable` 그룹의 3대(`ai-gpu01`, `ai-gpu03`, `npu-8ea`)는 접속이 안 되어 `ims` 에서 제외했습니다.

## dc-infra 로 옮기려면

`roles/` 두 개와 `playbooks/` 두 개를 `dc-infra/ansible/` 의 같은 위치로 복사하고,
인벤토리는 `dc-infra/ansible/inventory/ims/` 으로 두면 됩니다.
