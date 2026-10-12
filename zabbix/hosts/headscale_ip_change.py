#!/usr/bin/env python3
"""headscale 호스트의 에이전트 인터페이스 주소를 새 VM 주소로 옮긴다.

MIG 가 인스턴스를 재생성(demo-infra-platform-hs-xxxx)하면서 내부 주소가
<HEADSCALE_OLD_IP> 에서 <HEADSCALE_IP> 로 바뀌었다. 부팅 디스크도 새것이라 에이전트가
사라져 Ansible 로 다시 깔았고(install-zabbix-cloud), 남은 것은 Zabbix 가
아직 옛 주소를 보고 있는 것이다.

  avail=2 / "cannot establish TCP connection to [[<HEADSCALE_OLD_IP>]:10050]"

자동 등록으로 고쳐지기를 기다리지 않는다 — 호스트가 이미 있으면 등록 액션은
아무것도 하지 않으므로 인터페이스는 옛 주소로 남는다.

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/zabbix -- python3 hosts/headscale_ip_change.py

미리 보기:  DRY_RUN=1 ...
"""
import json
import os
import urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DRY = os.environ.get('DRY_RUN') == '1'

HOST = 'headscale'
OLD_IP = '<HEADSCALE_OLD_IP>'
NEW_IP = '<HEADSCALE_IP>'

_tok = None


def call(method, params):
    body = {'jsonrpc': '2.0', 'method': method, 'params': params, 'id': 1}
    head = {'Content-Type': 'application/json-rpc'}
    if _tok:
        head['Authorization'] = 'Bearer ' + _tok
    req = urllib.request.Request(API, json.dumps(body).encode(), head)
    out = json.load(urllib.request.urlopen(req, timeout=30))
    if 'error' in out:
        raise SystemExit(f"{method} → {out['error']}")
    return out['result']


def main():
    global _tok
    pw = os.environ.get('ZBX_PASS')
    if not pw:
        raise SystemExit('ZBX_PASS 가 필요합니다. infisical run -- python3 hosts/headscale_ip_change.py')
    _tok = call('user.login', {'username': os.environ.get('ZBX_USER', 'Admin'), 'password': pw})

    hosts = call('host.get', {'filter': {'host': [HOST]}, 'output': ['hostid', 'host'],
                              'selectInterfaces': ['interfaceid', 'ip', 'type', 'main']})
    if not hosts:
        raise SystemExit(f'호스트 없음: {HOST}')
    h = hosts[0]
    print(f"{h['host']} (hostid {h['hostid']})" + (' (DRY_RUN)' if DRY else ''))

    # type 1 = 에이전트 인터페이스
    agent = [i for i in h['interfaces'] if i['type'] == '1']
    if not agent:
        raise SystemExit('에이전트 인터페이스가 없다')

    for i in agent:
        if i['ip'] == NEW_IP:
            print(f"  인터페이스 {i['interfaceid']} 이미 {NEW_IP}")
            continue
        if i['ip'] != OLD_IP:
            raise SystemExit(f"  인터페이스 {i['interfaceid']} 주소가 {i['ip']} — 예상({OLD_IP})과 달라 멈춘다")
        print(f"  인터페이스 {i['interfaceid']}  {OLD_IP} → {NEW_IP}")
        if not DRY:
            call('hostinterface.update', {'interfaceid': i['interfaceid'], 'ip': NEW_IP})

    print('완료' if not DRY else '미리 보기였다 — DRY_RUN 없이 다시 실행하면 적용된다')


if __name__ == '__main__':
    main()
