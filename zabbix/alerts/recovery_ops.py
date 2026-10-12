#!/usr/bin/env python3
"""알림 액션에 복구 동작을 붙인다.

Zabbix 는 장애(operations)와 복구(recovery_operations)를 따로 설정한다.
두 액션 모두 장애 쪽만 있어서, 문제가 해소돼도 Teams 에 아무것도 가지 않았다.
(2026-09-07 ai-gpu04 가 13:32 에 복구됐는데 알림이 없어 확인됨)

메시지는 미디어 타입의 복구 템플릿을 그대로 쓴다 — alerts/alert_korean.py 가
'[복구] {EVENT.DURATION} 만에 해소 — {EVENT.NAME}' 로 이미 넣어 두었다.

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/zabbix -- python3 alerts/recovery_ops.py

미리 보기:
    DRY_RUN=1 infisical run ... -- python3 alerts/recovery_ops.py

되돌리려면 (복구 동작 제거):
    REVERT=1 infisical run ... -- python3 alerts/recovery_ops.py
"""
import json
import os
import urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DRY = os.environ.get('DRY_RUN') == '1'
REVERT = os.environ.get('REVERT') == '1'

ACTIONS = ['인프라 장애 알림', '서버·워크스테이션 알림']


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

    for name in ACTIONS:
        acts = call('action.get', {'output': ['actionid', 'name'],
                                   'filter': {'name': [name]},
                                   'selectOperations': 'extend',
                                   'selectRecoveryOperations': 'extend'}, tok)
        if not acts:
            print(f'{name}: 액션 없음 — 건너뜀')
            continue
        a = acts[0]
        have = len(a['recovery_operations'])

        if REVERT:
            if not have:
                print(f'{name}: 복구 동작 없음 — 건너뜀')
                continue
            print(f'{name}: 복구 동작 {have}개 제거' + (' (DRY_RUN)' if DRY else ''))
            if not DRY:
                call('action.update',
                     {'actionid': a['actionid'], 'recovery_operations': []}, tok)
            continue

        if have:
            print(f'{name}: 이미 복구 동작 {have}개 — 건너뜀')
            continue

        # 장애 동작과 같은 수신자·미디어로 보낸다. 받는 사람이 달라지면 헷갈린다.
        src = next((o for o in a['operations'] if o['operationtype'] == '0'), None)
        if not src:
            print(f'{name}: 메시지 동작이 없어 수신자를 알 수 없다 — 건너뜀')
            continue

        op = {
            'operationtype': 0,                       # 0 = 메시지 전송
            'opmessage': {
                'default_msg': 1,                     # 미디어 타입의 복구 템플릿을 쓴다
                'mediatypeid': src['opmessage']['mediatypeid'],
            },
            'opmessage_grp': [{'usrgrpid': g['usrgrpid']}
                              for g in src.get('opmessage_grp', [])],
            'opmessage_usr': [{'userid': u['userid']}
                              for u in src.get('opmessage_usr', [])],
        }
        grp = [g['usrgrpid'] for g in op['opmessage_grp']]
        print(f"{name}: 복구 동작 추가 (미디어 {op['opmessage']['mediatypeid']}, "
              f"사용자그룹 {grp})" + (' (DRY_RUN)' if DRY else ''))
        if not DRY:
            call('action.update',
                 {'actionid': a['actionid'], 'recovery_operations': [op]}, tok)

    print('\n완료' + (' (DRY_RUN — 아무것도 바꾸지 않았다)' if DRY else ''))


if __name__ == '__main__':
    main()
