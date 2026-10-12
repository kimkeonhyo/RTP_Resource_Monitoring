# 비밀값 (템플릿)

이 레포에는 비밀값이 **하나도 들어 있지 않다.** 모든 스크립트는 비밀값을 환경변수로만
받고, 소스에 기본값을 두지 않는다. 값이 없으면 실행이 멈추고 무엇이 빠졌는지 알려준다.

아래는 필요한 값의 목록과 형식이다. 실제 값은 시크릿 매니저(예: Infisical, Vault,
1Password 등)에 두고 실행 시 환경변수로 주입한다.

## 환경변수

| 키 | 쓰이는 곳 | 예시(placeholder) |
|---|---|---|
| `ZBX_API` | 모든 스크립트 — Zabbix API 주소(선택) | `http://<ZABBIX_HOST>/api_jsonrpc.php` |
| `ZBX_USER` | 모든 스크립트 — Zabbix API 사용자(선택, 기본 `Admin`) | `Admin` |
| `ZBX_PASS` | 모든 스크립트 — Zabbix API 관리자 비밀번호 | `<ZABBIX_ADMIN_PASSWORD>` |
| `ZBX_IPMI_PASS` | `hosts/bmc_sync.py` — BMC 관제 계정 비밀번호 | `<BMC_PASSWORD>` |
| `SNMP_COMMUNITY` | `hosts/nas_sync.py`, `hosts/office_wifi_snmp.py` — SNMP v2c 커뮤니티 | `<SNMP_COMMUNITY>` |
| `TEAMS_URL` | `alerts/teams_setup.py` — Teams 워크플로 웹훅 URL | `https://<tenant>.webhook.office.com/...` |
| `NETBOX_API` / `NETBOX_TOKEN` | `hosts/netbox_*.py` — NetBox API | `https://netbox.example.com/api` / `<NETBOX_TOKEN>` |
| `ANSIBLE_VAULT_PASSWORD` | Ansible Vault 해제용 | `<VAULT_PASSWORD>` |

## 실행 예

시크릿 매니저 CLI 로 환경변수를 주입해 실행한다 (Infisical 예시):

```bash
zbx() { infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=<ENV> --path=/zabbix -- "$@"; }

zbx python3 hosts/bmc_sync.py
DRY_RUN=1 zbx python3 alerts/alert_noise_fix.py
```

값을 손으로 한 번만 넣을 때는 셸 히스토리에 남지 않게 한다:

```bash
read -rs "?BMC 비밀번호: " P; ZBX_IPMI_PASS="$P" python3 hosts/bmc_sync.py; unset P
```

## Ansible Vault

서버별 sudo 비밀번호와 `bmc_password` 는 Ansible Vault 파일
`ansible/inventory/ims/group_vars/all/vault.yml` 에 둔다. 이 파일은 `.gitignore` 로
커밋을 막아 두었고, 형식은 같은 디렉터리의 `vault.yml.example` 에 있다.

```bash
cd ansible
cp inventory/ims/group_vars/all/vault.yml.example inventory/ims/group_vars/all/vault.yml
# 값을 채운 뒤 암호화
ansible-vault encrypt inventory/ims/group_vars/all/vault.yml
ansible-playbook playbooks/install-zabbix-agent.yml --ask-vault-pass
```

## Zabbix 내부에 저장되는 값

호스트의 `ipmi_password`, 호스트 매크로 `{$SNMP_COMMUNITY}`, 사용자 미디어의 웹훅 URL 은
Zabbix DB 에 저장된다. 위 스크립트가 환경변수 값으로 그 자리를 채우는 구조이므로
Zabbix 를 새로 구축해도 스크립트만 다시 돌리면 된다.
