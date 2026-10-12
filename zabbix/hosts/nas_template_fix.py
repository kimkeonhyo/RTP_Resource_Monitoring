#!/usr/bin/env python3
"""NAS 3대의 템플릿을 기종에 맞게 정리한다.

기종을 잘못 알고 우회 템플릿을 붙였던 것을 되돌린다. 2026-09-07 SNMP 로 확인:

  nas01  <NAS01_IP>   ASUSTOR AS7216R   .1.3.6.1.4.1.44738 (209개 항목)
  nas03  <NAS03_IP>  Synology DS920+   .1.3.6.1.4.1.6574
  NAS02  <NAS02_IP>   Synology DS2422+  .1.3.6.1.4.1.6574

하는 일:
  1) nas03 에 'IMS Synology NAS by SNMP' 연결
     — NAS02 가 쓰는 그 템플릿이 그대로 맞다. 새로 만들 것이 없다.
  2) nas01·nas03 에서 'IMS NAS Filesystem by SNMP'(hrStorage) 연결 해제
     — 세 대 모두 전용 MIB 가 있어 우회가 필요 없어졌다.
       아이템도 같이 지운다(clear).
  3) 그 템플릿을 삭제
     — 쓰는 호스트가 없으면 지운다. 남아 있으면 건너뛰고 알려준다.

잃는 것: nas01 의 `/volume0`(ADM 시스템 파티션, 22.1%). hrStorage 에만 있고
ASUSTOR 볼륨 테이블에는 Volume1·Volume2 만 나온다. 시스템 파티션은 사용자가
쓰는 영역이 아니라 빼도 무리가 없다고 판단했다.

nas01 은 templates/asustor_nas_template.py 를 먼저 돌려야 한다 — 안 그러면
볼륨 지표가 잠깐 비게 된다. 이 스크립트가 확인하고 멈춘다.

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/zabbix -- python3 hosts/nas_template_fix.py

미리 보기:  DRY_RUN=1 infisical run ... -- python3 hosts/nas_template_fix.py
"""
import json
import os
import urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DRY = os.environ.get('DRY_RUN') == '1'

SYNO = 'IMS Synology NAS by SNMP'
ASUSTOR = 'IMS ASUSTOR NAS by SNMP'
HRSTORAGE = 'IMS NAS Filesystem by SNMP'


def call(method, params, token=None):
    body = {'jsonrpc': '2.0', 'method': method, 'params': params, 'id': 1}
    if token:
        body['auth'] = token
    req = urllib.request.Request(API, json.dumps(body).encode(),
                                 {'Content-Type': 'application/json-rpc'})
    res = json.load(urllib.request.urlopen(req, timeout=120))
    if 'error' in res:
        raise SystemExit(f"{method}: {res['error']}")
    return res['result']


def tid_of(name, tok):
    ts = call('template.get', {'filter': {'host': [name]}, 'output': ['templateid']}, tok)
    return ts[0]['templateid'] if ts else None


def main():
    pw = os.environ.get('ZBX_PASS')
    if not pw:
        raise SystemExit('ZBX_PASS 가 없다. infisical run 으로 주입해서 실행해라.')
    tok = call('user.login',
               {'username': os.environ.get('ZBX_USER', 'Admin'), 'password': pw})

    t_syno = tid_of(SYNO, tok)
    t_asus = tid_of(ASUSTOR, tok)
    t_hr = tid_of(HRSTORAGE, tok)
    if not t_syno:
        raise SystemExit(f'템플릿 {SYNO!r} 이 없다')

    # ── 1) nas03 ← Synology 템플릿 ──────────────────────────────────────
    print('1) nas03 에 Synology 템플릿 연결')
    hs = call('host.get', {'filter': {'host': ['nas03']}, 'output': ['hostid', 'name'],
                           'selectParentTemplates': ['templateid', 'name']}, tok)
    if not hs:
        print('   nas03: 호스트 없음 — 건너뜀')
    else:
        h = hs[0]
        if t_syno in [x['templateid'] for x in h['parentTemplates']]:
            print(f"   {h['name']}: 이미 연결됨")
        else:
            print(f"   {h['name']}: 연결" + (' (DRY_RUN)' if DRY else ''))
            if not DRY:
                call('host.update', {
                    'hostid': h['hostid'],
                    'templates': [{'templateid': x['templateid']} for x in h['parentTemplates']]
                                 + [{'templateid': t_syno}],
                }, tok)

    # ── 2) hrStorage 우회 템플릿 연결 해제 ──────────────────────────────
    print(f'\n2) {HRSTORAGE!r} 연결 해제')
    if not t_hr:
        print('   템플릿이 이미 없음 — 건너뜀')
    else:
        users = call('host.get', {'templateids': t_hr, 'output': ['hostid', 'host', 'name'],
                                  'selectParentTemplates': ['templateid', 'name']}, tok)
        if not users:
            print('   쓰는 호스트 없음')
        for h in users:
            # nas01 은 대체 템플릿이 붙은 뒤에 떼야 지표가 비지 않는다
            if h['host'] == 'nas01' and t_asus not in [x['templateid'] for x in h['parentTemplates']]:
                raise SystemExit(
                    '   nas01 에 ASUSTOR 템플릿이 아직 없다. 먼저 이것을 돌려라:\n'
                    '     python3 templates/asustor_nas_template.py')
            print(f"   {h['name']}: 연결 해제 + 아이템 삭제" + (' (DRY_RUN)' if DRY else ''))
            if not DRY:
                # templates_clear 가 상속 아이템까지 지운다. unlink 만 하면 고아로 남는다.
                call('host.update', {'hostid': h['hostid'],
                                     'templates_clear': [{'templateid': t_hr}]}, tok)

    # ── 3) 템플릿 삭제 ──────────────────────────────────────────────────
    print(f'\n3) {HRSTORAGE!r} 삭제')
    if not t_hr:
        print('   이미 없음')
    elif DRY:
        print('   삭제 예정 (DRY_RUN)')
    else:
        left = call('host.get', {'templateids': t_hr, 'output': ['host']}, tok)
        if left:
            print(f"   아직 쓰는 호스트가 있어 남긴다: {[x['host'] for x in left]}")
        else:
            call('template.delete', [t_hr], tok)
            print('   삭제 완료')

    print('\n완료' + (' (DRY_RUN — 아무것도 바꾸지 않았다)' if DRY else ''))


if __name__ == '__main__':
    main()
