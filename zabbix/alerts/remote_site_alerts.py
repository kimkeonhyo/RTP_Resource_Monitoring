#!/usr/bin/env python3
"""고객사 사이트를 알림 대상에 넣는다 (그라파나 전환 전 임시).

'IMS 고객사'(그룹 24) 6대는 어떤 알림 액션에도 걸려 있지 않았다. 그라파나로
볼 계획이었는데 연결이 정리되지 않아 그동안 무방비였다. 2026-09-09 13:53 에
site-a 사이트가 통째로 끊겼는데 메신저로 한 건도 안 나갔고, 다른 작업 중
우연히 발견했다.

다른 그룹과 같은 방식으로 맞춘다 — 트리거 이름이 '시스템 다운' 인 것만
알림이 나가고, 리소스 사용률·온도는 화면에만 뜬다.

판정 수단이 다르다. 사내·클라우드는 ICMP 와 에이전트를 AND 로 묶지만,
고객사는 테일넷으로만 닿고 ICMP Ping 템플릿이 없다. 에이전트 가용성
하나로 판정한다 — 사이트 회선이 끊기면 어차피 둘 다 죽으므로 AND 로 묶어도
얻는 게 없다.

액션을 기존 9번에 합치지 않고 따로 만든다. 그라파나로 넘길 때 이 액션 하나만
끄면 되도록.

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/watch -- python3 alerts/remote_site_alerts.py

미리 보기:  DRY_RUN=1 ...
되돌리기:   REVERT=1 ...   (액션·트리거 제거)
"""
import json
import os
import urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DRY = os.environ.get('DRY_RUN') == '1'
REVERT = os.environ.get('REVERT') == '1'

GROUP = '24'                       # IMS 고객사
ACTION = 'IMS 고객사 다운 알림 (임시 — Grafana 전환 전)'
TRIGGER = '시스템 다운 (에이전트 5분 불통)'
KEY = 'zabbix[host,agent,available]'
MEDIATYPE, USRGRP = '53', '7'      # MS Teams Workflow / 알림 받는 사용자 그룹
CT_GROUP, CT_TRIGGER_NAME, CT_SEVERITY = 0, 3, 4
OP_EQ, OP_LIKE, OP_GE = 0, 2, 5

_token = None


def call(method, params):
    body = {'jsonrpc': '2.0', 'method': method, 'params': params, 'id': 1}
    headers = {'Content-Type': 'application/json-rpc'}
    if _token:
        headers['Authorization'] = f'Bearer {_token}'
    r = urllib.request.Request(API, json.dumps(body).encode(), headers)
    out = json.load(urllib.request.urlopen(r, timeout=60))
    if 'error' in out:
        raise SystemExit(f"{method} → {out['error']}")
    return out['result']


def login():
    global _token
    _token = os.environ.get('ZABBIX_TOKEN') or os.environ.get('ZBX_TOKEN')
    if _token:
        return
    pw = os.environ.get('ZBX_PASS')
    if not pw:
        raise SystemExit('ZABBIX_TOKEN 이나 ZBX_PASS 가 필요하다.')
    _token = call('user.login', {'username': os.environ.get('ZBX_USER', 'Admin'), 'password': pw})


def main():
    login()
    print(('되돌리기' if REVERT else '고객사 알림 설정') + (' (DRY_RUN)' if DRY else ''))
    print(f'{API}\n')

    hosts = call('host.get', {'groupids': GROUP, 'output': ['hostid', 'host', 'name'],
                              'monitored_hosts': True})
    print(f'대상 {len(hosts)}대')

    for h in sorted(hosts, key=lambda x: x['host']):
        have = call('trigger.get', {'hostids': h['hostid'], 'output': ['triggerid'],
                                    'filter': {'description': TRIGGER}})
        if REVERT:
            if have:
                print(f"  {h['host']:<12} 트리거 삭제")
                if not DRY:
                    call('trigger.delete', [t['triggerid'] for t in have])
            continue
        if have:
            print(f"  {h['host']:<12} 트리거 이미 있음")
            continue
        # 아이템이 없으면 식이 성립하지 않는다. 만들기 전에 확인한다.
        if not call('item.get', {'hostids': h['hostid'], 'output': ['itemid'],
                                 'filter': {'key_': KEY}}):
            print(f"  {h['host']:<12} ⚠ {KEY} 아이템이 없어 건너뜀")
            continue
        expr = f'max(/{h["host"]}/{KEY},5m)=0'
        print(f"  {h['host']:<12} 트리거 생성  {expr}")
        if not DRY:
            call('trigger.create', {
                'description': TRIGGER, 'expression': expr, 'priority': 5, 'manual_close': 1,
                'comments': '에이전트가 5분간 응답하지 않으면 사이트가 끊긴 것으로 본다. '
                            '고객사는 테일넷으로만 닿고 ICMP Ping 템플릿이 없어 '
                            '사내·클라우드처럼 ICMP 와 AND 로 묶지 않는다.',
            })

    existing = call('action.get', {'output': ['actionid', 'name', 'status'],
                                   'filter': {'name': [ACTION]}})
    if REVERT:
        if existing:
            print(f"\n액션 삭제: {ACTION}")
            if not DRY:
                call('action.delete', [existing[0]['actionid']])
        print('\n되돌렸다' + (' (DRY_RUN)' if DRY else ''))
        return

    if existing:
        print(f"\n액션 이미 있음 [{existing[0]['actionid']}] "
              f"({'사용' if existing[0]['status'] == '0' else '중지'})")
    else:
        print(f"\n액션 생성: {ACTION}")
        print(f"   심각도>=3 and 그룹={GROUP} and 이름 like '시스템 다운'")
        if not DRY:
            msg = {'operationtype': 0,
                   'opmessage': {'default_msg': 1, 'mediatypeid': MEDIATYPE},
                   'opmessage_grp': [{'usrgrpid': USRGRP}]}
            call('action.create', {
                'name': ACTION, 'eventsource': 0, 'status': 0, 'esc_period': '1h',
                'pause_suppressed': 1, 'notify_if_canceled': 1,
                'filter': {'evaltype': 0, 'conditions': [
                    {'conditiontype': CT_SEVERITY, 'operator': OP_GE, 'value': '3'},
                    {'conditiontype': CT_GROUP, 'operator': OP_EQ, 'value': GROUP},
                    {'conditiontype': CT_TRIGGER_NAME, 'operator': OP_LIKE, 'value': '시스템 다운'},
                ]},
                'operations': [msg],
                'recovery_operations': [{k: v for k, v in msg.items()}],
            })

    print('\n완료' + (' (DRY_RUN — 아무것도 바꾸지 않았다)' if DRY else ''))
    if not DRY and not REVERT:
        print('그라파나로 넘길 때 이 액션만 끄면 된다.')


if __name__ == '__main__':
    main()
