#!/usr/bin/env python3
"""고객사 사이트 자동 등록 설정.

에이전트가 HostMetadata 로 'remote' 를 알리면 전용 그룹에 넣고 템플릿을 붙인다.
사내 장비는 Zabbix 에 이미 같은 이름으로 있어 자동 등록을 타지 않는다.
  python3 remote_autoreg.py [--dry-run]
"""
import json, os, sys, urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DRY = '--dry-run' in sys.argv
GROUP = 'IMS 고객사'
TEMPLATES = ['Linux by Zabbix agent', 'IMS NVIDIA GPU by Zabbix agent']
ACTION = '고객사 사이트 자동 등록'

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
    if g:
        gid = g[0]['groupid']; print(f"[그룹] {GROUP} 이미 있음 (id={gid})")
    elif DRY:
        gid = '?'; print(f"[그룹] {GROUP} 생성 예정")
    else:
        gid = call('hostgroup.create', {'name': GROUP}, tok)['groupids'][0]
        print(f"[그룹] {GROUP} 생성 (id={gid})")

    tids = []
    for name in TEMPLATES:
        t = call('template.get', {'output': ['templateid'], 'filter': {'host': [name]}}, tok)
        if t: tids.append(t[0]['templateid'])
        else: print(f"[경고] 템플릿 없음: {name}")

    if call('action.get', {'output': ['actionid'], 'filter': {'name': [ACTION]}}, tok):
        print(f"[액션] {ACTION} 이미 있음"); return
    if DRY:
        print(f"[액션] {ACTION} 생성 예정 (조건: HostMetadata contains 'remote')"); return

    call('action.create', {
        'name': ACTION,
        'eventsource': 2,                      # 자동 등록
        'status': 0,
        'filter': {'evaltype': 0, 'conditions': [
            {'conditiontype': 24, 'operator': 2, 'value': 'remote'},   # HostMetadata contains
        ]},
        'operations': [
            {'operationtype': 2},                                       # 호스트 추가
            {'operationtype': 4, 'opgroup': [{'groupid': gid}]},        # 그룹에 넣기
            {'operationtype': 6, 'optemplate': [{'templateid': t} for t in tids]},
        ],
    }, tok)
    print(f"[액션] {ACTION} 생성 — 조건: HostMetadata 에 'remote' 포함")
    print(f"       동작: 호스트 추가 → '{GROUP}' 그룹 → {TEMPLATES}")

if __name__ == '__main__':
    main()
