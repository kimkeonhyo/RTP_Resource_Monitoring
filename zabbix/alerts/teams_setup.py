#!/usr/bin/env python3
"""Zabbix 장애 알림을 Teams 채널로 보낸다 (MS Teams Workflow 미디어 타입).

웹훅 URL 은 그 자체가 인증 수단이라 인자로 받지 않는다 — 환경변수로만 받는다.
  read -rs "?Teams 웹훅 URL: " U; TEAMS_URL="$U" python3 teams_setup.py; unset U
"""
import json, os, sys, urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
URL = os.environ.get('TEAMS_URL')
ZBX_URL = os.environ.get('ZBX_FRONTEND', 'http://<ZABBIX_SERVER_IP>')
MT_TEAMS = '53'          # MS Teams Workflow
ACTION = 'PoC 장애 알림'
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
    if not URL:
        print('[안내] TEAMS_URL 없음 — 미디어 등록은 건너뛰고 액션만 손봅니다')
    if URL and not URL.startswith('https://'):
        raise SystemExit('웹훅 URL 이 https 로 시작하지 않습니다. 복사한 값을 확인하세요.')
    tok = call('user.login', {'username': os.environ.get('ZBX_USER', 'Admin'),
                              'password': os.environ.get('ZBX_PASS', 'zabbix')})

    # 알림 본문의 링크가 동작하려면 프론트엔드 주소가 필요하다
    g = {m['macro']: m for m in call('usermacro.get', {'globalmacro': True, 'output': 'extend'}, tok)}
    if URL and '{$ZABBIX.URL}' not in g and not DRY:
        call('usermacro.createglobal', {'macro': '{$ZABBIX.URL}', 'value': ZBX_URL}, tok)
        print(f'[매크로] {{$ZABBIX.URL}} = {ZBX_URL}')

    if URL and not DRY:
        call('mediatype.update', {'mediatypeid': MT_TEAMS, 'status': 0}, tok)
        print('[미디어] MS Teams Workflow 활성화')

    # 웹훅 URL 은 사용자 미디어의 sendto 로 들어간다 (teams_endpoint = {ALERT.SENDTO})
    u = URL and call('user.get', {'output': ['userid', 'username'], 'selectMedias': 'extend',
                          'filter': {'username': ['Admin']}}, tok)[0]
    medias = [m for m in u['medias'] if m['mediatypeid'] != MT_TEAMS] if u else []
    if URL:
        medias.append({'mediatypeid': MT_TEAMS, 'sendto': URL,
                       'active': '0', 'severity': '63', 'period': '1-7,00:00-24:00'})
    if URL and not DRY:
        call('user.update', {'userid': u['userid'],
                             'medias': [{k: v for k, v in m.items() if k in
                                         ('mediatypeid', 'sendto', 'active', 'severity', 'period')}
                                        for m in medias]}, tok)
        print('[사용자] Admin 에 Teams 미디어 등록 (전 심각도, 24시간)')

    # 파일 로그 알림은 그대로 두고 Teams 를 한 단계 더 붙인다 — 붙지 않을 때 원인을 볼 수 있어야 한다
    a = call('action.get', {'output': 'extend', 'selectOperations': 'extend',
                            'filter': {'name': [ACTION]}}, tok)
    if not a:
        print(f'[액션] {ACTION} 없음 — 건너뜀'); return
    a = a[0]
    def clean(o):
        d = {k: v for k, v in o.items() if k in
             ('operationtype', 'esc_period', 'esc_step_from', 'esc_step_to',
              'evaltype', 'opmessage', 'opmessage_grp', 'opmessage_usr')}
        if 'opmessage' in d:
            m = dict(d['opmessage'])
            if m.get('default_msg') == '1':      # 기본 메시지 사용 시엔 subject/message 를 넘기면 거부된다
                m.pop('subject', None); m.pop('message', None)
            d['opmessage'] = m
        return d
    ops = [clean(o) for o in a['operations']]
    if any(o.get('opmessage', {}).get('mediatypeid') == MT_TEAMS for o in ops):
        print('[액션] Teams 오퍼레이션 이미 있음')
    else:
        ops.append({'operationtype': '0', 'esc_period': '0', 'esc_step_from': '1',
                    'esc_step_to': '1', 'evaltype': '0',
                    'opmessage': {'default_msg': '1', 'mediatypeid': MT_TEAMS},
                    'opmessage_grp': [{'usrgrpid': '7'}], 'opmessage_usr': []})
        if not DRY:
            call('action.update', {'actionid': a['actionid'], 'operations': ops}, tok)
            print(f'[액션] {ACTION} 에 Teams 전송 추가')
    print('완료 — 테스트는 Zabbix UI 의 미디어 타입 목록에서 "Test" 로 할 수 있습니다')

if __name__ == '__main__':
    main()
