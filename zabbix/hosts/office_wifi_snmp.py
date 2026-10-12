#!/usr/bin/env python3
"""office_wifi(ipTIME AP)를 새 주소로 옮기고 SNMP 관제로 바꾼다.

누군가 이 AP 의 '인터넷 공유 기능'(=NAT)을 끄고 공유기 모드에서 AP 모드로
바꿨다. 그러면서 관리 주소가 WAN 쪽 <OFFICE_WIFI_OLD_IP> 에서 LAN/브리지 쪽
<OFFICE_WIFI_IP> 으로 넘어갔고, Zabbix 는 옛 주소를 보고 있어 2026-09-09 17:10
부터 'Unavailable by ICMP ping' 오탐을 계속 내보내고 있었다.

  옛 주소 MAC OUI = AzureWave(WAN 포트) / 현 주소 MAC OUI = EFM(LAN 브리지)
  제조사 OUI 가 달라 다른 기기로 오해하기 쉽다 — ODM 보드라 포트마다 블록이 다르다.

같이 SNMP 관제로 올린다. AP 에서 SNMP v2c(읽기전용)를 켜 뒀고
UCD-SNMP MIB 이 살아 있어 ICMP 만 보던 것보다 훨씬 많이 들어온다.

  laLoad ✓  ssCpuRaw* ✓  memTotalReal/memAvailReal ✓  IF-MIB ✓
  dskTable ✗ — 파일시스템 발견은 아이템 0개가 된다. ASUSTOR 때와 같은 함정으로,
  빈 목록을 정상 수신한 것이라 LLD 는 '정상'으로 뜬다. AP 라 볼 것도 없다.

ICMP Ping 템플릿은 뗀다. Linux by SNMP 가 ICMP 아이템·트리거를 자체 제공하므로
둘 다 붙이면 icmpping 키가 겹쳐 등록이 거부된다 (nas01·nas03 과 같은 구성).
알림 액션 8 의 이름 필터 'Unavailable by ICMP ping' 은 'Linux: Unavailable by
ICMP ping' 에도 부분일치하므로 알림은 그대로 나간다.

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/zabbix -- python3 hosts/office_wifi_snmp.py

미리 보기:  DRY_RUN=1 ...
"""
import json
import os
import urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DRY = os.environ.get('DRY_RUN') == '1'

HOST = 'office_wifi'
NEW_IP = '<OFFICE_WIFI_IP>'
COMMUNITY = os.environ.get('SNMP_COMMUNITY')   # 기본값을 두지 않는다 — 소스에 비밀값을 남기지 않기 위해
DROP_TEMPLATE = 'ICMP Ping'
ADD_TEMPLATE = 'Linux by SNMP'
# ipTIME 사설 MIB. snmpwalk 로 실제 값을 확인했다.
EXTRA = [
    ('ipTIME 모델', 'iptime.model', '1.3.6.1.4.1.12874.1.1.2.0'),
    ('ipTIME 펌웨어', 'iptime.firmware', '1.3.6.1.4.1.12874.1.1.3.0'),
]

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
    if not COMMUNITY and not DRY:
        raise SystemExit('SNMP_COMMUNITY 가 필요합니다. infisical run --env=gcp --path=/zabbix -- python3 hosts/office_wifi_snmp.py')
    login()
    print(f'{HOST} → {NEW_IP} SNMP 전환' + (' (DRY_RUN)' if DRY else ''))
    print(f'{API}\n')

    h = call('host.get', {'filter': {'host': [HOST]}, 'output': ['hostid', 'host', 'name'],
                          'selectInterfaces': ['interfaceid', 'type', 'ip', 'port', 'main'],
                          'selectParentTemplates': ['templateid', 'host'],
                          'selectMacros': ['macro', 'value']})[0]
    print('현재 인터페이스:', [(i['type'], i['ip'], i['port']) for i in h['interfaces']])
    print('현재 템플릿:', [t['host'] for t in h['parentTemplates']])

    # 1) 기존 인터페이스 주소를 새 주소로
    for i in h['interfaces']:
        if i['ip'] != NEW_IP:
            print(f"  인터페이스 {i['interfaceid']} (type{i['type']}) {i['ip']} → {NEW_IP}")
            if not DRY:
                call('hostinterface.update', {'interfaceid': i['interfaceid'], 'ip': NEW_IP})

    # 2) SNMP 커뮤니티 매크로
    if not any(m['macro'] == '{$SNMP_COMMUNITY}' for m in h['macros']):
        print(f'  매크로 {{$SNMP_COMMUNITY}} = {COMMUNITY} 추가')
        if not DRY:
            call('usermacro.create', {'hostid': h['hostid'],
                                      'macro': '{$SNMP_COMMUNITY}', 'value': COMMUNITY})
    else:
        print('  매크로 {$SNMP_COMMUNITY} 이미 있음')

    # 3) SNMP 인터페이스
    snmp = next((i for i in h['interfaces'] if i['type'] == '2'), None)
    if snmp:
        print(f"  SNMP 인터페이스 이미 있음 ({snmp['ip']}:{snmp['port']})")
        snmp_id = snmp['interfaceid']
    else:
        print(f'  SNMP 인터페이스 생성 {NEW_IP}:161 (v2c, {{$SNMP_COMMUNITY}})')
        snmp_id = None
        if not DRY:
            snmp_id = call('hostinterface.create', {
                'hostid': h['hostid'], 'type': 2, 'main': 1, 'useip': 1,
                'ip': NEW_IP, 'dns': '', 'port': '161',
                'details': {'version': 2, 'community': '{$SNMP_COMMUNITY}',
                            'bulk': 1, 'max_repetitions': 10},
            })['interfaceids'][0]

    # 4) 템플릿 교체. ICMP Ping 은 templates_clear 로 떼야 아이템·열린 문제까지 사라진다.
    have = {t['host']: t['templateid'] for t in h['parentTemplates']}
    if ADD_TEMPLATE in have:
        print(f'  {ADD_TEMPLATE} 이미 연결됨')
    else:
        add = call('template.get', {'output': ['templateid'], 'filter': {'host': [ADD_TEMPLATE]}})
        if not add:
            raise SystemExit(f'{ADD_TEMPLATE} 템플릿이 없다')
        keep = [{'templateid': v} for k, v in have.items() if k != DROP_TEMPLATE]
        clear = [{'templateid': have[DROP_TEMPLATE]}] if DROP_TEMPLATE in have else []
        print(f'  템플릿: {DROP_TEMPLATE} 제거' if clear else '  템플릿:', f'+ {ADD_TEMPLATE}')
        if not DRY:
            call('host.update', {
                'hostid': h['hostid'],
                'templates': keep + [{'templateid': add[0]['templateid']}],
                **({'templates_clear': clear} if clear else {}),
            })

    # 5) 사설 MIB 아이템 (모델·펌웨어)
    if DRY:
        for name, key, oid in EXTRA:
            print(f'  아이템 생성 예정: {name} ({key})')
    elif snmp_id:
        for name, key, oid in EXTRA:
            if call('item.get', {'hostids': h['hostid'], 'output': ['itemid'],
                                 'filter': {'key_': key}}):
                print(f'  아이템 {key} 이미 있음')
                continue
            call('item.create', {
                'hostid': h['hostid'], 'name': name, 'key_': key, 'type': 20,
                'snmp_oid': oid, 'value_type': 4, 'delay': '1h',
                'interfaceid': snmp_id, 'trends': '0', 'history': '7d',
                'description': 'ipTIME 사설 MIB (enterprises.12874).',
            })
            print(f'  아이템 생성: {name}')

    # 6) 이 기기가 못 내주는 아이템은 꺼 둔다. 두면 '지원되지 않는 항목'으로
    #    영구히 남아 진짜 문제를 가린다.
    #    · CPU walk — ssCpuRawGuest(.1.3.6.1.4.1.2021.11.65.0) 를 안 내줘 walk 전체가 실패한다.
    #      ssCpuRawUser 등 일부는 있지만 Zabbix 는 범위를 통째로 요구한다.
    #    · 스왑 — 스왑이 0 이라 사용률 계산이 0 으로 나눈다.
    for key in ('system.cpu.walk', 'system.cpu.num[snmp]', 'system.swap.pfree[snmp]'):
        found = call('item.get', {'hostids': h['hostid'], 'output': ['itemid', 'status'],
                                  'filter': {'key_': key}})
        for it in found:
            if it['status'] == '1':
                print(f'  아이템 {key} 이미 꺼짐')
                continue
            print(f'  아이템 끔: {key}')
            if not DRY:
                call('item.update', {'itemid': it['itemid'], 'status': 1})

    # CPU 발견 규칙도 같은 OID 를 요구해 영구 오류로 남는다.
    for r in call('discoveryrule.get', {'hostids': h['hostid'], 'output': ['itemid', 'status'],
                                        'filter': {'key_': 'cpu.discovery[snmp]'}}):
        if r['status'] == '1':
            print('  LLD cpu.discovery[snmp] 이미 꺼짐')
            continue
        print('  LLD 끔: cpu.discovery[snmp]')
        if not DRY:
            call('discoveryrule.update', {'itemid': r['itemid'], 'status': 1})

    print('\n완료' + (' (DRY_RUN — 아무것도 바꾸지 않았다)' if DRY else ''))
    if not DRY:
        print('첫 수집까지 1~2분. 파일시스템 발견은 dskTable 이 없어 0개가 정상이다.')


if __name__ == '__main__':
    main()
