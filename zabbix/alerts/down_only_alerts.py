#!/usr/bin/env python3
"""알림을 '장비가 실제로 죽었을 때'로 좁힌다.

리소스 사용률 알람이 의미가 없다는 판단이다. 사용자가 GPU·CPU를 다 쓰고 있어서
높은 것이지 장애가 아니다. 30일간 발송 204건 중 GPU 온도 67건, Load average 31건,
NAS 온도 8건, 디스크 사용률 7건이 그런 것들이었다.

트리거를 끄지 않고 **알림 액션의 조건만 좁힌다.** 수집과 화면 표시는 그대로 두고
메신저로 나가는 것만 막는다. BMC 를 액션에서 뺐을 때와 같은 방식이다.

  액션 9 (서버·워크스테이션, 그룹 25)
      심각도>=3 and 그룹=25 and (이름 like '시스템 다운' or 이름 like 'Unavailable by ICMP ping')
  액션 8 (인프라 장애, 그룹 23)
      심각도>=2 and 그룹=23 and 이름 like 'Unavailable by ICMP ping'

같은 종류의 조건은 and/or 평가에서 OR 로 묶이므로 이름 조건 두 개는 자동으로 OR 다.

에이전트가 있는 20대는 '시스템 다운'(ICMP·에이전트 5분 동시 불통)이 신호이고,
에이전트가 없는 nas01·nas03·임대 서버는 'Unavailable by ICMP ping' 이 신호다.
그 20대는 ICMP 트리거를 이미 꺼 뒀으므로 중복 발송은 없다.

**NAS02 는 둘 다 없어서 지금 상태로는 죽어도 알림이 안 간다** — ICMP Ping 템플릿이
안 붙어 있다. 같이 붙인다.

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/watch -- python3 alerts/down_only_alerts.py

미리 보기:  DRY_RUN=1 infisical run ... -- python3 alerts/down_only_alerts.py
되돌리기:   REVERT=1  infisical run ... -- python3 alerts/down_only_alerts.py
"""
import json
import os
import urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DRY = os.environ.get('DRY_RUN') == '1'
REVERT = os.environ.get('REVERT') == '1'

CT_SEVERITY, CT_GROUP, CT_TRIGGER_NAME = 4, 0, 3
OP_GE, OP_EQ, OP_LIKE = 5, 0, 2

DOWN_SERVER = '시스템 다운'
DOWN_ICMP = 'Unavailable by ICMP ping'

# 액션별로 남길 이름 조건. 이 목록에 없는 트리거는 알림이 나가지 않는다.
PLAN = {
    '9': [DOWN_SERVER, DOWN_ICMP],   # 서버·워크스테이션 (그룹 25)
    '8': [DOWN_ICMP],                # 인프라 장애 (그룹 23)
}

NAS02 = 'NAS02 (192TB) 메인NIC'
ICMP_TEMPLATE = 'ICMP Ping'

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
        raise SystemExit('ZABBIX_TOKEN 이나 ZBX_PASS 가 필요하다. infisical run 으로 실행해라.')
    _token = call('user.login', {'username': os.environ.get('ZBX_USER', 'Admin'), 'password': pw})


def name_conditions(filt):
    return [c for c in filt['conditions'] if int(c['conditiontype']) == CT_TRIGGER_NAME]


def fix_action(actionid, names):
    a = call('action.get', {'actionids': actionid, 'output': 'extend', 'selectFilter': 'extend'})[0]
    filt = a['filter']
    # 읽어온 조건에는 formulaid 가 붙어 있는데 evaltype 0 에서는 update 가 거부한다.
    # 필요한 키만 남긴다.
    # 읽어온 조건에는 formulaid 가 붙어 있고 value2 는 빈 문자열로 온다. evaltype 0 의
    # update 는 둘 다 거부하므로(value2 는 태그값 조건에서만 쓴다) 필요한 키만 남긴다.
    keep = []
    for c in filt['conditions']:
        if int(c['conditiontype']) == CT_TRIGGER_NAME:
            continue
        k = {'conditiontype': c['conditiontype'], 'operator': c['operator'], 'value': c['value']}
        if c.get('value2'):
            k['value2'] = c['value2']
        keep.append(k)
    want = [] if REVERT else [
        {'conditiontype': CT_TRIGGER_NAME, 'operator': OP_LIKE, 'value': n} for n in names
    ]

    have = sorted(c['value'] for c in name_conditions(filt))
    if have == sorted(c['value'] for c in want):
        print(f"  [{actionid}] {a['name']} — 이미 맞음")
        return

    print(f"  [{actionid}] {a['name']}")
    print(f"       지금: {have or '(이름 조건 없음 — 전부 발송)'}")
    print(f"       바꿈: {[c['value'] for c in want] or '(이름 조건 없음 — 전부 발송)'}")
    if DRY:
        return
    # evaltype 0(and/or)에서 같은 종류 조건은 OR, 다른 종류는 AND 로 묶인다.
    # 커스텀 수식을 쓰지 않으므로 formula 는 보내지 않는다.
    call('action.update', {
        'actionid': actionid,
        'filter': {'evaltype': 0, 'conditions': keep + want},
    })


def fix_nas02():
    hs = call('host.get', {'output': ['hostid', 'name'], 'filter': {'name': [NAS02]},
                           'selectParentTemplates': ['templateid', 'host']})
    if not hs:
        print(f"  {NAS02} 없음 — 건너뜀")
        return
    h = hs[0]
    if any(t['host'] == ICMP_TEMPLATE for t in h['parentTemplates']):
        print(f"  {NAS02} — 이미 {ICMP_TEMPLATE} 연결됨")
        return
    if REVERT:
        print(f"  {NAS02} — 템플릿 연결은 되돌리지 않는다 (없으면 다운 감지가 아예 없다)")
        return
    print(f"  {NAS02} — {ICMP_TEMPLATE} 연결 (지금은 다운 감지 수단이 하나도 없다)")
    if DRY:
        return
    tid = call('template.get', {'output': ['templateid'], 'filter': {'host': [ICMP_TEMPLATE]}})[0]['templateid']
    call('host.update', {
        'hostid': h['hostid'],
        'templates': [{'templateid': t['templateid']} for t in h['parentTemplates']]
                     + [{'templateid': tid}],
    })


def report():
    """조건을 걸었을 때 실제로 알림이 나갈 수 있는 호스트를 센다."""
    for gid, gname, pats in (('25', '서버·워크스테이션', PLAN['9']),
                             ('23', '네트워크 장비', PLAN['8'])):
        hosts = call('host.get', {'groupids': gid, 'output': ['hostid', 'name'],
                                  'monitored_hosts': True})
        covered = set()
        for p in pats:
            for t in call('trigger.get', {'groupids': gid, 'search': {'description': p},
                                          'output': ['status'], 'selectHosts': ['hostid'],
                                          'filter': {'status': 0}, 'monitored': True}):
                covered.update(h['hostid'] for h in t['hosts'])
        miss = [h['name'] for h in hosts if h['hostid'] not in covered]
        print(f"  그룹 {gid} {gname}: {len(hosts)}대 중 {len(hosts) - len(miss)}대 다운 감지 가능")
        if miss:
            print(f"     ⚠ 감지 수단 없음: {', '.join(miss)}")


def main():
    login()
    mode = ' (DRY_RUN)' if DRY else ''
    print(('되돌리기' if REVERT else '알림을 다운 상황으로 좁힌다') + mode)
    print(f'{API}\n')

    print('알림 액션')
    for actionid, names in PLAN.items():
        fix_action(actionid, names)

    print('\n다운 감지 수단')
    fix_nas02()

    print('\n적용 후 커버리지')
    report()

    if DRY:
        print('\nDRY_RUN — 아무것도 바꾸지 않았다')
    elif not REVERT:
        print('\n완료. 리소스 사용률·온도·디스크 알람은 화면에는 그대로 뜨고 메신저로만 안 나간다.')
        print('되돌리려면 REVERT=1 로 다시 실행하면 된다.')


if __name__ == '__main__':
    main()
