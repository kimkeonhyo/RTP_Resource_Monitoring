#!/usr/bin/env python3
"""Synology 템플릿의 CPU 지표를 DSM 과 같은 기준으로 가른다.

`CPU 사용률` 이 계산식 `100-last(//syno.cpu.idle)` 이라 **I/O 대기가 통째로
포함**된다. 그래서 디스크가 막혀 있을 때 "CPU 95%" 로 보이고, 정작 프로세스
목록에는 CPU 를 먹는 게 없어 원인을 정반대로 읽게 된다.

2026-09-18·09-21 에 두 번 이걸로 헤맸다. DSM 리소스 모니터와 대조하면 분명하다.

  DSM      사용자 2%  시스템 15%  I/O 대기 77%   → '이용' 17%
  기존 항목 100 - idle(4) = 96%                  ← I/O 대기가 더해진 값

UCD 게이지가 세 개 다 있어서 그대로 가를 수 있다 (NAS02·nas03 확인).
  ssCpuUser   .1.3.6.1.4.1.2021.11.9.0
  ssCpuSystem .1.3.6.1.4.1.2021.11.10.0
  ssCpuIdle   .1.3.6.1.4.1.2021.11.11.0   (이미 syno.cpu.idle 로 수집 중)

바꾸는 것
  · 추가: CPU 사용자(%), CPU 시스템(%), I/O 대기(%)
  · `CPU 사용률` 계산식을 user+system 으로 바꿔 DSM '이용' 과 같게 만든다

주의: syno.cpu.util 의 과거 이력은 의미가 달라진다(이전에는 I/O 대기 포함).
키를 유지하므로 그래프가 이어져 보이지만 09-21 이전 값과는 비교하면 안 된다.

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/watch -- python3 templates/synology_cpu_breakdown.py
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
NEW_SNMP = [
    ('CPU 사용자', 'syno.cpu.user',   '1.3.6.1.4.1.2021.11.9.0'),
    ('CPU 시스템', 'syno.cpu.system', '1.3.6.1.4.1.2021.11.10.0'),
]
IOWAIT = ('I/O 대기', 'syno.cpu.iowait',
          '100-last(//syno.cpu.idle)-last(//syno.cpu.user)-last(//syno.cpu.system)')
UTIL_KEY = 'syno.cpu.util'
UTIL_NEW = 'last(//syno.cpu.user)+last(//syno.cpu.system)'
UTIL_OLD = '100-last(//syno.cpu.idle)'

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
    print(('되돌리기' if REVERT else 'Synology CPU 지표 분리') + (' (DRY_RUN)' if DRY else ''))
    print(f'{API}\n')

    tid = call('template.get', {'output': ['templateid'],
                                'filter': {'host': [TEMPLATE]}})[0]['templateid']
    have = {i['key_']: i for i in call('item.get', {'templateids': tid,
                                                    'output': ['itemid', 'key_', 'params', 'name']})}

    if REVERT:
        for key in [IOWAIT[1]] + [k for _, k, _ in NEW_SNMP]:
            if key in have:
                print(f'  아이템 삭제: {key}')
                if not DRY:
                    call('item.delete', [have[key]['itemid']])
        if UTIL_KEY in have and have[UTIL_KEY]['params'] != UTIL_OLD:
            print(f'  {UTIL_KEY} 계산식 원복')
            if not DRY:
                call('item.update', {'itemid': have[UTIL_KEY]['itemid'], 'params': UTIL_OLD})
        print('\n되돌렸다' + (' (DRY_RUN)' if DRY else ''))
        return

    # SNMP 게이지 두 개
    for name, key, oid in NEW_SNMP:
        if key in have:
            print(f'  아이템 이미 있음: {key}')
            continue
        print(f'  아이템 생성: {name} ({oid})')
        if not DRY:
            call('item.create', {
                'hostid': tid, 'name': name, 'key_': key, 'type': 20, 'snmp_oid': oid,
                'value_type': 0, 'units': '%', 'delay': '1m', 'history': '31d', 'trends': '365d',
                'description': 'UCD-SNMP 1분 평균. DSM 리소스 모니터의 같은 항목과 일치한다.',
            })

    # 계산 아이템 I/O 대기
    if IOWAIT[1] in have:
        print(f'  아이템 이미 있음: {IOWAIT[1]}')
    else:
        print(f'  아이템 생성: {IOWAIT[0]}  {IOWAIT[2]}')
        if not DRY:
            call('item.create', {
                'hostid': tid, 'name': IOWAIT[0], 'key_': IOWAIT[1], 'type': 15,
                'params': IOWAIT[2], 'value_type': 0, 'units': '%', 'delay': '1m',
                'history': '31d', 'trends': '365d',
                'description': '디스크를 기다리느라 놀고 있는 비율. 이 값이 크면 CPU 가 아니라 '
                               '스토리지가 병목이다. 반올림 때문에 아주 작은 음수가 나올 수 있다.',
            })

    # CPU 사용률 의미 교정
    if UTIL_KEY not in have:
        print(f'  ⚠ {UTIL_KEY} 없음 — 수동 확인 필요')
    elif have[UTIL_KEY]['params'] == UTIL_NEW:
        print(f'  {UTIL_KEY} 이미 교정됨')
    else:
        print(f"  {UTIL_KEY} 계산식 교정")
        print(f"      {have[UTIL_KEY]['params']}  →  {UTIL_NEW}")
        if not DRY:
            call('item.update', {
                'itemid': have[UTIL_KEY]['itemid'], 'params': UTIL_NEW,
                'description': 'DSM 리소스 모니터의 "이용" 과 같은 기준(사용자+시스템). '
                               'I/O 대기는 syno.cpu.iowait 으로 따로 본다. '
                               '2026-09-21 이전 이력은 I/O 대기가 포함된 값이라 비교하면 안 된다.',
            })

    print('\n완료' + (' (DRY_RUN — 아무것도 바꾸지 않았다)' if DRY else ''))


if __name__ == '__main__':
    main()
