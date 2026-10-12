#!/usr/bin/env python3
"""NAS02 서브NIC 호스트를 Zabbix 에서 비활성화한다.

NIC 를 일부러 내려 둔 것이라 ICMP Ping 이 영원히 'Unavailable' 로 뜬다.
삭제 대신 비활성화 — 나중에 NIC 를 다시 올리면 되살리면 된다.
NAS02 본체는 메인NIC(<NAS02_IP>) 호스트가 SNMP 로 정상 수집 중이므로
이걸 꺼도 관제 공백은 없다.

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/zabbix -- python3 nas02_subnic_off.py

되돌리려면 ENABLE=1 을 주면 된다:
    ... -- ENABLE=1 python3 nas02_subnic_off.py
"""
import json
import os
import urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
TARGET = 'NAS02-192TB'          # 서브NIC <NAS02_SUBNIC_IP>
ENABLE = os.environ.get('ENABLE') == '1'


def call(method, params, token=None):
    body = {'jsonrpc': '2.0', 'method': method, 'params': params, 'id': 1}
    if token:
        body['auth'] = token
    req = urllib.request.Request(API, json.dumps(body).encode(),
                                 {'Content-Type': 'application/json-rpc'})
    res = json.load(urllib.request.urlopen(req, timeout=20))
    if 'error' in res:
        raise SystemExit(f"{method}: {res['error']}")
    return res['result']


def main():
    pw = os.environ.get('ZBX_PASS')
    if not pw:
        raise SystemExit('ZBX_PASS 가 없다. infisical run 으로 주입해서 실행해라.')

    tok = call('user.login',
               {'username': os.environ.get('ZBX_USER', 'Admin'), 'password': pw})

    hosts = call('host.get',
                 {'output': ['hostid', 'name', 'status'],
                  'filter': {'host': [TARGET]}}, tok)
    if not hosts:
        raise SystemExit(f'호스트 {TARGET!r} 를 찾지 못했다')
    h = hosts[0]

    want = '0' if ENABLE else '1'          # 0=활성, 1=비활성
    label = '활성' if ENABLE else '비활성'
    if h['status'] == want:
        print(f"{h['name']}: 이미 {label} — 건너뜀")
        return

    call('host.update', {'hostid': h['hostid'], 'status': int(want)}, tok)
    print(f"{h['name']}: {label}로 변경")


if __name__ == '__main__':
    main()
