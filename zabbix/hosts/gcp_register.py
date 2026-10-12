#!/usr/bin/env python3
"""GCP VM 을 Zabbix 에 등록한다 (그룹 'IMS 클라우드').

에이전트는 ansible/playbooks/install-zabbix-cloud.yml 로 먼저 깔아야 한다.
등록만 먼저 하면 곧바로 '에이전트 응답 없음' 이 뜬다.

대상은 ansible/inventory/gcp/hosts.ini 에서 읽는다. 목록을 두 군데 두면
반드시 어긋난다. gcp_iap_only 그룹(n8n·vms-cloud)은 제외한다 — 아직 접속이
안 돼 에이전트를 못 깔았다.

하는 일
  1) 호스트 생성: 그룹 26, 템플릿 'Linux by Zabbix agent' + 'ICMP Ping',
     에이전트 인터페이스 10050
  2) 'ICMP Ping: Unavailable by ICMP ping' 트리거 비활성화
     — 사내와 같은 이유다. ICMP 단독은 오탐이 잦아 아래 AND 트리거로 대체한다
  3) '시스템 다운 (ICMP·에이전트 5분 동시 불통)' 트리거 생성 (사내와 같은 식)
  4) 알림 액션 9 에 그룹 26 추가 — 안 하면 등록해도 알림이 한 건도 안 나간다

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/watch -- python3 hosts/gcp_register.py

미리 보기:  DRY_RUN=1 ...
"""
import configparser
import json
import os
import pathlib
import urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DRY = os.environ.get('DRY_RUN') == '1'

INVENTORY = pathlib.Path(__file__).resolve().parent.parent / 'ansible/inventory/gcp/hosts.ini'
SKIP_SECTIONS = {'gcp_iap_only'}
GROUP = 'IMS 클라우드'
TEMPLATES = ['Linux by Zabbix agent', 'ICMP Ping']
ICMP_TRIGGER = 'Unavailable by ICMP ping'
DOWN = '시스템 다운 (ICMP·에이전트 5분 동시 불통)'
NOTIFY_ACTION = '9'          # 서버·워크스테이션 알림
CT_GROUP, OP_EQ = 0, 0

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


def targets():
    """인벤토리에서 (별칭, IP) 를 읽는다. 별칭이 Zabbix 기술명이 된다."""
    cp = configparser.ConfigParser(allow_no_value=True, delimiters=('\n',))
    cp.read(INVENTORY, encoding='utf-8')
    out = []
    for sec in cp.sections():
        if not sec.startswith('gcp_') or sec in SKIP_SECTIONS or ':' in sec:
            continue
        for line in cp[sec]:
            parts = line.split()
            ip = next((p.split('=', 1)[1] for p in parts[1:] if p.startswith('ansible_host=')), None)
            if ip:
                out.append((parts[0], ip))
    return sorted(set(out))


def main():
    login()
    print('GCP VM 등록' + (' (DRY_RUN)' if DRY else ''))
    print(f'{API}\n{INVENTORY}\n')

    hosts = targets()
    gid = call('hostgroup.get', {'output': ['groupid'], 'filter': {'name': [GROUP]}})[0]['groupid']
    tpl = call('template.get', {'output': ['templateid', 'host'], 'filter': {'host': TEMPLATES}})
    missing = [n for n in TEMPLATES if not any(t['host'] == n for t in tpl)]
    if missing:
        raise SystemExit(f'템플릿 없음: {missing}')
    print(f'대상 {len(hosts)}대 → 그룹 {GROUP}({gid}), 템플릿 {TEMPLATES}\n')

    for name, ip in hosts:
        exists = call('host.get', {'output': ['hostid', 'host'], 'filter': {'host': [name]}})
        if exists:
            hostid = exists[0]['hostid']
            print(f'  {name:<18} {ip:<14} 이미 있음')
        else:
            dup = call('host.get', {'output': ['hostid', 'host'], 'filter': {'ip': ip}})
            if dup:
                print(f"  {name:<18} {ip:<14} ⚠ 그 IP 는 이미 '{dup[0]['host']}' 다 — 건너뜀")
                continue
            print(f'  {name:<18} {ip:<14} 생성')
            if DRY:
                continue
            hostid = call('host.create', {
                'host': name, 'groups': [{'groupid': gid}],
                'templates': [{'templateid': t['templateid']} for t in tpl],
                'interfaces': [{'type': 1, 'main': 1, 'useip': 1, 'ip': ip,
                                'dns': '', 'port': '10050'}],
            })['hostids'][0]

        if DRY:
            continue

        # ICMP 단독 트리거는 끈다. 오탐이 잦아 사내에서도 껐다.
        for t in call('trigger.get', {'hostids': hostid, 'output': ['triggerid', 'status'],
                                      'search': {'description': ICMP_TRIGGER}}):
            if t['status'] == '0':
                call('trigger.update', {'triggerid': t['triggerid'], 'status': 1})
                print(f'       └ {ICMP_TRIGGER} 비활성화')

        # 실제 다운 판정: ICMP 와 에이전트가 5분 동안 동시에 죽었을 때만.
        if not call('trigger.get', {'hostids': hostid, 'output': ['triggerid'],
                                    'filter': {'description': DOWN}}):
            call('trigger.create', {
                'description': DOWN, 'priority': 5, 'manual_close': 1,
                'expression': (f'min(/{name}/icmpping,5m)=0 and '
                               f'max(/{name}/zabbix[host,agent,available],5m)=0'),
                'comments': 'ICMP 와 에이전트가 동시에 5분간 불통이어야 발생한다. '
                            '둘 중 하나만 죽는 경우는 대개 장비가 아니라 경로 문제다.',
            })
            print(f'       └ {DOWN} 생성')

    # 그룹 26 이 어떤 알림 액션에도 안 걸려 있으면 등록해도 조용하다.
    a = call('action.get', {'actionids': NOTIFY_ACTION, 'output': 'extend',
                            'selectFilter': 'extend'})[0]
    conds = a['filter']['conditions']
    if any(int(c['conditiontype']) == CT_GROUP and c['value'] == gid for c in conds):
        print(f"\n알림 액션 [{NOTIFY_ACTION}] {a['name']} — 그룹 {gid} 이미 포함")
    else:
        print(f"\n알림 액션 [{NOTIFY_ACTION}] {a['name']} — 그룹 {gid}({GROUP}) 추가")
        if not DRY:
            keep = []
            for c in conds:
                k = {'conditiontype': c['conditiontype'], 'operator': c['operator'],
                     'value': c['value']}
                if c.get('value2'):
                    k['value2'] = c['value2']
                keep.append(k)
            keep.append({'conditiontype': CT_GROUP, 'operator': OP_EQ, 'value': gid})
            call('action.update', {'actionid': NOTIFY_ACTION,
                                   'name': '서버·워크스테이션·클라우드 알림',
                                   'filter': {'evaltype': 0, 'conditions': keep}})

    print('\n완료' + (' (DRY_RUN — 아무것도 바꾸지 않았다)' if DRY else ''))
    if not DRY:
        print('첫 수집까지 1~2분. ICMP 가 막힌 장비가 있으면 icmpping 이 0 으로 남으니 확인할 것.')


if __name__ == '__main__':
    main()
