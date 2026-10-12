#!/usr/bin/env python3
"""사내 서버·워크스테이션 알림 액션 생성.

스위치·BMC 액션(경고 이상)과 분리한다. 워크스테이션은 디스크 80%·스왑 경고가 상시
발생하는데 즉시 대응할 성격이 아니라, 이 그룹만 보통 이상으로 올린다.
  python3 server_alert_action.py [--dry-run]
"""
import json, os, sys, urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
NAME = '서버·워크스테이션 알림'
GROUP = 'IMS 서버·워크스테이션'
MIN_SEVERITY = int(os.environ.get('MIN_SEVERITY', '3'))   # 3 = 보통
SRC = 'PoC 장애 알림'                                      # 오퍼레이션을 복사해 올 기존 액션
DRY = '--dry-run' in sys.argv

def call(m, p, a=None):
    b = {'jsonrpc': '2.0', 'method': m, 'params': p, 'id': 1}
    if a: b['auth'] = a
    r = json.load(urllib.request.urlopen(urllib.request.Request(
        API, method='POST', headers={'Content-Type': 'application/json-rpc'},
        data=json.dumps(b).encode())))
    if 'error' in r: raise SystemExit(f"{m}: {json.dumps(r['error'], ensure_ascii=False)}")
    return r['result']

def main():
    tok = call('user.login', {'username': os.environ.get('ZBX_USER', 'Admin'),
                              'password': os.environ.get('ZBX_PASS', 'zabbix')})
    g = call('hostgroup.get', {'output': ['groupid'], 'filter': {'name': [GROUP]}}, tok)
    if not g: raise SystemExit(f'그룹 없음: {GROUP}')
    gid = g[0]['groupid']

    src = call('action.get', {'output': ['actionid'], 'selectOperations': 'extend',
                              'filter': {'name': [SRC]}}, tok)
    if not src: raise SystemExit(f'기준 액션 없음: {SRC}')
    def clean(o):
        d = {k: v for k, v in o.items() if k in
             ('operationtype', 'esc_period', 'esc_step_from', 'esc_step_to',
              'evaltype', 'opmessage', 'opmessage_grp', 'opmessage_usr')}
        if 'opmessage' in d:
            m = dict(d['opmessage'])
            if m.get('default_msg') == '1':      # 기본 메시지일 때 subject/message 를 넘기면 거부된다
                m.pop('subject', None); m.pop('message', None)
            d['opmessage'] = m
        return d
    ops = [clean(o) for o in src[0]['operations']]

    exist = call('action.get', {'output': ['actionid'], 'filter': {'name': [NAME]}}, tok)
    params = {
        'name': NAME, 'eventsource': 0, 'status': 0,
        'filter': {'evaltype': 0, 'conditions': [
            {'conditiontype': 0, 'operator': 0, 'value': str(gid)},        # 호스트 그룹
            {'conditiontype': 4, 'operator': 5, 'value': str(MIN_SEVERITY)},  # 심각도 >=
        ]},
        'operations': ops,
    }
    print(f"  액션 '{NAME}': 그룹 {GROUP}(id={gid}) AND 심각도 >= {MIN_SEVERITY}")
    print(f"  전송 채널: {len(ops)}개 (기존 '{SRC}' 와 동일)")
    if DRY: print('[dry-run] 적용하지 않음'); return
    if exist:
        params['actionid'] = exist[0]['actionid']
        call('action.update', params, tok); print('  갱신 완료')
    else:
        call('action.create', params, tok); print('  생성 완료')

if __name__ == '__main__':
    main()
