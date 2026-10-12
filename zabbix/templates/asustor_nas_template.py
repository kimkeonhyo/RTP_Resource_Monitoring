#!/usr/bin/env python3
"""ASUSTOR NAS(nas01)를 전용 MIB 로 관제한다.

nas01 은 ASUSTOR AS7216R(ADM 5.1.4)이고 `.1.3.6.1.4.1.44738` 트리를 209개
항목으로 내준다. 2026-09-07 실측으로 구조를 확인했다.

  .1.1.0  시리얼            .2.1.0  모델 (AS7216R)
  .1.2.0  ADM 버전          .2.3.1.2.N  코어별 사용률 (16코어)
  .2.4.1.2.N  팬 RPM        .2.5.1.{2,3}.1  온도
  .2.6.1.{2,3}.1  메모리 총/여유 (MB)
  .4.1.1.{2..8}.N  디스크 — 이름·모델·타입·상태·SMART·온도·용량
  .5.1.1.{2..7}.N  볼륨   — 이름·RAID·상태·파일시스템·총/여유 (GB)

그전까지 nas01 은 `Linux by SNMP` + hrStorage 우회 템플릿으로만 봤고
**디스크 SMART 와 볼륨 RAID 상태는 아예 사각지대였다.** 디스크가 고장나도
알 수 없었다. 그것이 이 템플릿의 핵심 이유다.

아이템 이름을 'CPU 사용률'·'메모리 사용률'·'VolumeN: 사용률' 로 두는 것이
중요하다 — watch 서버실 화면이 이 이름들을 찾는다.

확정 못 한 것: `.2.5` 테이블의 컬럼 2(60)·3(36)을 각각 CPU·시스템 온도로
보았다. ADM > 서비스 > SNMP 에서 ASUSTOR-SYSTEM-MIB.txt 를 받아 컬럼 이름을
대조하면 확정된다. 값의 크기(60 > 36)로 추정했을 뿐이다.

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/zabbix -- python3 templates/asustor_nas_template.py

템플릿만 만들기:  NO_LINK=1  infisical run ... -- python3 templates/asustor_nas_template.py
다시 만들기:      RECREATE=1 infisical run ... -- python3 templates/asustor_nas_template.py
"""
import hashlib
import json
import os
import urllib.request
import uuid

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
NO_LINK = os.environ.get('NO_LINK') == '1'
RECREATE = os.environ.get('RECREATE') == '1'   # 기존 템플릿을 지우고 새로 만든다

TEMPLATE = 'IMS ASUSTOR NAS by SNMP'
TEMPLATE_NAME = 'IMS ASUSTOR NAS by SNMP'
GROUP = 'Templates/Server hardware'
TARGETS = ['nas01']

B = '1.3.6.1.4.1.44738'


# UUID 는 두 조건을 동시에 만족해야 한다.
#   1) 결정적이어야 한다 — uuid4 로 매번 새로 만들면 재실행 때 Zabbix 가
#      '이름은 같은데 UUID 가 다른 객체' 로 보고 거부한다:
#        Trigger "..." already exists on "..."
#   2) 형식이 v4 여야 한다 — Zabbix 가 버전 비트를 검사한다:
#        Invalid parameter "/1/uuid": UUIDv4 is expected
# 그래서 라벨을 해시해 결정적 값을 얻고, 버전·변이 비트만 v4 로 맞춘다.
def u(label):
    b = bytearray(hashlib.sha1(f'{TEMPLATE}/{label}'.encode()).digest()[:16])
    b[6] = (b[6] & 0x0F) | 0x40   # 버전 4
    b[8] = (b[8] & 0x3F) | 0x80   # RFC 4122 변이
    return uuid.UUID(bytes=bytes(b)).hex


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


def build_yaml():
    t = TEMPLATE
    return f"""zabbix_export:
  version: '7.0'
  template_groups:
    - uuid: {u('group')}
      name: '{GROUP}'
  templates:
    - uuid: {u('template')}
      template: '{t}'
      name: '{TEMPLATE_NAME}'
      description: 'ASUSTOR 전용 MIB(.1.3.6.1.4.1.44738). Linux by SNMP 로는 보이지 않는 디스크 SMART·볼륨 RAID 상태를 읽는다.'
      groups:
        - name: '{GROUP}'
      macros:
        - macro: '{{$NAS.CPU.UTIL.WARN}}'
          value: '90'
          description: '전송 중 높게 유지되는 것이 정상이라 넉넉히 둔다.'
        - macro: '{{$NAS.CPU.TEMP.WARN}}'
          value: '85'
        - macro: '{{$NAS.SYS.TEMP.WARN}}'
          value: '60'
        - macro: '{{$NAS.DISK.TEMP.WARN}}'
          value: '55'
          description: 'HDD 12개가 평소 39~43°C 다(WD 엔터프라이즈, 상한 60°C). 50 이면 여름에 한꺼번에 울린다.'
        - macro: '{{$NAS.VOL.USED.WARN}}'
          value: '80'
        - macro: '{{$NAS.VOL.USED.CRIT}}'
          value: '90'
      items:
        - uuid: {u('item:model')}
          name: '모델'
          type: SNMP_AGENT
          snmp_oid: '{B}.2.1.0'
          key: asustor.model
          value_type: CHAR
          delay: 6h
        - uuid: {u('item:adm')}
          name: 'ADM 버전'
          type: SNMP_AGENT
          snmp_oid: '{B}.1.2.0'
          key: asustor.adm.version
          value_type: CHAR
          delay: 6h
        - uuid: {u('item:serial')}
          name: '시리얼 번호'
          type: SNMP_AGENT
          snmp_oid: '{B}.1.1.0'
          key: asustor.serial
          value_type: CHAR
          delay: 6h
        - uuid: {u('item:cpu.temp')}
          name: 'CPU 온도'
          type: SNMP_AGENT
          snmp_oid: '{B}.2.5.1.2.1'
          key: asustor.cpu.temp
          units: °C
          delay: 2m
          description: '.2.5 테이블 컬럼 2. 값 크기로 CPU 라고 추정했다 — MIB 파일로 확정 필요.'
          triggers:
            - uuid: {u('trig:cpu.temp')}
              expression: 'min(/{t}/asustor.cpu.temp,5m)>{{$NAS.CPU.TEMP.WARN}}'
              name: 'CPU 온도 높음 (>{{$NAS.CPU.TEMP.WARN}}°C)'
              priority: AVERAGE
        - uuid: {u('item:sys.temp')}
          name: '시스템 온도'
          type: SNMP_AGENT
          snmp_oid: '{B}.2.5.1.3.1'
          key: asustor.sys.temp
          units: °C
          delay: 2m
          description: '.2.5 테이블 컬럼 3.'
          triggers:
            - uuid: {u('trig:sys.temp')}
              expression: 'min(/{t}/asustor.sys.temp,5m)>{{$NAS.SYS.TEMP.WARN}}'
              name: '시스템 온도 높음 (>{{$NAS.SYS.TEMP.WARN}}°C)'
              priority: WARNING
        - uuid: {u('item:mem.total')}
          name: '메모리 총량'
          type: SNMP_AGENT
          snmp_oid: '{B}.2.6.1.2.1'
          key: asustor.mem.total
          units: B
          delay: 1h
          preprocessing:
            - type: MULTIPLIER
              parameters:
                - '1048576'
        - uuid: {u('item:mem.free')}
          name: '메모리 여유'
          type: SNMP_AGENT
          snmp_oid: '{B}.2.6.1.3.1'
          key: asustor.mem.free
          units: B
          delay: 2m
          preprocessing:
            - type: MULTIPLIER
              parameters:
                - '1048576'
        - uuid: {u('item:mem.util')}
          name: '메모리 사용률'
          type: CALCULATED
          key: asustor.mem.util
          value_type: FLOAT
          units: '%'
          delay: 2m
          description: 'ASUSTOR 의 여유 메모리는 캐시를 사용으로 계산한다. Linux by SNMP 의 Memory utilization 과 값이 다른 것이 정상이다.'
          params: '100*(last(//asustor.mem.total)-last(//asustor.mem.free))/last(//asustor.mem.total)'
        - uuid: {u('item:cpu.util')}
          name: 'CPU 사용률'
          type: CALCULATED
          key: asustor.cpu.util
          value_type: FLOAT
          units: '%'
          delay: 2m
          description: '코어별 부하의 평균. 이름을 이렇게 둔 이유는 watch 서버실 화면이 이 이름을 찾기 때문이다.\n            계산식의 호스트 부분은 비워야 한다(//key) — params 는 상속 시 치환되지 않고 그대로 복사되므로,\n            템플릿 이름을 쓰면 그런 호스트가 없어 평가에 실패한다.'
          params: 'avg(last_foreach(//asustor.cpu.core[*]))'
          triggers:
            - uuid: {u('trig:cpu.util')}
              expression: 'min(/{t}/asustor.cpu.util,5m)>{{$NAS.CPU.UTIL.WARN}}'
              name: 'CPU 사용률 높음 (>{{$NAS.CPU.UTIL.WARN}}%)'
              priority: WARNING
        - uuid: {u('item:cpu.cores')}
          name: 'CPU 코어 수'
          type: CALCULATED
          key: asustor.cpu.cores
          value_type: UNSIGNED
          delay: 1h
          params: 'count(last_foreach(//asustor.cpu.core[*]))'
      discovery_rules:
        - uuid: {u('lld:cpu')}
          name: 'CPU 코어 발견'
          type: SNMP_AGENT
          snmp_oid: 'discovery[{{#COREID}},{B}.2.3.1.1]'
          key: asustor.cpu.discovery
          delay: 6h
          item_prototypes:
            - uuid: {u('proto:cpu.core')}
              name: 'CPU 코어 {{#COREID}}: 부하'
              type: SNMP_AGENT
              snmp_oid: '{B}.2.3.1.2.{{#SNMPINDEX}}'
              key: 'asustor.cpu.core[{{#SNMPINDEX}}]'
              value_type: FLOAT
              units: '%'
              delay: 2m
              history: '1d'
              trends: '0'
              description: '평균 계산용. 코어별 그래프는 필요 없어 이력만 짧게 남긴다.'
        - uuid: {u('lld:fan')}
          name: '팬 발견'
          type: SNMP_AGENT
          snmp_oid: 'discovery[{{#FANID}},{B}.2.4.1.1]'
          key: asustor.fan.discovery
          delay: 6h
          item_prototypes:
            - uuid: {u('proto:fan.rpm')}
              name: '팬 {{#FANID}}: 회전수'
              type: SNMP_AGENT
              snmp_oid: '{B}.2.4.1.2.{{#SNMPINDEX}}'
              key: 'asustor.fan.rpm[{{#SNMPINDEX}}]'
              units: rpm
              delay: 2m
              trigger_prototypes:
                - uuid: {u('trig:fan.stop')}
                  expression: 'max(/{t}/asustor.fan.rpm[{{#SNMPINDEX}}],5m)=0'
                  name: '팬 {{#FANID}}: 정지'
                  priority: HIGH
        - uuid: {u('lld:disk')}
          name: '디스크 발견'
          type: SNMP_AGENT
          snmp_oid: 'discovery[{{#DISKNAME}},{B}.4.1.1.2]'
          key: asustor.disk.discovery
          delay: 1h
          item_prototypes:
            - uuid: {u('proto:disk.model')}
              name: '{{#DISKNAME}}: 모델'
              type: SNMP_AGENT
              snmp_oid: '{B}.4.1.1.3.{{#SNMPINDEX}}'
              key: 'asustor.disk.model[{{#SNMPINDEX}}]'
              value_type: CHAR
              delay: 6h
            - uuid: {u('proto:disk.status')}
              name: '{{#DISKNAME}}: 상태'
              type: SNMP_AGENT
              snmp_oid: '{B}.4.1.1.5.{{#SNMPINDEX}}'
              key: 'asustor.disk.status[{{#SNMPINDEX}}]'
              value_type: CHAR
              delay: 5m
              trigger_prototypes:
                - uuid: {u('trig:disk.status')}
                  expression: 'last(/{t}/asustor.disk.status[{{#SNMPINDEX}}])<>"Good"'
                  name: '{{#DISKNAME}}: 디스크 상태 이상'
                  priority: HIGH
            - uuid: {u('proto:disk.smart')}
              name: '{{#DISKNAME}}: S.M.A.R.T'
              type: SNMP_AGENT
              snmp_oid: '{B}.4.1.1.6.{{#SNMPINDEX}}'
              key: 'asustor.disk.smart[{{#SNMPINDEX}}]'
              value_type: CHAR
              delay: 5m
              trigger_prototypes:
                - uuid: {u('trig:disk.smart')}
                  expression: 'length(last(/{t}/asustor.disk.smart[{{#SNMPINDEX}}]))>0 and last(/{t}/asustor.disk.smart[{{#SNMPINDEX}}])<>"Healthy"'
                  name: '{{#DISKNAME}}: S.M.A.R.T 이상'
                  priority: HIGH
            - uuid: {u('proto:disk.temp')}
              name: '{{#DISKNAME}}: 온도'
              type: SNMP_AGENT
              snmp_oid: '{B}.4.1.1.7.{{#SNMPINDEX}}'
              key: 'asustor.disk.temp[{{#SNMPINDEX}}]'
              units: °C
              delay: 2m
              trigger_prototypes:
                - uuid: {u('trig:disk.temp')}
                  expression: 'min(/{t}/asustor.disk.temp[{{#SNMPINDEX}}],5m)>{{$NAS.DISK.TEMP.WARN}}'
                  name: '{{#DISKNAME}}: 디스크 온도 높음 (>{{$NAS.DISK.TEMP.WARN}}°C)'
                  priority: WARNING
            - uuid: {u('proto:disk.size')}
              name: '{{#DISKNAME}}: 용량'
              type: SNMP_AGENT
              snmp_oid: '{B}.4.1.1.8.{{#SNMPINDEX}}'
              key: 'asustor.disk.size[{{#SNMPINDEX}}]'
              units: B
              delay: 6h
              preprocessing:
                - type: MULTIPLIER
                  parameters:
                    - '1073741824'
        - uuid: {u('lld:vol')}
          name: '볼륨 발견'
          type: SNMP_AGENT
          snmp_oid: 'discovery[{{#VOLNAME}},{B}.5.1.1.2]'
          key: asustor.vol.discovery
          delay: 1h
          item_prototypes:
            - uuid: {u('proto:vol.raid')}
              name: '{{#VOLNAME}}: RAID'
              type: SNMP_AGENT
              snmp_oid: '{B}.5.1.1.3.{{#SNMPINDEX}}'
              key: 'asustor.vol.raid[{{#SNMPINDEX}}]'
              value_type: CHAR
              delay: 6h
            - uuid: {u('proto:vol.status')}
              name: '{{#VOLNAME}}: 상태'
              type: SNMP_AGENT
              snmp_oid: '{B}.5.1.1.4.{{#SNMPINDEX}}'
              key: 'asustor.vol.status[{{#SNMPINDEX}}]'
              value_type: CHAR
              delay: 5m
              trigger_prototypes:
                - uuid: {u('trig:vol.status')}
                  expression: 'last(/{t}/asustor.vol.status[{{#SNMPINDEX}}])<>"healthy"'
                  name: '{{#VOLNAME}}: 볼륨 이상'
                  priority: DISASTER
            - uuid: {u('proto:vol.fs')}
              name: '{{#VOLNAME}}: 파일시스템'
              type: SNMP_AGENT
              snmp_oid: '{B}.5.1.1.5.{{#SNMPINDEX}}'
              key: 'asustor.vol.fs[{{#SNMPINDEX}}]'
              value_type: CHAR
              delay: 6h
            - uuid: {u('proto:vol.total')}
              name: '{{#VOLNAME}}: 전체 용량'
              type: SNMP_AGENT
              snmp_oid: '{B}.5.1.1.6.{{#SNMPINDEX}}'
              key: 'asustor.vol.total[{{#SNMPINDEX}}]'
              units: B
              delay: 1h
              preprocessing:
                - type: MULTIPLIER
                  parameters:
                    - '1073741824'
            - uuid: {u('proto:vol.free')}
              name: '{{#VOLNAME}}: 여유 용량'
              type: SNMP_AGENT
              snmp_oid: '{B}.5.1.1.7.{{#SNMPINDEX}}'
              key: 'asustor.vol.free[{{#SNMPINDEX}}]'
              units: B
              delay: 5m
              preprocessing:
                - type: MULTIPLIER
                  parameters:
                    - '1073741824'
            - uuid: {u('proto:vol.pused')}
              name: '{{#VOLNAME}}: 사용률'
              type: CALCULATED
              key: 'asustor.vol.pused[{{#SNMPINDEX}}]'
              value_type: FLOAT
              units: '%'
              delay: 5m
              params: '100*(last(//asustor.vol.total[{{#SNMPINDEX}}])-last(//asustor.vol.free[{{#SNMPINDEX}}]))/last(//asustor.vol.total[{{#SNMPINDEX}}])'
              trigger_prototypes:
                - uuid: {u('trig:vol.crit')}
                  expression: 'min(/{t}/asustor.vol.pused[{{#SNMPINDEX}}],10m)>{{$NAS.VOL.USED.CRIT}}'
                  name: '{{#VOLNAME}}: 사용률 위험 (>{{$NAS.VOL.USED.CRIT}}%)'
                  priority: AVERAGE
                - uuid: {u('trig:vol.warn')}
                  expression: 'min(/{t}/asustor.vol.pused[{{#SNMPINDEX}}],10m)>{{$NAS.VOL.USED.WARN}}'
                  name: '{{#VOLNAME}}: 사용률 높음 (>{{$NAS.VOL.USED.WARN}}%)'
                  priority: WARNING
                  dependencies:
                    - name: '{{#VOLNAME}}: 사용률 위험 (>{{$NAS.VOL.USED.CRIT}}%)'
                      expression: 'min(/{t}/asustor.vol.pused[{{#SNMPINDEX}}],10m)>{{$NAS.VOL.USED.CRIT}}'
"""


def main():
    pw = os.environ.get('ZBX_PASS')
    if not pw:
        raise SystemExit('ZBX_PASS 가 없다. infisical run 으로 주입해서 실행해라.')
    tok = call('user.login',
               {'username': os.environ.get('ZBX_USER', 'Admin'), 'password': pw})

    if RECREATE:
        old = call('template.get', {'filter': {'host': [TEMPLATE]},
                                    'output': ['templateid']}, tok)
        if old:
            call('template.delete', [old[0]['templateid']], tok)
            print(f'기존 {TEMPLATE!r} 삭제 (UUID 를 결정적으로 바꾸느라 한 번 필요하다)')

    rules = {k: {'createMissing': True, 'updateExisting': True}
             for k in ('template_groups', 'templates', 'items', 'triggers',
                       'discoveryRules', 'valueMaps')}
    call('configuration.import',
         {'format': 'yaml', 'source': build_yaml(), 'rules': rules}, tok)
    print(f'템플릿 {TEMPLATE!r} 등록/갱신')

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
        if tid in [x['templateid'] for x in h['parentTemplates']]:
            print(f"   {h['name']}: 이미 연결됨")
            continue
        call('host.update', {
            'hostid': h['hostid'],
            'templates': [{'templateid': x['templateid']} for x in h['parentTemplates']]
                         + [{'templateid': tid}],
        }, tok)
        print(f"   {h['name']}: 연결 완료")

    print('\n발견 주기는 CPU·팬 6시간, 디스크·볼륨 1시간이다.'
          ' 즉시 보려면 hosts/nas_discovery_now.py 를 돌려라.')


if __name__ == '__main__':
    main()
