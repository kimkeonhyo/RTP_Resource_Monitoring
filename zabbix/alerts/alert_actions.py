#!/usr/bin/env python3
"""장애 알림 액션을 만든다 (Teams 전송).

PoC 에서는 파일 로그 미디어를 함께 썼지만 그건 디버깅용이었다. 운영에서는
Teams 하나로 보낸다. 액션은 configuration.export 대상이 아니라 이전 시 다시 만든다.

  python3 alert_actions.py [--dry-run]
"""
import json, os, sys, urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DRY = '--dry-run' in sys.argv
MT = 'MS Teams Workflow'

# (액션 이름, 호스트그룹들, 최소 심각도)
#   2=경고 3=보통
ACTIONS = [
    ('인프라 장애 알림',      ['IMS 네트워크 장비', 'IMS BMC (IPMI)'], 2),
    ('서버·워크스테이션 알림', ['IMS 서버·워크스테이션'],        3),
]

def call(m, p, a=None):
    b = {'jsonrpc': '2.0', 'method': m, 'params': p, 'id': 1}
    if a: b['auth'] = a
    r = json.load(urllib.request.urlopen(urllib.request.Request(
        API, method='POST', headers={'Content-Type': 'application/json-rpc'},
        data=json.dumps(b).encode()), timeout=60))
    if 'error' in r: raise SystemExit(f"{m}: {json.dumps(r['error'], ensure_ascii=False)}")
    return r['result']

def main():
    tok = call('user.login', {'username': os.environ.get('ZBX_USER', 'Admin'),
                              'password': os.environ['ZBX_PASS']})
    mt = call('mediatype.get', {'output': ['mediatypeid'], 'filter': {'name': [MT]}}, tok)
    if not mt: raise SystemExit(f'미디어 타입 없음: {MT}')
    mtid = mt[0]['mediatypeid']
    grp = {g['name']: g['groupid'] for g in call('hostgroup.get', {'output': ['groupid', 'name']}, tok)}
    ug = call('usergroup.get', {'output': ['usrgrpid'], 'filter': {'name': ['Zabbix administrators']}}, tok)
    if not ug: raise SystemExit('사용자 그룹 없음: Zabbix administrators')

    ops = [{'operationtype': '0', 'esc_period': '0', 'esc_step_from': '1', 'esc_step_to': '1',
            'evaltype': '0', 'opmessage': {'default_msg': '1', 'mediatypeid': mtid},
            'opmessage_grp': [{'usrgrpid': ug[0]['usrgrpid']}], 'opmessage_usr': []}]

    for name, groups, sev in ACTIONS:
        missing = [g for g in groups if g not in grp]
        if missing:
            print(f"  {name}: 그룹 없음 {missing} — 건너뜀"); continue
        cond = [{'conditiontype': 0, 'operator': 0, 'value': grp[g]} for g in groups]
        cond.append({'conditiontype': 4, 'operator': 5, 'value': str(sev)})
        params = {'name': name, 'eventsource': 0, 'status': 0,
                  'filter': {'evaltype': 0, 'conditions': cond}, 'operations': ops}
        exist = call('action.get', {'output': ['actionid'], 'filter': {'name': [name]}}, tok)
        print(f"  {name}: {', '.join(groups)} / 심각도 >= {sev}")
        if DRY: continue
        if exist:
            params['actionid'] = exist[0]['actionid']; call('action.update', params, tok); print('    갱신')
        else:
            call('action.create', params, tok); print('    생성')

if __name__ == '__main__':
    main()
