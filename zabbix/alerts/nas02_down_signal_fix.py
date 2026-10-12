#!/usr/bin/env python3
"""NAS02 다운 판정을 SNMP 응답에서 SSH·DSM 포트로 바꾼다.

2026-09-10 에 NAS02 가 ICMP 에 답하지 않아 다운 판정을 SNMP 응답 여부로
바꿨는데(`max(zabbix[host,snmp,available],5m)=0`), 이번엔 그게 오탐을 냈다.
`zabbix[host,snmp,available]` 는 **장비가 살아있는지**가 아니라 **Zabbix 가
SNMP 폴링에 성공했는지**를 나타낸다. 장비 CPU 가 포화되면 snmpd 가 3초 안에
응답하지 못해 0 이 된다.

2026-09-18 실측:
  · SNMP 실패 70건(24시간) — 전부 이 호스트만. nas01·nas03·스위치 5대는 0건
  · 그 70건 **전부** DSM(5001) 응답 정상, 40건은 SSH 도 정상 → 한 번도 안 죽었다
  · 같은 시각 CPU 사용률 08시 21% → 10시 97% (온도 47→54°C, SSH 응답 0.2→1.3초)

즉 알람은 진짜 변화를 잡았지만 이름이 틀렸다. 장비는 살아 있고 CPU 가 포화됐다.

이미 호스트에 SSH·DSM 을 AND 로 묶은 트리거가 있었는데 이름에 '시스템 다운' 이
없어 알림 액션 필터(트리거이름 like '시스템 다운')에 안 걸렸다. 그것을 살린다.

  삭제: 시스템 다운 (SNMP 5분 불통)
  개명: NAS02 메인NIC: 서비스 응답 없음 (SSH·DSM 모두)
        → 시스템 다운 (SSH·DSM 5분 동시 불통), p5
        식도 last() 에서 min(...,5m) 로 바꿔 한 번 튀는 것에 반응하지 않게 한다

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/watch -- python3 alerts/nas02_down_signal_fix.py
미리 보기:  DRY_RUN=1 ...
"""
import json
import os
import urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DRY = os.environ.get('DRY_RUN') == '1'

HOST = 'NAS02-main-36'
OLD = '시스템 다운 (SNMP 5분 불통)'
KEEP = 'NAS02 메인NIC: 서비스 응답 없음 (SSH·DSM 모두)'
NEW = '시스템 다운 (SSH·DSM 5분 동시 불통)'
EXPR = (f'min(/{HOST}/net.tcp.service[ssh],5m)=0 and '
        f'min(/{HOST}/net.tcp.service[tcp,,5001],5m)=0')

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
    print('NAS02 다운 판정 교체' + (' (DRY_RUN)' if DRY else ''))
    print(f'{API}\n')

    h = call('host.get', {'filter': {'host': [HOST]}, 'output': ['hostid', 'name']})[0]
    trs = call('trigger.get', {'hostids': h['hostid'], 'output': ['triggerid', 'description',
                                                                 'priority', 'status']})
    by = {t['description']: t for t in trs}

    if NEW in by:
        print(f'  이미 교체됨: {NEW}')
    elif KEEP in by:
        t = by[KEEP]
        print(f'  개명: {KEEP}\n      → {NEW}  (p{t["priority"]} → p5)')
        print(f'      식: {EXPR}')
        if not DRY:
            call('trigger.update', {
                'triggerid': t['triggerid'], 'description': NEW, 'priority': 5,
                'expression': EXPR, 'manual_close': 1,
                'comments': 'SSH(22)와 DSM(5001)이 5분간 동시에 응답하지 않아야 다운으로 본다. '
                            'SNMP 응답 여부로는 판정하지 않는다 — CPU 가 포화되면 snmpd 가 '
                            '3초 안에 답하지 못해 살아 있는 장비가 다운으로 뜬다 '
                            '(2026-09-18 실측: SNMP 실패 70건 전부 DSM 은 정상 응답).',
            })
    else:
        print(f'  ⚠ 기준 트리거 없음: {KEEP} — 수동 확인 필요')

    if OLD in by:
        print(f'  삭제: {OLD}')
        if not DRY:
            call('trigger.delete', [by[OLD]['triggerid']])
    else:
        print(f'  {OLD} 이미 없음')

    print('\n완료' + (' (DRY_RUN — 아무것도 바꾸지 않았다)' if DRY else ''))


if __name__ == '__main__':
    main()
