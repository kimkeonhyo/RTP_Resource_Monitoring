#!/usr/bin/env python3
"""Zabbix 설정 반출/반입 — PoC(로컬 Docker) → 운영(GCE) 이전용.

이력(history)은 옮기지 않는다. PoC 기간 데이터이고 임계값도 여러 번 바꿨다.

configuration.export 가 템플릿·호스트·그룹·미디어타입을 처리하고,
전역 대시보드·액션·전역 매크로는 그 API 가 다루지 못해 직접 옮긴다.

  python3 zbx_migrate.py export [--dir out]
  ZBX_API=http://<새서버>:8080/api_jsonrpc.php python3 zbx_migrate.py import [--dir out]

반출되지 않는 것 (반입 후 손으로 넣어야 한다):
  - 호스트의 ipmi_password  (API 가 값을 돌려주지 않는다)
  - 사용자 미디어의 Teams 웹훅 URL
  - SNMP 커뮤니티 등 Secret text 매크로
"""
import json, os, re, sys, urllib.request
from pathlib import Path

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
USER = os.environ.get('ZBX_USER', 'Admin')
PW   = os.environ.get('ZBX_PASS', 'zabbix')

def call(m, p, a=None):
    b = {'jsonrpc': '2.0', 'method': m, 'params': p, 'id': 1}
    if a: b['auth'] = a
    r = json.load(urllib.request.urlopen(urllib.request.Request(
        API, method='POST', headers={'Content-Type': 'application/json-rpc'},
        data=json.dumps(b).encode()), timeout=300))
    if 'error' in r: raise SystemExit(f"{m}: {json.dumps(r['error'], ensure_ascii=False)}")
    return r['result']

def login(): return call('user.login', {'username': USER, 'password': PW})

# 내장 템플릿·미디어타입은 새 인스턴스에도 있으므로 우리가 만든 것만 옮긴다
OURS = 'IMS '

# configuration.export 는 ipmi_password 와 SNMP 커뮤니티를 평문으로 내보낸다.
# 그대로 두면 반출 파일 자체가 비밀 문서가 되므로 자리표시자로 바꿔 둔다.
REDACT = [
    (re.compile(r'^(\s*ipmi_password:\s*).*$', re.M), r'\1"{{IPMI_PASSWORD}}"'),
    (re.compile(r"^(\s*- macro: '\{\$SNMP_COMMUNITY\}'\n\s*value:\s*).*$", re.M),
     r'\1"{{SNMP_COMMUNITY}}"'),
]

def redact(y: str):
    n = 0
    for pat, rep in REDACT:
        y, c = pat.subn(rep, y)
        n += c
    return y, n

def restore(y: str):
    """반입 직전에 자리표시자를 환경변수 값으로 되돌린다."""
    for ph, env in (('{{IPMI_PASSWORD}}', 'ZBX_IPMI_PASS'),
                    ('{{SNMP_COMMUNITY}}', 'SNMP_COMMUNITY')):
        if ph not in y:
            continue
        v = os.environ.get(env)
        if not v:
            raise SystemExit(f'{env} 가 필요합니다 ({ph} 를 채워야 함).\n'
                             f'  infisical run --env=gcp --path=/zabbix -- python3 zbx_migrate.py import')
        y = y.replace(ph, v)
    return y

def do_export(d: Path):
    tok = login()
    d.mkdir(parents=True, exist_ok=True)

    tpl = [t['templateid'] for t in call('template.get', {'output': ['templateid', 'host']}, tok)
           if t['host'].startswith(OURS)]
    hosts = [h['hostid'] for h in call('host.get', {'output': ['hostid']}, tok)]
    hgrp = [g['groupid'] for g in call('hostgroup.get', {'output': ['groupid', 'name']}, tok)
            if g['name'].startswith(OURS)]
    tgrp = [g['groupid'] for g in call('templategroup.get', {'output': ['groupid', 'name']}, tok)
            if g['name'].startswith('Templates/')]

    opts = {'host_groups': hgrp, 'template_groups': tgrp, 'templates': tpl, 'hosts': hosts}
    opts = {k: v for k, v in opts.items() if v}
    y = call('configuration.export', {'format': 'yaml', 'options': opts}, tok)
    y, n = redact(y)
    (d / 'configuration.yaml').write_text(y)
    print(f"  비밀값 {n}건을 자리표시자로 치환했습니다 (반입 시 환경변수로 채운다)")
    print(f"  configuration.yaml — 템플릿 {len(tpl)} / 호스트 {len(hosts)} / 호스트그룹 {len(hgrp)}")

    # configuration.export 가 못 다루는 것들
    extra = {
        'global_macros': [{k: m[k] for k in ('macro', 'value', 'type', 'description') if k in m}
                          for m in call('usermacro.get', {'globalmacro': True, 'output': 'extend'}, tok)],
        'actions': call('action.get', {'output': 'extend', 'selectFilter': 'extend',
                                       'selectOperations': 'extend'}, tok),
        'dashboards': call('dashboard.get', {'output': ['name', 'display_period', 'auto_start'],
                                             'selectPages': 'extend'}, tok),
    }
    (d / 'extra.json').write_text(json.dumps(extra, ensure_ascii=False, indent=1))
    print(f"  extra.json — 전역매크로 {len(extra['global_macros'])} / 액션 {len(extra['actions'])} "
          f"/ 대시보드 {len(extra['dashboards'])}")
    print(f"\n반출 완료: {d}")
    print("Teams 웹훅 URL 은 사용자 미디어에 있어 반출되지 않습니다 — teams_setup.py 로 다시 넣으세요.")

def do_import(d: Path):
    tok = login()
    y = restore((d / 'configuration.yaml').read_text())
    call('configuration.import', {
        'format': 'yaml', 'source': y,
        # templateLinkage 가 없으면 호스트는 만들어지지만 템플릿이 붙지 않는다.
        # 아이템이 0개가 되어 아무것도 수집되지 않으며, 오류도 나지 않아 알아채기 어렵다.
        'rules': {
            **{k: {'createMissing': True, 'updateExisting': True} for k in
               ('template_groups', 'host_groups', 'templates', 'hosts', 'items',
                'triggers', 'graphs', 'discoveryRules', 'valueMaps')},
            'templateLinkage': {'createMissing': True, 'deleteMissing': False},
        },
    }, tok)
    print("  configuration.yaml 반입 완료")
    print("\n전역 매크로·액션·대시보드는 이름 기반 참조가 많아 자동 반입하지 않습니다.")
    print("extra.json 을 참고해 아래 스크립트로 다시 만드는 편이 안전합니다:")
    for s in ('bmc_sync.py', 'internal_sync.py', 'nas_sync.py', 'remote_autoreg.py',
              'npu_template.py', 'server_alert_action.py', 'teams_setup.py',
              'npu_dashboard.py', 'server_page.py', 'remote_dashboard.py'):
        print(f"    python3 {s}")

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    dd = Path(sys.argv[sys.argv.index('--dir') + 1]) if '--dir' in sys.argv else Path('migrate')
    if cmd == 'export': do_export(dd)
    elif cmd == 'import': do_import(dd)
    else: raise SystemExit(__doc__)
