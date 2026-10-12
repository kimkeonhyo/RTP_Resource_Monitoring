#!/usr/bin/env python3
"""BMC(IPMI) 호스트를 Ansible 이 실제로 확인한 결과와 맞춘다.

전역 매크로를 세우고, 빠진 BMC 호스트를 만들고, 이름을 NetBox 자산명으로 통일한다.
비밀번호는 인자로 받지 않는다 — 셸 히스토리에 남기지 않으려고 환경변수로만 받는다.

  ZBX_IPMI_PASS=... python3 bmc_sync.py          # 적용
  python3 bmc_sync.py --dry-run                  # 무엇이 바뀌는지만 출력
"""
import json, os, sys, urllib.request

API  = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
USER = os.environ.get('ZBX_USER', 'Admin')
PW   = os.environ.get('ZBX_PASS', 'zabbix')
IPMI_USER = os.environ.get('ZBX_IPMI_USER', 'zbxmon')
IPMI_PASS = os.environ.get('ZBX_IPMI_PASS')
DRY = '--dry-run' in sys.argv

# Ansible setup-bmc-user.yml 의 조회 결과 (채널 8, 관리망)
BMC = {
    '<DEV_GPU01_BMC_IP>': 'dev-gpu01',
    '<DEV_GPU02_BMC_IP>': 'dev-gpu02',
    '<DEV_GPU03_BMC_IP>': 'dev-gpu03',
    '<AI_GPU04_BMC_IP>': 'ai-gpu04',
    '<INF_GPU01_BMC_IP>': 'inf-gpu01',
    '<DEV_STORAGE01_BMC_IP>': 'dev-storage01',
    '<WS07_BMC_IP>': 'ws-07',
    '<DEV_GPU04_BMC_IP>': 'dev-gpu04',   # 서버 안에서는 채널이 안 잡혀 KVM 콘솔로 확인했다
    '<INF_GPU02_BMC_IP>': 'inf-gpu02',   # <INF_GPU02_BMC_OLD_IP> 에서 관리망으로 이전 (DHCP 풀 밖 static)
}

def call(m, p, a=None):
    b = {'jsonrpc': '2.0', 'method': m, 'params': p, 'id': 1}
    if a: b['auth'] = a
    r = json.load(urllib.request.urlopen(urllib.request.Request(
        API, method='POST', headers={'Content-Type': 'application/json-rpc'},
        data=json.dumps(b).encode())))
    if 'error' in r: raise SystemExit(f"{m}: {json.dumps(r['error'], ensure_ascii=False)}")
    return r['result']

def main():
    tok = call('user.login', {'username': USER, 'password': PW})

    if not DRY and not IPMI_PASS:
        raise SystemExit('ZBX_IPMI_PASS 가 필요합니다: read -rs "?BMC 비밀번호: " P; ZBX_IPMI_PASS="$P" python3 bmc_sync.py')

    # 1) 남아 있던 전역/호스트 IPMI 매크로는 정리한다 — 값을 되읽을 수 없어 검증이 안 된다
    have = {m['macro']: m for m in call('usermacro.get', {'globalmacro': True, 'output': 'extend'}, tok)}
    junk = [have[m]['globalmacroid'] for m in ('{$IPMI.USER}', '{$IPMI.PASSWORD}') if m in have]
    if junk and not DRY:
        call('usermacro.deleteglobal', junk, tok)
        print(f'[매크로] 전역 IPMI 매크로 {len(junk)}개 제거 — 호스트 필드에 직접 넣습니다')
    want = []   # 자격증명은 호스트의 ipmi_username/ipmi_password 에 직접 넣는다
    for macro, value, mtype in want:
        if DRY:
            print(f"[매크로] {macro} {'수정' if macro in have else '생성'}")
        elif macro in have:
            call('usermacro.updateglobal', {'globalmacroid': have[macro]['globalmacroid'],
                                            'value': value, 'type': mtype}, tok)
            print(f"[매크로] {macro} 수정")
        else:
            call('usermacro.createglobal', {'macro': macro, 'value': value, 'type': mtype}, tok)
            print(f"[매크로] {macro} 생성")

    # 2) 기존 BMC 호스트 파악 — IPMI 인터페이스의 IP 로 매칭한다
    hosts = call('host.get', {'output': ['host', 'name'], 'selectInterfaces': ['type', 'ip'],
                              'selectHostGroups': ['groupid', 'name'], 'selectMacros': ['hostmacroid', 'macro']}, tok)
    by_ip, sample_groups, tpl = {}, None, None
    for h in hosts:
        for i in h['interfaces']:
            if i['type'] == '3':
                by_ip[i['ip']] = h
                sample_groups = sample_groups or [{'groupid': g['groupid']} for g in h['hostgroups']]

    for ip, server in BMC.items():
        want_name = f'{server}-bmc'
        h = by_ip.get(ip)
        if h is None:
            if DRY:
                print(f"[호스트] {want_name} ({ip}) 생성 필요")
                continue
            t = call('template.get', {'output': ['templateid'], 'filter': {'host': ['Chassis by IPMI']}}, tok)
            call('host.create', {
                'host': want_name, 'name': want_name,
                'groups': sample_groups,
                'templates': [{'templateid': t[0]['templateid']}] if t else [],
                'interfaces': [{'type': 3, 'main': 1, 'useip': 1, 'ip': ip, 'dns': '', 'port': '623'}],
                'ipmi_username': IPMI_USER, 'ipmi_password': IPMI_PASS,
                'ipmi_privilege': 2,   # USER — 센서 읽기 전용
            }, tok)
            print(f"[호스트] {want_name} ({ip}) 생성")
        elif h['host'] != want_name:
            if DRY:
                print(f"[호스트] {h['host']} → {want_name} 이름 변경")
            else:
                call('host.update', {'hostid': h['hostid'], 'host': want_name, 'name': want_name,
                                     'ipmi_username': IPMI_USER, 'ipmi_password': IPMI_PASS,
                                     'ipmi_privilege': 2}, tok)
                print(f"[호스트] {h['host']} → {want_name}")
        else:
            print(f"[호스트] {want_name} 변경 없음")

    # 3) 호스트 레벨 IPMI 매크로 제거 — 전역 매크로를 덮어써서 인증을 조용히 실패시킨다
    stale = [m['hostmacroid'] for h in by_ip.values() for m in h['macros']
             if m['macro'] in ('{$IPMI.USER}', '{$IPMI.PASSWORD}')]
    if stale:
        if DRY:
            print(f"[매크로] 호스트 레벨 IPMI 매크로 {len(stale)}개 제거 예정")
        else:
            call('usermacro.delete', stale, tok)
            print(f"[매크로] 호스트 레벨 IPMI 매크로 {len(stale)}개 제거 — 이제 전역 값이 적용됩니다")

    # 인증 방식을 동작이 확인된 RMCP+(6) 로 통일한다
    fix = [h['hostid'] for ip, h in by_ip.items() if ip in BMC]
    if fix and not DRY and IPMI_PASS:
        for hid in fix:
            call('host.update', {'hostid': hid, 'ipmi_authtype': 6, 'ipmi_privilege': 2,
                                 'ipmi_username': IPMI_USER, 'ipmi_password': IPMI_PASS}, tok)
        print(f"[호스트] {len(fix)}개 인증방식 RMCP+ / USER 권한으로 통일")

    # 4) 우리 목록에 없는 BMC 호스트는 건드리지 않고 알리기만 한다
    for ip, h in by_ip.items():
        if ip not in BMC:
            print(f"[미상] {h['host']} ({ip}) — 어느 서버의 BMC 인지 확인되지 않음. 그대로 둡니다.")

if __name__ == '__main__':
    main()
