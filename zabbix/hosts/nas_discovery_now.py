#!/usr/bin/env python3
"""NAS 호스트의 LLD 를 지금 실행한다 (발견 주기를 기다리지 않는다).

새 템플릿을 붙인 직후에 쓴다. Zabbix 웹 UI 의
  호스트 > 디스커버리 > (규칙) > 지금 확인
과 같은 일을 API 로 한다.

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/zabbix -- python3 hosts/nas_discovery_now.py
"""
import json
import os
import urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
HOSTS = ['nas01', 'nas03', 'NAS02-main-36']


def call(method, params, token=None):
    body = {'jsonrpc': '2.0', 'method': method, 'params': params, 'id': 1}
    if token:
        body['auth'] = token
    req = urllib.request.Request(API, json.dumps(body).encode(),
                                 {'Content-Type': 'application/json-rpc'})
    res = json.load(urllib.request.urlopen(req, timeout=60))
    if 'error' in res:
        raise SystemExit(f"{method}: {res['error']}")
    return res['result']


def main():
    pw = os.environ.get('ZBX_PASS')
    if not pw:
        raise SystemExit('ZBX_PASS 가 없다. infisical run 으로 주입해서 실행해라.')
    tok = call('user.login',
               {'username': os.environ.get('ZBX_USER', 'Admin'), 'password': pw})

    ids = []
    for hn in HOSTS:
        hs = call('host.get', {'filter': {'host': [hn]}, 'output': ['hostid', 'name']}, tok)
        if not hs:
            print(f'{hn}: 호스트 없음 — 건너뜀')
            continue
        rules = call('discoveryrule.get', {'hostids': hs[0]['hostid'],
                                           'output': ['itemid', 'name']}, tok)
        for r in rules:
            print(f"   {hs[0]['name']:<22} {r['name']}")
            ids.append(r['itemid'])
    if not ids:
        raise SystemExit('실행할 LLD 가 없다')
    call('task.create', [{'type': 6, 'request': {'itemid': i}} for i in ids], tok)
    print(f'\n{len(ids)}개 LLD 에 지금 확인 요청을 보냈다. 반영까지 1~3분 걸린다.')


if __name__ == '__main__':
    main()
