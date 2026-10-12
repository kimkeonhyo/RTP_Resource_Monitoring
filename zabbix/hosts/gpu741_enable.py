#!/usr/bin/env python3
"""GPU Server 741GE-TNRT (<GPU741_IP>) 을 관제에 올린다.

전원이 들어와 사용 가능해졌다. Zabbix 에는 NetBox 임포트로 만들어진 껍데기
호스트(nb-10-128-30-197)가 비활성 상태로 있었고 템플릿은 ICMP Ping 뿐이었다.

에이전트는 ansible/playbooks/install-zabbix-agent.yml 로 먼저 깔았다
(Ubuntu 22.04, RTX A5000 4장, zabbix-agent2 7.0.30, agent.ping OK).

기술명을 Ansible 인벤토리 이름과 맞춘다. 에이전트가 Hostname 을 인벤토리
이름으로 쓰므로 어긋나면 액티브 체크·자동 등록에서 'host not found' 가 쌓인다
(rtpulse 에서 겪었다).

NPU 템플릿은 붙이지 않는다. mblt-status 는 설치돼 있지만 드라이버가 N/A 이고
장치 목록이 비어 있다 — 붙이면 발견이 0개인 채로 정상처럼 보인다.

사내 표준 구성을 따른다.
  · ICMP 단독 트리거는 끈다 (오탐이 잦다)
  · 다운 판정은 ICMP 와 에이전트가 5분간 동시에 죽었을 때만

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/watch -- python3 hosts/gpu741_enable.py
미리 보기:  DRY_RUN=1 ...
"""
import json
import os
import urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DRY = os.environ.get('DRY_RUN') == '1'

IP = '<GPU741_IP>'
NEW_HOST = 'GPU-server-741GE-TNRT'      # Ansible inventory_hostname 과 동일
VISIBLE = 'GPU Server 741GE-TNRT (tower)'
ADD_TEMPLATES = ['Linux by Zabbix agent', 'IMS NVIDIA GPU by Zabbix agent']
ICMP_TRIGGER = 'Unavailable by ICMP ping'
DOWN = '시스템 다운 (ICMP·에이전트 5분 동시 불통)'

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
    print(f'{VISIBLE} 관제 등록' + (' (DRY_RUN)' if DRY else ''))
    print(f'{API}\n')

    hs = call('host.get', {'output': ['hostid', 'host', 'name', 'status'], 'filter': {'ip': IP},
                           'selectParentTemplates': ['templateid', 'host']})
    if not hs:
        raise SystemExit(f'{IP} 로 등록된 호스트가 없다')
    h = hs[0]
    print(f"현재: {h['host']} / {h['name']} / {'활성' if h['status']=='0' else '비활성'}")
    print(f"      템플릿 {[t['host'] for t in h['parentTemplates']]}")

    have = {t['host']: t['templateid'] for t in h['parentTemplates']}
    missing = [n for n in ADD_TEMPLATES if n not in have]
    upd = {'hostid': h['hostid']}
    if h['host'] != NEW_HOST:
        print(f"  기술명 {h['host']} → {NEW_HOST}")
        upd['host'] = NEW_HOST
        upd['name'] = VISIBLE          # 기술명을 바꾸면 표시명도 같이 줘야 유지된다
    if missing:
        print(f"  템플릿 추가 {missing}")
        tids = call('template.get', {'output': ['templateid', 'host'],
                                     'filter': {'host': ADD_TEMPLATES}})
        found = {t['host']: t['templateid'] for t in tids}
        lack = [n for n in ADD_TEMPLATES if n not in found]
        if lack:
            raise SystemExit(f'템플릿 없음: {lack}')
        upd['templates'] = [{'templateid': v} for v in {**have, **found}.values()]
    if len(upd) > 1 and not DRY:
        call('host.update', upd)
    elif len(upd) == 1:
        print('  기술명·템플릿 이미 맞음')

    if DRY:
        print(f'  ICMP 단독 트리거 끄기 / {DOWN} 생성 / 호스트 활성화 예정')
        print('\nDRY_RUN — 아무것도 바꾸지 않았다')
        return

    for t in call('trigger.get', {'hostids': h['hostid'], 'output': ['triggerid', 'status'],
                                  'search': {'description': ICMP_TRIGGER}}):
        if t['status'] == '0':
            call('trigger.update', {'triggerid': t['triggerid'], 'status': 1})
            print(f'  {ICMP_TRIGGER} 비활성화')

    if call('trigger.get', {'hostids': h['hostid'], 'output': ['triggerid'],
                            'filter': {'description': DOWN}}):
        print(f'  {DOWN} 이미 있음')
    else:
        call('trigger.create', {
            'description': DOWN, 'priority': 5, 'manual_close': 1,
            'expression': (f'min(/{NEW_HOST}/icmpping,5m)=0 and '
                           f'max(/{NEW_HOST}/zabbix[host,agent,available],5m)=0'),
            'comments': 'ICMP 와 에이전트가 동시에 5분간 불통이어야 발생한다. '
                        '둘 중 하나만 죽는 경우는 대개 장비가 아니라 경로 문제다.',
        })
        print(f'  {DOWN} 생성')

    if h['status'] != '0':
        call('host.update', {'hostid': h['hostid'], 'status': 0})
        print('  호스트 활성화')
    else:
        print('  이미 활성')

    print('\n완료. 첫 수집까지 1~2분.')


if __name__ == '__main__':
    main()
