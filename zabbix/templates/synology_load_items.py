#!/usr/bin/env python3
"""Synology NAS 템플릿에 Load average 를 추가한다.

2026-09-18 에 NAS02 가 "CPU 사용률 95%" 로 보였는데 실제로는 연산 부하가 아니라
I/O 대기였다. DSM 리소스 모니터 기준 사용자 1% / 시스템 17% / **I/O 대기 78%**,
평균 로드 32. 템플릿의 'CPU 사용률' 은 100-idle 이라 I/O 대기를 연산으로
보이게 만든다 — 원인을 정반대로 읽게 된다.

Load average 를 넣으면 구분이 즉시 된다. 평소 0.5 인 NAS 가 30 이면 디스크가
막힌 것이지 CPU 가 바쁜 게 아니다. laLoad 는 문자열로 오므로 float 로 받는다.

원인은 ai-gpu04 가 09시부터 NFS 로 소형 랜덤 읽기(5763 ops/s, 평균 4KB)를
쏟아부은 것이었다. NAS02 수신 트래픽과 ai-gpu04 수신이 같은 시각에 함께 뛴다.

트리거는 경고(p2)로 둔다. 이름에 '시스템 다운' 이 없으므로 알림 액션 필터에
걸리지 않고 화면에만 뜬다 — 리소스 알람은 메신저로 보내지 않는 정책이다.

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/watch -- python3 templates/synology_load_items.py
미리 보기:  DRY_RUN=1 ...
되돌리기:   REVERT=1 ...
"""
import json
import os
import urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DRY = os.environ.get('DRY_RUN') == '1'
REVERT = os.environ.get('REVERT') == '1'

TEMPLATE = 'IMS Synology NAS by SNMP'
MACRO, MACRO_VALUE = '{$NAS.LOAD.WARN}', '8'      # DS2422+·DS920+ 둘 다 4코어 → 코어당 2.0
TRIGGER = 'I/O 부하 높음 (Load 15분 > {$NAS.LOAD.WARN})'
ITEMS = [
    ('Load average (1분)',  'syno.load.avg1',  '1.3.6.1.4.1.2021.10.1.3.1'),
    ('Load average (5분)',  'syno.load.avg5',  '1.3.6.1.4.1.2021.10.1.3.2'),
    ('Load average (15분)', 'syno.load.avg15', '1.3.6.1.4.1.2021.10.1.3.3'),
]

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
    print(('되돌리기' if REVERT else 'Synology 템플릿에 Load average 추가')
          + (' (DRY_RUN)' if DRY else ''))
    print(f'{API}\n')

    t = call('template.get', {'output': ['templateid', 'host'], 'filter': {'host': [TEMPLATE]},
                              'selectMacros': ['macro']})
    if not t:
        raise SystemExit(f"'{TEMPLATE}' 템플릿이 없다")
    t = t[0]
    tid = t['templateid']
    linked = call('host.get', {'templateids': tid, 'output': ['host']})
    print(f"{TEMPLATE} (연결 호스트 {[h['host'] for h in linked]})")

    if REVERT:
        for tr in call('trigger.get', {'templateids': tid, 'output': ['triggerid'],
                                       'filter': {'description': TRIGGER}}):
            print(f'  트리거 삭제: {TRIGGER}')
            if not DRY:
                call('trigger.delete', [tr['triggerid']])
        for _, key, _ in ITEMS:
            for i in call('item.get', {'templateids': tid, 'output': ['itemid'],
                                       'filter': {'key_': key}}):
                print(f'  아이템 삭제: {key}')
                if not DRY:
                    call('item.delete', [i['itemid']])
        print('\n되돌렸다' + (' (DRY_RUN)' if DRY else ''))
        return

    if not any(m['macro'] == MACRO for m in t['macros']):
        print(f'  매크로 {MACRO} = {MACRO_VALUE} 추가')
        if not DRY:
            call('usermacro.createglobal' if False else 'usermacro.create',
                 {'hostid': tid, 'macro': MACRO, 'value': MACRO_VALUE})
    else:
        print(f'  매크로 {MACRO} 이미 있음')

    # 템플릿 아이템은 SNMP 인터페이스를 상속받으므로 interfaceid 를 주지 않는다.
    for name, key, oid in ITEMS:
        if call('item.get', {'templateids': tid, 'output': ['itemid'], 'filter': {'key_': key}}):
            print(f'  아이템 이미 있음: {key}')
            continue
        print(f'  아이템 생성: {name}  ({oid})')
        if not DRY:
            call('item.create', {
                'hostid': tid, 'name': name, 'key_': key, 'type': 20, 'snmp_oid': oid,
                'value_type': 0, 'delay': '1m', 'history': '31d', 'trends': '365d',
                'description': 'UCD-SNMP laLoad. NAS 는 평소 1 미만이다. 이 값이 크면 '
                               'CPU 가 아니라 디스크 I/O 가 막힌 것이다 — '
                               "'CPU 사용률'(100-idle)만 보면 원인을 반대로 읽는다.",
            })

    if call('trigger.get', {'templateids': tid, 'output': ['triggerid'],
                            'filter': {'description': TRIGGER}}):
        print(f'  트리거 이미 있음')
    else:
        expr = f'min(/{TEMPLATE}/syno.load.avg15,15m)>{MACRO}'
        print(f'  트리거 생성: {TRIGGER}\n      {expr}')
        if not DRY:
            call('trigger.create', {
                'description': TRIGGER, 'expression': expr, 'priority': 2, 'manual_close': 1,
                'comments': '15분 평균 로드가 코어 수의 2배를 15분 내내 넘으면 디스크가 '
                            '따라오지 못하는 상태다. 2026-09-18 에 ai-gpu04 가 NFS 로 '
                            '소형 랜덤 읽기를 쏟아부어 NAS02 로드가 32까지 올랐다. '
                            '이름에 "시스템 다운" 이 없어 메신저 알림은 가지 않는다.',
            })

    print('\n완료' + (' (DRY_RUN — 아무것도 바꾸지 않았다)' if DRY else ''))


if __name__ == '__main__':
    main()
