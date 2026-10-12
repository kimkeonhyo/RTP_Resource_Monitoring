#!/usr/bin/env python3
"""주말에 쏟아진 헛알람의 원인을 걷어내고, 진짜 다운만 알리도록 바꾼다.

주말 발송 98건 중 52건이 BMC 2대(ai-gpu04-bmc, inf-gpu01-bmc)였고 전부 거짓이었다.
ASUS BMC 는 그 순간 못 읽은 센서와 미장착 부품을 0 으로 돌려주는데, IPMI 템플릿의
임계 트리거가 그 0 을 '치명적 저하'로 읽어 팬·전압 26개가 한꺼번에 터진다.

  1) BMC 를 알림 대상에서 뺀다 (수집·대시보드는 그대로 둔다)
  2) BMC 의 '... value has changed' 트리거를 끈다 (5일간 480여 건, 로그를 덮는다)
  3) 공유기 2대의 ICMP 응답시간 트리거를 끈다 (다른 장비엔 이미 꺼 둔 것)
  4) '시스템 다운' 트리거를 만든다 — ICMP 와 에이전트가 5분간 동시에 불통일 때만.
     한쪽만 끊긴 건 네트워크 순단이나 에이전트 재시작이지 다운이 아니다.
     동시에, 이제 중복이 되는 단일 증상 트리거를 정리한다.
       - ICMP Unavailable  : 끈다 (에이전트가 응답하면 장비는 살아 있다)
       - 에이전트 불가        : 남기되 '시스템 다운'에 의존시켜, 진짜 다운일 땐
                             한 건만 가도록 한다

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/zabbix -- python3 alert_noise_fix.py

무엇이 바뀌는지만 보려면 (아무것도 안 바꾼다):
    ... -- DRY_RUN=1 python3 alert_noise_fix.py
"""
import json
import os
import urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DRY = os.environ.get('DRY_RUN') == '1'

ACTION      = '인프라 장애 알림'
BMC_GROUP   = 'IMS BMC (IPMI)'
SRV_GROUP   = 'IMS 서버·워크스테이션'
WIFI_HOSTS  = ['office_wifi', 'kt_wifi']

DOWN_NAME   = '시스템 다운 (ICMP·에이전트 5분 동시 불통)'
K_PING      = 'icmpping'
K_AGENT     = 'zabbix[host,agent,available]'
T_ICMP_DOWN = 'Unavailable by ICMP ping'
T_AGENT_OFF = 'Zabbix agent is not available'


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


def act(what, fn):
    """DRY_RUN 이면 설명만 찍고 넘어간다."""
    print(f'   {what}' + (' (DRY_RUN)' if DRY else ''))
    if not DRY:
        fn()


def disable_triggers(tok, hostids, pattern, label):
    trs = call('trigger.get', {
        'hostids': hostids,
        'output': ['triggerid', 'description'],
        'search': {'description': pattern},
        'filter': {'status': 0},
    }, tok)
    if not trs:
        print(f'   {label}: 끌 것 없음')
        return
    act(f'{label}: {len(trs)}개 비활성화',
        lambda: call('trigger.update',
                     [{'triggerid': t['triggerid'], 'status': 1} for t in trs], tok))


def main():
    pw = os.environ.get('ZBX_PASS')
    if not pw:
        raise SystemExit('ZBX_PASS 가 없다. infisical run 으로 주입해서 실행해라.')
    tok = call('user.login',
               {'username': os.environ.get('ZBX_USER', 'Admin'), 'password': pw})

    gid_bmc = call('hostgroup.get',
                   {'output': ['groupid'], 'filter': {'name': [BMC_GROUP]}}, tok)[0]['groupid']
    gid_srv = call('hostgroup.get',
                   {'output': ['groupid'], 'filter': {'name': [SRV_GROUP]}}, tok)[0]['groupid']

    # ── 1) 알림 액션에서 BMC 그룹 조건 제거 ──────────────────────────────
    print('1) 알림 액션에서 BMC 제외')
    acts = call('action.get', {'output': ['actionid', 'name'],
                               'filter': {'name': [ACTION]},
                               'selectFilter': 'extend'}, tok)
    if not acts:
        raise SystemExit(f'   액션 {ACTION!r} 를 찾지 못했다')
    a = acts[0]
    conds = a['filter']['conditions']
    keep = [c for c in conds
            if not (c['conditiontype'] == '0' and c['value'] == gid_bmc)]
    if len(keep) == len(conds):
        print('   이미 빠져 있음 — 건너뜀')
    elif not any(c['conditiontype'] == '0' for c in keep):
        raise SystemExit('   BMC 를 빼면 호스트 그룹 조건이 하나도 안 남는다 — 중단')
    else:
        act(f'조건 {len(conds)} → {len(keep)}개',
            lambda: call('action.update', {
                'actionid': a['actionid'],
                'filter': {'evaltype': a['filter']['evaltype'],
                           'conditions': [{'conditiontype': c['conditiontype'],
                                           'operator': c['operator'],
                                           'value': c['value']} for c in keep]},
            }, tok))

    # ── 2) BMC 의 상태 변화 트리거 ──────────────────────────────────────
    print("2) BMC 의 'value has changed' 트리거")
    bmc_ids = [h['hostid'] for h in
               call('host.get', {'groupids': gid_bmc, 'output': ['hostid']}, tok)]
    disable_triggers(tok, bmc_ids, 'value has changed', '상태 변화 트리거')

    # ── 3) 공유기 ICMP 응답시간 트리거 ──────────────────────────────────
    print('3) 공유기 ICMP 응답시간 트리거')
    wifi_ids = [h['hostid'] for h in
                call('host.get', {'filter': {'host': WIFI_HOSTS}, 'output': ['hostid']}, tok)]
    if wifi_ids:
        disable_triggers(tok, wifi_ids, 'High ICMP ping response time', '응답시간 트리거')
    else:
        print('   공유기 호스트 없음 — 건너뜀')

    # ── 4) 시스템 다운 트리거 (AND 조건) ────────────────────────────────
    print('4) 시스템 다운 트리거 (ICMP AND 에이전트)')
    hosts = call('host.get', {'groupids': gid_srv,
                              'output': ['hostid', 'host', 'name']}, tok)
    made = skipped = 0
    for h in hosts:
        keys = {i['key_'] for i in call('item.get', {
            'hostids': h['hostid'], 'output': ['key_'],
            'filter': {'key_': [K_PING, K_AGENT]}}, tok)}
        if not {K_PING, K_AGENT} <= keys:
            skipped += 1
            continue                      # NAS·SNMP 전용 호스트는 AND 를 만들 수 없다

        exists = call('trigger.get', {'hostids': h['hostid'], 'output': ['triggerid'],
                                      'filter': {'description': DOWN_NAME}}, tok)
        if exists:
            down_id = exists[0]['triggerid']
        elif DRY:
            print(f'   {h["host"]}: 생성 예정 (DRY_RUN)')
            made += 1
            continue
        else:
            # 5분 내내 ping 이 모두 실패(min=0)하고, 그동안 에이전트도 계속 불가(max=0).
            expr = (f'min(/{h["host"]}/{K_PING},5m)=0'
                    f' and max(/{h["host"]}/{K_AGENT},5m)=0')
            down_id = call('trigger.create', {
                'description': DOWN_NAME,
                'expression': expr,
                'priority': 5,            # 심각
                'manual_close': 1,
            }, tok)['triggerids'][0]
            print(f'   {h["host"]}: 생성')
            made += 1

        if DRY:
            continue

        # ICMP 단독 트리거는 중복이라 끈다 (에이전트가 답하면 장비는 살아 있다)
        for t in call('trigger.get', {'hostids': h['hostid'], 'output': ['triggerid'],
                                      'search': {'description': T_ICMP_DOWN},
                                      'filter': {'status': 0}}, tok):
            call('trigger.update', {'triggerid': t['triggerid'], 'status': 1}, tok)

        # 에이전트 트리거는 남기되, 진짜 다운일 땐 '시스템 다운' 하나만 가도록 의존시킨다
        for t in call('trigger.get', {'hostids': h['hostid'],
                                      'output': ['triggerid'], 'selectDependencies': ['triggerid'],
                                      'search': {'description': T_AGENT_OFF}}, tok):
            if down_id not in [d['triggerid'] for d in t['dependencies']]:
                call('trigger.update', {'triggerid': t['triggerid'],
                                        'dependencies': [{'triggerid': down_id}]}, tok)

    print(f'   생성/확인 {made}대, 아이템이 없어 건너뜀 {skipped}대')
    print('\n완료' + (' (DRY_RUN — 아무것도 바꾸지 않았다)' if DRY else ''))


if __name__ == '__main__':
    main()
