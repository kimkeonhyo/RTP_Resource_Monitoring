#!/usr/bin/env python3
"""사내 공유기(AP)를 Zabbix 'IMS 네트워크 장비' 그룹에 ICMP 로 등록한다.

IMS 의 '네트워크 관제' 탭을 watch 로 옮기면서 정리한 건. 이 두 대는 SNMP 가
안 돼 IMS 에서 계속 '응답없음' 으로만 보였고 실제로 수집된 적이 없다.
둘 다 ping 에는 응답하므로 ICMP Ping 템플릿이면 up/down 은 잡힌다.

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/zabbix -- python3 wifi_ap_sync.py

이미 있는 호스트는 건너뛰므로 여러 번 돌려도 안전하다.
"""
import json
import os
import urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
GROUP = 'IMS 네트워크 장비'
TEMPLATE = 'ICMP Ping'
APS = [
    ('office_wifi', 'office_wifi (IP-Time)', '<OFFICE_WIFI_OLD_IP>'),
    ('kt_wifi',       'kt_wifi (KT)',            '<KT_WIFI_IP>'),
]


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


def one(items, what):
    if not items:
        raise SystemExit(f'{what} 를 찾지 못했다')
    return items[0]


def main():
    pw = os.environ.get('ZBX_PASS')
    if not pw:
        raise SystemExit('ZBX_PASS 가 없다. infisical run 으로 주입해서 실행해라.')

    tok = call('user.login',
               {'username': os.environ.get('ZBX_USER', 'Admin'), 'password': pw})

    gid = one(call('hostgroup.get',
                   {'output': ['groupid'], 'filter': {'name': [GROUP]}}, tok),
              f'호스트 그룹 {GROUP!r}')['groupid']
    tid = one(call('template.get',
                   {'output': ['templateid'], 'filter': {'host': [TEMPLATE]}}, tok),
              f'템플릿 {TEMPLATE!r}')['templateid']

    for host, name, ip in APS:
        if call('host.get', {'output': ['hostid'], 'filter': {'host': [host]}}, tok):
            print(f'{host}: 이미 있음 — 건너뜀')
            continue
        call('host.create', {
            'host': host,
            'name': name,
            'groups': [{'groupid': gid}],
            'templates': [{'templateid': tid}],
            # SNMP 가 안 되는 기기라 ICMP 만 본다. 인터페이스는 IP 를 들고 있으려고
            # 두는 것이라 agent 타입이어도 폴링에는 쓰이지 않는다.
            'interfaces': [{'type': 1, 'main': 1, 'useip': 1,
                            'ip': ip, 'dns': '', 'port': '10050'}],
        }, tok)
        print(f'{host}: 등록 완료 ({ip})')


if __name__ == '__main__':
    main()
