#!/usr/bin/env python3
"""BMC 이산 센서의 'value has changed' 노이즈를 걷어낸다.

Chassis by IPMI 템플릿의 'Discrete sensors discovery' 는 센서마다
`Chassis: {#SENSOR_ID} value has changed` 트리거를 만든다. 이산 센서는
상태 비트를 돌려주는데, IPMI 조회가 간헐적으로 **빈 값**을 반환했다가
다시 정상값으로 돌아온다. 트리거는 그 왕복을 '값이 바뀌었다'로 보고 발화한다.

  최근 24시간 이력:  ['', 'transition to ok']   ← 27개 중 23개가 이 모양

이름만 보면 경보처럼 보이지만(PSU1 Over Curr, CPU1_ECC1) 그건 **센서 이름**이고,
그 센서가 보고하는 **값**은 transition to ok / presence detected — 모두 정상이다.
2026-09-30 확인 시점에 실제 이상 상태인 센서는 하나도 없었다.

문제는 두 가지다.

  1) 이미 열린 장애 27건이 남아 있다. 누군가 트리거 146개를 비활성으로
     돌렸지만, **트리거를 꺼도 이미 열린 장애는 닫히지 않는다.**
     그래서 09-06~09-07 것이 3주 넘게 화면을 덮고, 그 아래 ws-05 의
     '시스템 다운(sev5)' 같은 진짜 장애가 묻혔다.

  2) 트리거 프로토타입이 아직 켜져 있다. 디스커버리가 새 센서를 찾을 때마다
     **활성 상태로** 노이즈 트리거가 다시 생긴다. 꺼 두지 않으면 재발한다.

이 스크립트는 (1) 열린 장애를 닫고 (2) 프로토타입을 끈다.
임계값 센서(Threshold sensors discovery) 쪽 트리거는 건드리지 않는다 —
그쪽은 실제 온도·전압 이상을 잡는 정상 경보다.

주의: Chassis by IPMI 는 Zabbix 기본 템플릿이라 업그레이드 때 템플릿을 다시
      가져오면 프로토타입 status 가 되돌아올 수 있다. 그때는 다시 돌리면 된다.

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/zabbix -- python3 alerts/bmc_noise_fix.py

미리 보기:  DRY_RUN=1 ...
"""
import json
import os
import urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DRY = os.environ.get('DRY_RUN') == '1'

GROUP = 'IMS BMC (IPMI)'
TEMPLATE = 'Chassis by IPMI'
PROTO = 'value has changed'          # 이 문구를 가진 프로토타입만 끈다
LLD = 'Discrete sensors discovery'   # 임계값 쪽은 제외
CLOSE_MSG = ('이산 센서 조회가 간헐적으로 빈 값을 반환해 생긴 오탐. '
             '센서 실제 값은 transition to ok / presence detected 로 정상. '
             'bmc_noise_fix.py 로 일괄 종료.')

_tok = None


def call(method, params):
    body = {'jsonrpc': '2.0', 'method': method, 'params': params, 'id': 1}
    head = {'Content-Type': 'application/json-rpc'}
    if _tok:
        head['Authorization'] = 'Bearer ' + _tok
    req = urllib.request.Request(API, json.dumps(body).encode(), head)
    out = json.load(urllib.request.urlopen(req, timeout=60))
    if 'error' in out:
        raise SystemExit(f"{method} → {out['error']}")
    return out['result']


def main():
    global _tok
    pw = os.environ.get('ZBX_PASS')
    if not pw:
        raise SystemExit('ZBX_PASS 가 필요합니다. infisical run -- python3 alerts/bmc_noise_fix.py')
    _tok = call('user.login', {'username': os.environ.get('ZBX_USER', 'Admin'), 'password': pw})
    print('BMC 이산 센서 노이즈 정리' + (' (DRY_RUN)' if DRY else ''))

    grp = call('hostgroup.get', {'filter': {'name': [GROUP]}, 'output': ['groupid']})
    if not grp:
        raise SystemExit(f'그룹 없음: {GROUP}')
    gid = grp[0]['groupid']

    # ── 1) 열린 오탐 종료 ────────────────────────────────────────────────
    probs = call('problem.get', {'groupids': gid, 'output': ['eventid', 'objectid', 'name', 'clock']})
    trs = {t['triggerid']: t for t in call('trigger.get', {
        'triggerids': [p['objectid'] for p in probs],
        'output': ['triggerid', 'description', 'manual_close'],
        'selectHosts': ['host']})} if probs else {}

    targets, skipped = [], []
    for p in probs:
        t = trs.get(p['objectid'])
        if not t or PROTO not in t['description']:
            skipped.append((p['name'], '대상 아님'))
        elif t['manual_close'] != '1':
            skipped.append((p['name'], '수동 종료 불가'))
        else:
            targets.append((p['eventid'], ','.join(h['host'] for h in t['hosts']), t['description']))

    print(f"\n[1] 열린 오탐 {len(targets)}건 종료")
    for _, host, desc in targets:
        print(f"    {host:<18} {desc[:52]}")
    for name, why in skipped:
        print(f"    건너뜀({why}): {name[:52]}")
    if targets and not DRY:
        # action 비트: 1=종료, 2=확인, 4=메시지
        call('event.acknowledge', {'eventids': [e for e, _, _ in targets],
                                   'action': 1 | 2 | 4, 'message': CLOSE_MSG})

    # ── 2) 트리거 프로토타입 비활성 ───────────────────────────────────────
    tpl = call('template.get', {'filter': {'host': [TEMPLATE]}, 'output': ['templateid']})
    if not tpl:
        raise SystemExit(f'템플릿 없음: {TEMPLATE}')
    protos = [tp for tp in call('triggerprototype.get', {
        'templateids': [tpl[0]['templateid']],
        'output': ['triggerid', 'description', 'status'],
        'selectDiscoveryRule': ['name']})
        if PROTO in tp['description'] and (tp['discoveryRule'] or {}).get('name') == LLD]

    print(f"\n[2] 트리거 프로토타입 {len(protos)}개")
    for tp in protos:
        if tp['status'] == '1':
            print(f"    이미 비활성: {tp['description'][:52]}")
            continue
        print(f"    비활성으로 전환: {tp['description'][:52]}")
        if not DRY:
            call('triggerprototype.update', {'triggerid': tp['triggerid'], 'status': 1})

    print('\n' + ('미리 보기였다 — DRY_RUN 없이 다시 실행하면 적용된다' if DRY else '완료'))


if __name__ == '__main__':
    main()
