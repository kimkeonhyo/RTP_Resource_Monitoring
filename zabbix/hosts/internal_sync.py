#!/usr/bin/env python3
"""사내 호스트를 인벤토리 이름으로 맞추고 에이전트 템플릿을 붙인다.

NetBox 에서 넘어온 임시 이름(nb-10-128-30-38 등)을 인벤토리=DNS 이름으로 바꾼다.
에이전트의 Hostname 이 인벤토리 이름이라, 이름이 맞아야 액티브 체크가 이 호스트에 붙는다.
  python3 internal_sync.py [--dry-run]
"""
import json, os, re, sys, urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
INV = os.environ.get('INVENTORY', os.path.expanduser(
    'ansible/inventory/ims/hosts.ini'))
SKIP = {'unreachable', 'nas', 'remote_site', 'ims:children'}
WANT_TPL = ['Linux by Zabbix agent', 'IMS NVIDIA GPU by Zabbix agent']
DRY = '--dry-run' in sys.argv

def call(m, p, a=None):
    b = {'jsonrpc': '2.0', 'method': m, 'params': p, 'id': 1}
    if a: b['auth'] = a
    r = json.load(urllib.request.urlopen(urllib.request.Request(
        API, method='POST', headers={'Content-Type': 'application/json-rpc'},
        data=json.dumps(b).encode())))
    if 'error' in r: raise SystemExit(f"{m}: {json.dumps(r['error'], ensure_ascii=False)}")
    return r['result']

def inventory(path):
    out, cur = {}, None
    for line in open(path):
        line = line.strip()
        if line.startswith('[') and line.endswith(']'): cur = line[1:-1]; continue
        if not line or line.startswith('#') or cur in SKIP or cur is None: continue
        m = re.match(r'^(\S+)\s+.*ansible_host=(\S+)', line)
        if not m: continue
        a = re.search(r'asset_name="([^"]+)"', line)
        out[m.group(2)] = (m.group(1), a.group(1) if a else m.group(1))
    return out

def main():
    want = inventory(INV)
    tok = call('user.login', {'username': os.environ.get('ZBX_USER', 'Admin'),
                              'password': os.environ.get('ZBX_PASS', 'zabbix')})
    tpl = {t['host']: t['templateid'] for t in
           call('template.get', {'output': ['templateid', 'host'], 'filter': {'host': WANT_TPL}}, tok)}
    missing = [n for n in WANT_TPL if n not in tpl]
    if missing: raise SystemExit(f'템플릿 없음: {missing}')

    ic = call('template.get', {'output': ['templateid'], 'filter': {'host': ['ICMP Ping']}}, tok)
    icmp = ic[0]['templateid'] if ic else None
    gg = call('hostgroup.get', {'output': ['groupid'],
                                'filter': {'name': ['IMS 서버·워크스테이션']}}, tok)
    if not gg: raise SystemExit('호스트 그룹 없음: IMS 서버·워크스테이션')
    GROUPID = gg[0]['groupid']

    hosts = call('host.get', {'output': ['hostid', 'host', 'name'],
                              'selectInterfaces': ['type', 'ip'],
                              'selectParentTemplates': ['templateid', 'name']}, tok)
    by_ip = {i['ip']: h for h in hosts for i in h['interfaces']}

    for ip, (name, asset) in sorted(want.items()):
        h = by_ip.get(ip)
        if not h:
            print(f"  {name:14} {ip:16} 신규 등록 ({asset})")
            if DRY: continue
            call('host.create', {
                'host': name, 'name': asset,
                'groups': [{'groupid': GROUPID}],
                'templates': [{'templateid': t} for t in list(tpl.values()) + [icmp]],
                'interfaces': [{'type': 1, 'main': 1, 'useip': 1,
                                'ip': ip, 'dns': '', 'port': '10050'}],
            }, tok)
            print("      생성 완료"); continue
        have = {t['templateid'] for t in h['parentTemplates']}
        todo = []
        if h['host'] != name:
            keep = '' if h['name'] == h['host'] else f" (표시 이름 '{h['name']}' 유지)"
            todo.append(f"이름 {h['host']} → {name}{keep}")
        add = [t for n, t in tpl.items() if t not in have]
        if add: todo.append(f"템플릿 {len([n for n,t in tpl.items() if t not in have])}개 연결")
        if not todo:
            continue
        print(f"  {name:14} {ip:16} {', '.join(todo)}")
        if DRY: continue
        # 기술 이름(host)만 인벤토리에 맞춘다. 사람이 붙인 표시 이름(name)은 그대로 둔다
        # — 'WS (07)' 처럼 자산명이 들어가 있으면 그게 더 알아보기 쉽다.
        params = {'hostid': h['hostid'], 'host': name,
                  'templates': [{'templateid': t} for t in have | set(add)]}
        # Zabbix 는 host 를 바꾸면 표시 이름도 따라가게 처리한다 — 지키려면 명시적으로 넘겨야 한다.
        params['name'] = name if h['name'] == h['host'] else h['name']
        call('host.update', params, tok)
        print("      적용 완료" + ('' if params['name'] == name else f" (표시 이름 '{h['name']}' 유지)"))

if __name__ == '__main__':
    main()
