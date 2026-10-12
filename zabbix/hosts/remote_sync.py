#!/usr/bin/env python3
"""자동 등록된 고객사 호스트의 인터페이스 IP 를 인벤토리 값으로 교정한다.

에이전트가 Docker NAT 를 거쳐 접속하므로 Zabbix 는 출발지를 게이트웨이(<DOCKER_NAT_GATEWAY_IP>)로 본다.
그 주소로는 패시브 체크가 나가지 못해 수집이 0 이 된다. 인벤토리의 실제 IP 로 바꿔준다.
  python3 remote_sync.py [--dry-run]
"""
import json, os, re, sys, urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
INV = os.environ.get('INVENTORY',
                     os.path.expanduser('ansible/inventory/ims/hosts.ini'))
SECTION = os.environ.get('SECTION', 'remote_site')
DRY = '--dry-run' in sys.argv

def inventory_ips(path, section):
    """[section] 블록에서 호스트명 → ansible_host 를 뽑는다"""
    out, cur = {}, None
    for line in open(path):
        line = line.strip()
        if line.startswith('[') and line.endswith(']'):
            cur = line[1:-1]; continue
        if cur != section or not line or line.startswith('#'):
            continue
        m = re.match(r'^(\S+)\s+.*ansible_host=(\S+)', line)
        if m: out[m.group(1)] = m.group(2)
    return out

def call(m, p, a=None):
    b = {'jsonrpc': '2.0', 'method': m, 'params': p, 'id': 1}
    if a: b['auth'] = a
    r = json.load(urllib.request.urlopen(urllib.request.Request(
        API, method='POST', headers={'Content-Type': 'application/json-rpc'},
        data=json.dumps(b).encode())))
    if 'error' in r: raise SystemExit(f"{m}: {json.dumps(r['error'], ensure_ascii=False)}")
    return r['result']

def main():
    want = inventory_ips(INV, SECTION)
    if not want: raise SystemExit(f'인벤토리에서 [{SECTION}] 호스트를 찾지 못했습니다: {INV}')
    tok = call('user.login', {'username': os.environ.get('ZBX_USER', 'Admin'),
                              'password': os.environ.get('ZBX_PASS', 'zabbix')})
    hosts = call('host.get', {'output': ['hostid', 'host'], 'filter': {'host': list(want)},
                              'selectInterfaces': ['interfaceid', 'type', 'ip', 'useip', 'port']}, tok)
    seen = set()
    for h in hosts:
        seen.add(h['host'])
        ip = want[h['host']]
        agent = [i for i in h['interfaces'] if i['type'] == '1']
        if not agent:
            print(f"  {h['host']:10} 에이전트 인터페이스 없음 — 건너뜀"); continue
        i = agent[0]
        if i['ip'] == ip and i['useip'] == '1':
            print(f"  {h['host']:10} {ip} 변경 없음"); continue
        print(f"  {h['host']:10} {i['ip']} → {ip}")
        if not DRY:
            call('hostinterface.update', {'interfaceid': i['interfaceid'],
                                          'ip': ip, 'useip': 1, 'dns': ''}, tok)
    for name in want:
        if name not in seen:
            print(f"  {name:10} 아직 자동 등록되지 않음 (에이전트 배포 전이거나 접속 대기)")

if __name__ == '__main__':
    main()
