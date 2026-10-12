#!/usr/bin/env python3
"""ASUSTOR NAS(nas01·nas03)의 파일시스템 사용률을 hrStorage 로 수집한다.

왜 필요한가:
  'Linux by SNMP' 의 Mounted filesystem discovery 는 UCD-SNMP-MIB dskTable
  (.1.3.6.1.4.1.2021.9) 을 읽는데, 이 NAS 들은 그 테이블을 아예 내주지 않는다
  ("No Such Object"). 빈 목록을 정상적으로 받으니 LLD 는 '정상'으로 뜨고
  아이템만 0개가 된다. 반면 hrStorage(.1.3.6.1.2.1.25.2.3.1) 에는 /volume0~2 와
  /share/* 가 모두 있다. 그래서 hrStorage 로 읽는 템플릿을 따로 만든다.
  (NAS02 는 시놀로지라 IMS Synology NAS by SNMP 가 전용 MIB 로 이미 읽고 있다)

주의 — 할당 단위:
  hrStorage 는 32비트 카운터라 큰 볼륨은 할당 단위를 키워서 답한다.
  nas01 기준 /volume1 은 4096B, /volume2 는 131072B 다. 그래서
    · 절대 용량은 반드시 (블록 수 × 할당 단위) 로 계산하고
    · 사용률은 단위가 약분되므로 블록 수끼리 나눈다.
  단위를 고정값으로 박으면 볼륨마다 용량이 엉뚱하게 나온다.

기본적으로 /volume<숫자> 만 발견한다. /share/* 는 대부분 같은 볼륨의 공유
폴더라 중복이다. 필요하면 {$NAS.FS.NAME.MATCHES} 를 호스트에서 덮어쓰면 된다.

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/zabbix -- python3 nas_fs_template.py

템플릿만 만들고 호스트 연결은 건너뛰려면:
    NO_LINK=1 infisical run ... -- python3 nas_fs_template.py
"""
import json
import os
import urllib.request
import uuid

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
NO_LINK = os.environ.get('NO_LINK') == '1'

# Zabbix 템플릿의 기술명에는 한글을 못 쓴다 (ASCII·숫자·공백·.·-·_ 만).
# 트리거 식도 기술명을 참조하므로 둘을 나눠 둔다.
TEMPLATE      = 'IMS NAS Filesystem by SNMP'
TEMPLATE_NAME = 'IMS NAS 파일시스템 by SNMP'
GROUP = 'Templates/Server hardware'
TARGETS = ['nas01', 'nas03']

# hrStorage 테이블
O_DESCR = '1.3.6.1.2.1.25.2.3.1.3'   # 마운트 경로
O_UNITS = '1.3.6.1.2.1.25.2.3.1.4'   # 할당 단위 (B)
O_SIZE  = '1.3.6.1.2.1.25.2.3.1.5'   # 전체 블록 수
O_USED  = '1.3.6.1.2.1.25.2.3.1.6'   # 사용 블록 수


def u():
    return uuid.uuid4().hex


def call(method, params, token=None):
    body = {'jsonrpc': '2.0', 'method': method, 'params': params, 'id': 1}
    if token:
        body['auth'] = token
    req = urllib.request.Request(API, json.dumps(body).encode(),
                                 {'Content-Type': 'application/json-rpc'})
    res = json.load(urllib.request.urlopen(req, timeout=90))
    if 'error' in res:
        raise SystemExit(f"{method}: {res['error']}")
    return res['result']


def build_yaml():
    t = TEMPLATE                      # 트리거 식이 참조하는 기술명
    return f"""zabbix_export:
  version: '7.0'
  template_groups:
    - uuid: {u()}
      name: '{GROUP}'
  templates:
    - uuid: {u()}
      template: '{t}'
      name: '{TEMPLATE_NAME}'
      description: 'hrStorage(HOST-RESOURCES-MIB) 로 파일시스템 사용률을 읽는다. UCD dskTable 을 내주지 않는 NAS(ASUSTOR 등)용.'
      groups:
        - name: '{GROUP}'
      macros:
        - macro: '{{$NAS.FS.NAME.MATCHES}}'
          value: '^/volume[0-9]+$'
          description: '발견할 마운트 경로. 기본은 볼륨만 — /share/* 는 같은 볼륨의 공유 폴더라 중복이다.'
        - macro: '{{$NAS.FS.PUSED.WARN}}'
          value: '80'
        - macro: '{{$NAS.FS.PUSED.CRIT}}'
          value: '90'
      discovery_rules:
        - uuid: {u()}
          name: '파일시스템 발견'
          type: SNMP_AGENT
          snmp_oid: 'discovery[{{#FSNAME}},{O_DESCR}]'
          key: nas.fs.discovery
          delay: 1h
          filter:
            conditions:
              - macro: '{{#FSNAME}}'
                value: '{{$NAS.FS.NAME.MATCHES}}'
                formulaid: A
          item_prototypes:
            # ── 원자료 3개. 계산 아이템의 last() 가 이력에서 읽으므로
            #    history 를 0 으로 두면 안 된다. 추세(trends)만 끈다.
            - uuid: {u()}
              name: '{{#FSNAME}}: 할당 단위'
              type: SNMP_AGENT
              snmp_oid: '{O_UNITS}.{{#SNMPINDEX}}'
              key: 'nas.fs.units[{{#SNMPINDEX}}]'
              delay: 1h
              history: '1d'
              trends: '0'
              units: B
              description: '볼륨마다 다르다. 32비트 카운터에 큰 볼륨을 담으려고 NAS 가 단위를 키운다.'
            - uuid: {u()}
              name: '{{#FSNAME}}: 전체 블록'
              type: SNMP_AGENT
              snmp_oid: '{O_SIZE}.{{#SNMPINDEX}}'
              key: 'nas.fs.total.blocks[{{#SNMPINDEX}}]'
              delay: 5m
              history: '1d'
              trends: '0'
            - uuid: {u()}
              name: '{{#FSNAME}}: 사용 블록'
              type: SNMP_AGENT
              snmp_oid: '{O_USED}.{{#SNMPINDEX}}'
              key: 'nas.fs.used.blocks[{{#SNMPINDEX}}]'
              delay: 5m
              history: '1d'
              trends: '0'
            # ── 실제로 보는 값 3개 ────────────────────────────────────────
            - uuid: {u()}
              name: '{{#FSNAME}}: 전체 용량'
              type: CALCULATED
              key: 'nas.fs.total[{{#SNMPINDEX}}]'
              value_type: FLOAT
              units: B
              delay: 5m
              params: 'last(//nas.fs.units[{{#SNMPINDEX}}])*last(//nas.fs.total.blocks[{{#SNMPINDEX}}])'
            - uuid: {u()}
              name: '{{#FSNAME}}: 사용 용량'
              type: CALCULATED
              key: 'nas.fs.used[{{#SNMPINDEX}}]'
              value_type: FLOAT
              units: B
              delay: 5m
              params: 'last(//nas.fs.units[{{#SNMPINDEX}}])*last(//nas.fs.used.blocks[{{#SNMPINDEX}}])'
            - uuid: {u()}
              name: '{{#FSNAME}}: 사용률'
              type: CALCULATED
              key: 'nas.fs.pused[{{#SNMPINDEX}}]'
              value_type: FLOAT
              units: '%'
              delay: 5m
              description: '할당 단위가 약분되므로 블록 수끼리 나눈다.'
              params: '100*last(//nas.fs.used.blocks[{{#SNMPINDEX}}])/last(//nas.fs.total.blocks[{{#SNMPINDEX}}])'
              trigger_prototypes:
                - uuid: {u()}
                  expression: 'min(/{t}/nas.fs.pused[{{#SNMPINDEX}}],10m)>{{$NAS.FS.PUSED.CRIT}}'
                  name: '{{#FSNAME}}: 디스크 사용률 위험 (>{{$NAS.FS.PUSED.CRIT}}%)'
                  priority: AVERAGE
                - uuid: {u()}
                  expression: 'min(/{t}/nas.fs.pused[{{#SNMPINDEX}}],10m)>{{$NAS.FS.PUSED.WARN}}'
                  name: '{{#FSNAME}}: 디스크 사용률 높음 (>{{$NAS.FS.PUSED.WARN}}%)'
                  priority: WARNING
                  dependencies:
                    - name: '{{#FSNAME}}: 디스크 사용률 위험 (>{{$NAS.FS.PUSED.CRIT}}%)'
                      expression: 'min(/{t}/nas.fs.pused[{{#SNMPINDEX}}],10m)>{{$NAS.FS.PUSED.CRIT}}'
"""


def main():
    pw = os.environ.get('ZBX_PASS')
    if not pw:
        raise SystemExit('ZBX_PASS 가 없다. infisical run 으로 주입해서 실행해라.')
    tok = call('user.login',
               {'username': os.environ.get('ZBX_USER', 'Admin'), 'password': pw})

    rules = {k: {'createMissing': True, 'updateExisting': True}
             for k in ('template_groups', 'templates', 'items', 'triggers',
                       'discoveryRules', 'valueMaps')}
    call('configuration.import',
         {'format': 'yaml', 'source': build_yaml(), 'rules': rules}, tok)
    print(f'템플릿 {TEMPLATE_NAME!r} (기술명 {TEMPLATE}) 등록/갱신')

    if NO_LINK:
        print('NO_LINK=1 — 호스트 연결은 건너뜀')
        return

    tid = call('template.get', {'filter': {'host': [TEMPLATE]},
                                'output': ['templateid']}, tok)[0]['templateid']
    for hn in TARGETS:
        hs = call('host.get', {'filter': {'host': [hn]}, 'output': ['hostid', 'name'],
                               'selectParentTemplates': ['templateid', 'name']}, tok)
        if not hs:
            print(f'   {hn}: 호스트 없음 — 건너뜀')
            continue
        h = hs[0]
        if tid in [t['templateid'] for t in h['parentTemplates']]:
            print(f"   {h['name']}: 이미 연결됨")
            continue
        # 기존 연결을 지우지 않도록 전체 목록을 다시 넘긴다
        call('host.update', {
            'hostid': h['hostid'],
            'templates': [{'templateid': t['templateid']} for t in h['parentTemplates']]
                         + [{'templateid': tid}],
        }, tok)
        print(f"   {h['name']}: 연결 완료")

    print('\n발견은 1시간 주기다. 바로 보려면 Zabbix 웹 UI 에서'
          ' 호스트 > 디스커버리 > 파일시스템 발견 > "지금 확인" 을 누르면 된다.')


if __name__ == '__main__':
    main()
