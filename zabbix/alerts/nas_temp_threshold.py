#!/usr/bin/env python3
"""NAS 본체 온도 임계를 50 → 60°C 로 올린다.

`IMS Synology NAS by SNMP` 를 만들 때 본체 온도({$NAS.TEMP.WARN})와
디스크 온도({$NAS.DISK.TEMP.WARN})에 같은 50 을 넣었는데, 기준이 다르다.

  디스크(HDD)  권장 상한 45~50°C  → 50 이 맞다
  본체(케이스·메인보드)             → 시놀로지 경고 기준은 60°C 부근

2026-09-07 NAS02 실측: 본체 52°C(임계 초과), 디스크 12개는 37~40°C.
CPU 가 11:30 부터 70~90% 로 올라간 만큼 온도가 오른 자연스러운 흐름이고
위험 수준이 아니다. 주말 알림 4건이 모두 이것이었다.

템플릿 매크로를 고치므로 이 템플릿을 쓰는 NAS 전체에 적용된다.

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/zabbix -- python3 alerts/nas_temp_threshold.py

미리 보기:  DRY_RUN=1 infisical run ... -- python3 alerts/nas_temp_threshold.py
되돌리기:   REVERT=1  infisical run ... -- python3 alerts/nas_temp_threshold.py
"""
import json
import os
import urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DRY = os.environ.get('DRY_RUN') == '1'
REVERT = os.environ.get('REVERT') == '1'

TEMPLATE = 'IMS Synology NAS by SNMP'
MACRO = '{$NAS.TEMP.WARN}'
NEW, OLD = '60', '50'


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

    ts = call('template.get', {'filter': {'host': [TEMPLATE]},
                               'output': ['templateid']}, tok)
    if not ts:
        raise SystemExit(f'템플릿 {TEMPLATE!r} 를 찾지 못했다')
    tid = ts[0]['templateid']

    ms = call('usermacro.get', {'hostids': tid, 'output': 'extend',
                                'filter': {'macro': MACRO}}, tok)
    if not ms:
        raise SystemExit(f'매크로 {MACRO} 가 템플릿에 없다')
    m = ms[0]
    want = OLD if REVERT else NEW

    if m['value'] == want:
        print(f'{MACRO}: 이미 {want} — 건너뜀')
    else:
        print(f"{MACRO}: {m['value']} → {want}" + (' (DRY_RUN)' if DRY else ''))
        if not DRY:
            call('usermacro.update',
                 {'hostmacroid': m['hostmacroid'], 'value': want}, tok)

    # 디스크 임계는 손대지 않는다는 것을 눈으로 확인시켜 준다
    d = call('usermacro.get', {'hostids': tid, 'output': ['macro', 'value'],
                               'filter': {'macro': '{$NAS.DISK.TEMP.WARN}'}}, tok)
    if d:
        print(f"{d[0]['macro']}: {d[0]['value']} (그대로 — 디스크는 50 이 맞다)")

    print('\n완료' + (' (DRY_RUN — 아무것도 바꾸지 않았다)' if DRY else ''))


if __name__ == '__main__':
    main()
