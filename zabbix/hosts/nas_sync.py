#!/usr/bin/env python3
"""NAS 를 SNMP 관제에 붙인다 (기존 ICMP 호스트를 재사용한다).

벤더 MIB 가 없어 RAID·디스크 온도는 수집되지 않는다 — 그건 ADM 자체 알림으로 받아야 한다.
  python3 nas_sync.py [--dry-run]
"""
import json, os, sys, urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
COMMUNITY = os.environ.get('SNMP_COMMUNITY')   # 기본값을 두지 않는다 — 소스에 비밀값을 남기지 않기 위해
DRY = '--dry-run' in sys.argv
TPL = 'Linux by SNMP'          # 둘 다 net-snmp 기반이라 표준 MIB 로 충분하다

# IP → 호스트명. 이름은 인벤토리·DNS 와 같게 맞춘다 (nas01:8000 으로 접속되는 것을 확인)
NAS = {'<NAS01_IP>': 'nas01', '<NAS03_IP>': 'nas03'}

def call(m, p, a=None):
    b = {'jsonrpc': '2.0', 'method': m, 'params': p, 'id': 1}
    if a: b['auth'] = a
    r = json.load(urllib.request.urlopen(urllib.request.Request(
        API, method='POST', headers={'Content-Type': 'application/json-rpc'},
        data=json.dumps(b).encode())))
    if 'error' in r: raise SystemExit(f"{m}: {json.dumps(r['error'], ensure_ascii=False)}")
    return r['result']

def main():
    if not COMMUNITY and not DRY:
        raise SystemExit('SNMP_COMMUNITY 가 필요합니다. infisical run -- python3 nas_sync.py')
    tok = call('user.login', {'username': os.environ.get('ZBX_USER', 'Admin'),
                              'password': os.environ.get('ZBX_PASS', 'zabbix')})
    tpl = call('template.get', {'output': ['templateid'], 'filter': {'host': [TPL]}}, tok)
    if not tpl: raise SystemExit(f'템플릿 없음: {TPL}')
    tplid = tpl[0]['templateid']

    hosts = call('host.get', {'output': ['hostid', 'host'],
                              'selectInterfaces': ['interfaceid', 'type', 'ip', 'main', 'port'],
                              'selectParentTemplates': ['templateid', 'name'],
                              'selectMacros': ['hostmacroid', 'macro', 'value']}, tok)
    by_ip = {i['ip']: h for h in hosts for i in h['interfaces']}

    for ip, name in NAS.items():
        h = by_ip.get(ip)
        if not h:
            print(f"  {name} ({ip}) — Zabbix 에 없음. 건너뜁니다 (수동 등록 필요)"); continue

        todo = []
        if h['host'] != name: todo.append(f"이름 {h['host']} → {name}")
        if not any(i['type'] == '2' for i in h['interfaces']): todo.append('SNMP 인터페이스 추가')
        if tplid not in [t['templateid'] for t in h['parentTemplates']]: todo.append(f'{TPL} 연결')
        if not any(m['macro'] == '{$SNMP_COMMUNITY}' for m in h['macros']): todo.append('커뮤니티 매크로')
        if not todo:
            print(f"  {name} 변경 없음"); continue
        print(f"  {name} ({ip}): {', '.join(todo)}")
        if DRY: continue

        # SNMP 인터페이스는 host.update 의 interfaces 로 통째로 넘겨야 한다 (기존 것 유지 + 추가)
        ifaces = [{'interfaceid': i['interfaceid']} for i in h['interfaces']]
        if not any(i['type'] == '2' for i in h['interfaces']):
            ifaces.append({'type': 2, 'main': 1, 'useip': 1, 'ip': ip, 'dns': '', 'port': '161',
                           'details': {'version': 2, 'community': '{$SNMP_COMMUNITY}',
                                       'bulk': 1, 'max_repetitions': 10}})
        # 'Linux by SNMP' 에 ICMP 체크가 포함돼 있어 'ICMP Ping' 과 아이템 키가 충돌한다 — 중복이니 떼어낸다
        drop = [t for t in h['parentTemplates'] if t['name'] == 'ICMP Ping']
        tpls = [{'templateid': t['templateid']} for t in h['parentTemplates'] if t not in drop]
        if tplid not in [t['templateid'] for t in tpls]: tpls.append({'templateid': tplid})
        macros = [{'macro': m['macro'], 'value': m['value']} for m in h['macros']
                  if m['macro'] != '{$SNMP_COMMUNITY}']
        macros.append({'macro': '{$SNMP_COMMUNITY}', 'value': COMMUNITY})

        params = {'hostid': h['hostid'], 'host': name, 'name': name,
                  'interfaces': ifaces, 'templates': tpls, 'macros': macros}
        if drop:
            params['templates_clear'] = [{'templateid': t['templateid']} for t in drop]
        call('host.update', params, tok)
        print(f"    적용 완료")

if __name__ == '__main__':
    main()
