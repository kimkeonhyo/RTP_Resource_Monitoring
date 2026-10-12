#!/usr/bin/env python3
"""고객사 워크스테이션의 실패한 Speed 아이템을 비활성화한다.

tailscale0·usb0·무선 등 링크 속도 개념이 없는 인터페이스는 커널이 -1 을 반환하고,
템플릿이 그것을 unsigned 로 받으려다 실패한다. 트래픽은 그대로 두고 Speed 만 끈다.
  python3 remote_speed_off.py [--dry-run]
"""
import json, os, sys, urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
GROUP = os.environ.get('GROUP', 'IMS 고객사')
DRY = '--dry-run' in sys.argv

def call(m, p, a=None):
    b = {'jsonrpc': '2.0', 'method': m, 'params': p, 'id': 1}
    if a: b['auth'] = a
    r = json.load(urllib.request.urlopen(urllib.request.Request(
        API, method='POST', headers={'Content-Type': 'application/json-rpc'},
        data=json.dumps(b).encode())))
    if 'error' in r: raise SystemExit(f"{m}: {json.dumps(r['error'], ensure_ascii=False)}")
    return r['result']

def main():
    tok = call('user.login', {'username': os.environ.get('ZBX_USER', 'Admin'),
                              'password': os.environ.get('ZBX_PASS', 'zabbix')})
    g = call('hostgroup.get', {'output': ['groupid'], 'filter': {'name': [GROUP]}}, tok)
    if not g: raise SystemExit(f'그룹 없음: {GROUP}')

    hosts = call('host.get', {'output': ['hostid', 'host'], 'groupids': [g[0]['groupid']],
                              'selectItems': ['itemid', 'name', 'state', 'status']}, tok)
    ids = []
    for h in sorted(hosts, key=lambda x: x['host']):
        # 지금 실패 중인(state=1) Speed 아이템만. 정상 동작하는 유선 인터페이스는 건드리지 않는다.
        bad = [i for i in h['items']
               if ': Speed' in i['name'] and i['state'] == '1' and i['status'] == '0']
        if not bad:
            print(f"  {h['host']:10} 대상 없음"); continue
        print(f"  {h['host']:10} {len(bad)}개")
        for i in bad: print(f"      {i['name']}")
        ids += [i['itemid'] for i in bad]

    if not ids:
        print('비활성화할 아이템 없음'); return
    if DRY:
        print(f'[dry-run] 총 {len(ids)}개 비활성화 예정'); return
    call('item.update', [{'itemid': i, 'status': 1} for i in ids], tok)
    print(f'총 {len(ids)}개 비활성화 완료')

if __name__ == '__main__':
    main()
