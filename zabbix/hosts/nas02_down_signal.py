#!/usr/bin/env python3
"""NAS02 의 다운 감지를 ICMP 에서 SNMP 로 바꾼다.

NAS02(<NAS02_IP>)는 **ICMP 에 답하지 않는다.** SNMP 는 정상 응답하고 수집도
잘 되는데 ping 만 100% 손실이다. 시놀로지 방화벽이 SNMP 포트만 열어 둔 것으로
보인다. 그래서 ICMP Ping 템플릿을 붙이자 살아 있는 장비가 곧바로
'Unavailable by ICMP ping' 으로 떴다 (2026-09-09 08:37 에 붙이고 08:38 에 발생).

nas01·nas03 은 ICMP 에 답하므로 그대로 둔다. NAS02 만 다르다.

대신 SNMP 응답 여부를 다운 신호로 쓴다. Zabbix 내부 아이템
`zabbix[host,snmp,available]` 은 SNMP 인터페이스가 살아 있으면 1, 죽으면 0 이다.
nas01·nas03 은 `Linux by SNMP` 를 통해 이미 같은 아이템을 갖고 있다.

트리거 이름을 '시스템 다운' 으로 맞추는 이유: 알림 액션 9 가 트리거 이름
like '시스템 다운' 으로 거르기 때문이다 (alerts/down_only_alerts.py).

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/watch -- python3 hosts/nas02_down_signal.py

미리 보기:  DRY_RUN=1 ...
되돌리기:   REVERT=1 ...   (트리거·아이템 제거, ICMP Ping 재연결)
"""
import json
import os
import time
import urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DRY = os.environ.get('DRY_RUN') == '1'
REVERT = os.environ.get('REVERT') == '1'

HOST_NAME = 'NAS02 (192TB) 메인NIC'
ICMP_TEMPLATE = 'ICMP Ping'
KEY = 'zabbix[host,snmp,available]'
TRIGGER = '시스템 다운 (SNMP 5분 불통)'

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


def icmp_evidence(hostid):
    """정말 ping 에 안 답하는지 확인하고 근거를 찍는다. 틀렸으면 여기서 멈춘다."""
    it = call('item.get', {'hostids': hostid, 'output': ['itemid'],
                           'filter': {'key_': 'icmppingloss'}})
    if not it:
        print('   icmppingloss 아이템 없음 — 손실 확인 불가')
        return None
    now = int(time.time())
    hist = call('history.get', {'itemids': it[0]['itemid'], 'history': 0,
                                'time_from': now - 6 * 3600, 'limit': 10000})
    vals = [float(h['value']) for h in hist]
    if not vals:
        print('   icmppingloss 이력 없음 — 손실 확인 불가')
        return None
    avg = sum(vals) / len(vals)
    print(f'   ICMP 손실 {len(vals)}점 평균 {avg:.0f}% (최소 {min(vals):.0f}, 최대 {max(vals):.0f})')
    return avg


def main():
    login()
    print(('되돌리기' if REVERT else 'NAS02 다운 감지를 SNMP 로 전환')
          + (' (DRY_RUN)' if DRY else ''))
    print(f'{API}\n')

    h = call('host.get', {'filter': {'name': [HOST_NAME]},
                          'output': ['hostid', 'host', 'name'],
                          'selectParentTemplates': ['templateid', 'host'],
                          'selectInterfaces': ['type', 'ip', 'available']})
    if not h:
        raise SystemExit(f"'{HOST_NAME}' 호스트가 없다")
    h = h[0]
    snmp_if = [i for i in h['interfaces'] if i['type'] == '2']
    print(f"{h['name']} (기술명 {h['host']})")
    print('   템플릿:', [t['host'] for t in h['parentTemplates']])
    print('   SNMP 인터페이스:', [(i['ip'], {'0': 'unknown', '1': 'available',
                                        '2': 'unavailable'}[i['available']]) for i in snmp_if]
          or '없음 ← SNMP 다운 감지를 쓸 수 없다')
    if not snmp_if and not REVERT:
        raise SystemExit('SNMP 인터페이스가 없어 이 방식을 쓸 수 없다')
    avg = icmp_evidence(h['hostid'])
    if avg is not None and avg < 50 and not REVERT:
        raise SystemExit(f'ICMP 손실이 {avg:.0f}% 뿐이다 — ping 이 되는 것으로 보이니 확인부터 해라')
    print()

    tid = call('template.get', {'output': ['templateid'],
                                'filter': {'host': [ICMP_TEMPLATE]}})[0]['templateid']
    linked = any(t['host'] == ICMP_TEMPLATE for t in h['parentTemplates'])

    if REVERT:
        for t in call('trigger.get', {'hostids': h['hostid'], 'output': ['triggerid'],
                                      'filter': {'description': TRIGGER}}):
            print(f'   트리거 삭제: {TRIGGER}')
            if not DRY:
                call('trigger.delete', [t['triggerid']])
        for i in call('item.get', {'hostids': h['hostid'], 'output': ['itemid'],
                                   'filter': {'key_': KEY}}):
            print(f'   아이템 삭제: {KEY}')
            if not DRY:
                call('item.delete', [i['itemid']])
        if not linked:
            print(f'   {ICMP_TEMPLATE} 재연결')
            if not DRY:
                call('host.update', {'hostid': h['hostid'],
                                     'templates': [{'templateid': t['templateid']}
                                                   for t in h['parentTemplates']]
                                                  + [{'templateid': tid}]})
        print('\n되돌렸다' + (' (DRY_RUN)' if DRY else ''))
        return

    # 1) 살아 있는데 죽었다고 뜨는 원인을 제거한다. templates_clear 로 아이템·트리거·
    #    열린 문제까지 같이 없앤다. 그냥 unlink 하면 껍데기가 호스트에 남는다.
    if linked:
        print(f'   {ICMP_TEMPLATE} 연결 해제 + 아이템·트리거 제거 (ping 에 답하지 않는다)')
        if not DRY:
            call('host.update', {'hostid': h['hostid'],
                                 'templates_clear': [{'templateid': tid}]})
    else:
        print(f'   {ICMP_TEMPLATE} — 이미 연결 없음')

    # 2) SNMP 응답 여부 아이템. Zabbix 내부 아이템(type 5)이라 대상에 질의하지 않는다.
    it = call('item.get', {'hostids': h['hostid'], 'output': ['itemid'], 'filter': {'key_': KEY}})
    if it:
        print(f'   {KEY} — 이미 있음')
        itemid = it[0]['itemid']
    else:
        print(f'   아이템 생성: {KEY}')
        itemid = None
        if not DRY:
            itemid = call('item.create', {
                'hostid': h['hostid'], 'name': 'SNMP 응답 여부', 'key_': KEY,
                'type': 5, 'value_type': 3, 'delay': '1m', 'history': '7d', 'trends': '0',
                'description': 'SNMP 인터페이스가 살아 있으면 1. NAS02 는 ICMP 에 답하지 '
                               '않으므로 이것이 유일한 다운 신호다.',
            })['itemids'][0]

    # 3) 다운 트리거. 이름을 '시스템 다운' 으로 맞춰야 알림 액션 9 의 필터에 걸린다.
    tr = call('trigger.get', {'hostids': h['hostid'], 'output': ['triggerid'],
                              'filter': {'description': TRIGGER}})
    if tr:
        print(f'   트리거 — 이미 있음: {TRIGGER}')
    else:
        expr = f'max(/{h["host"]}/{KEY},5m)=0'
        print(f'   트리거 생성: {TRIGGER}')
        print(f'      {expr}')
        if not DRY:
            call('trigger.create', {
                'description': TRIGGER, 'expression': expr, 'priority': 5,
                'manual_close': 1,
                'comments': 'SNMP 가 5분 동안 응답하지 않으면 장비가 내려간 것으로 본다. '
                            'NAS02 는 ICMP 에 답하지 않아 ping 으로는 판별할 수 없다.',
            })

    print('\n완료' + (' (DRY_RUN — 아무것도 바꾸지 않았다)' if DRY else ''))
    if not DRY:
        print('ICMP 로 인한 오탐은 사라지고, SNMP 가 끊기면 알림이 간다.')


if __name__ == '__main__':
    main()
