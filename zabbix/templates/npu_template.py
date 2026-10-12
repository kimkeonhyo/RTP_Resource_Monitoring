#!/usr/bin/env python3
"""IMS Mobilint NPU 템플릿 생성.

npu.stats 가 전체를 JSON 으로 한 번에 내고, 종속 아이템이 JSONPath 로 쪼갠다.
장치당 항목마다 폴링하면 분당 수십 번이 되므로 이 구조를 쓴다.
  python3 npu_template.py [--dry-run]
"""
import json, os, sys, urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
NAME = 'IMS Mobilint NPU by Zabbix agent'
GROUP = 'Templates/Applications'
DRY = '--dry-run' in sys.argv

def call(m, p, a=None):
    b = {'jsonrpc': '2.0', 'method': m, 'params': p, 'id': 1}
    if a: b['auth'] = a
    r = json.load(urllib.request.urlopen(urllib.request.Request(
        API, method='POST', headers={'Content-Type': 'application/json-rpc'},
        data=json.dumps(b).encode())))
    if 'error' in r: raise SystemExit(f"{m}: {json.dumps(r['error'], ensure_ascii=False)}")
    return r['result']

# (이름, JSON 키, 단위, 소수점 유형)   value_type 0=float
PROTOS = [
    ('NPU {#NPUID}: 온도',        'Temperature',       'C',  0),
    ('NPU {#NPUID}: 사용률',      'Utilization.Total', '%',  0),
    ('NPU {#NPUID}: 메모리 사용',  'Memory.Usage',      'MB', 0),
    ('NPU {#NPUID}: 메모리 전체',  'Memory.Total',      'MB', 0),
    ('NPU {#NPUID}: 소비전력',    'Power.Total',       'W',  0),
]

def main():
    tok = call('user.login', {'username': os.environ.get('ZBX_USER', 'Admin'),
                              'password': os.environ.get('ZBX_PASS', 'zabbix')})
    if call('template.get', {'output': ['templateid'], 'filter': {'host': [NAME]}}, tok):
        print(f"템플릿 '{NAME}' 이미 있음 — 지우고 다시 만들려면 UI 에서 삭제 후 실행하세요"); return
    g = call('templategroup.get', {'output': ['groupid'], 'filter': {'name': [GROUP]}}, tok)
    if not g: g = [{'groupid': call('templategroup.create', {'name': GROUP}, tok)['groupids'][0]}]
    if DRY:
        print(f"생성 예정: {NAME} / 마스터 1 + LLD 1 + 프로토타입 {len(PROTOS)+1} + 트리거 1"); return

    tid = call('template.create', {'host': NAME, 'name': NAME,
                                   'groups': [{'groupid': g[0]['groupid']}]}, tok)['templateids'][0]
    call('usermacro.create', {'hostid': tid, 'macro': '{$NPU.TEMP.MAX}', 'value': '85'}, tok)

    master = call('item.create', {
        'hostid': tid, 'name': 'NPU 원시 데이터', 'key_': 'npu.stats',
        'type': 0, 'value_type': 4, 'delay': '1m',
        'description': 'mblt-status 전체를 JSON 으로 받는다. 아래 아이템들이 이걸 쪼갠다.',
    }, tok)['itemids'][0]

    rule = call('discoveryrule.create', {
        'hostid': tid, 'name': 'NPU 발견', 'key_': 'npu.discovery',
        'type': 0, 'delay': '1h',
        'filter': {'evaltype': 0, 'conditions': [
            {'macro': '{#NPUID}', 'value': '^[0-9]+$', 'operator': 8}]},
    }, tok)['itemids'][0]

    for name, key, unit, vt in PROTOS:
        call('itemprototype.create', {
            'hostid': tid, 'ruleid': rule, 'name': name,
            'key_': f"npu.{key.lower().replace('.', '_')}[{{#NPUID}}]",
            'type': 18, 'value_type': vt, 'units': unit, 'master_itemid': master,
            'preprocessing': [
                {'type': 12, 'params': f"$['{{#NPUID}}']['{key}']", 'error_handler': 1},
            ],
        }, tok)

    call('itemprototype.create', {
        'hostid': tid, 'ruleid': rule, 'name': 'NPU {#NPUID}: 메모리 사용률',
        'key_': 'npu.mem_util[{#NPUID}]', 'type': 15, 'value_type': 0, 'units': '%',
        'delay': '1m',
        'params': '100*last(//npu.memory_usage[{#NPUID}])/last(//npu.memory_total[{#NPUID}])',
    }, tok)

    call('triggerprototype.create', {
        'description': 'NPU {#NPUID}: 온도 높음 (>{$NPU.TEMP.MAX}C)',
        'expression': f'last(/{NAME}/npu.temperature[{{#NPUID}}])>{{$NPU.TEMP.MAX}}',
        'priority': 4,
    }, tok)
    print(f"템플릿 '{NAME}' 생성 완료 (아이템 프로토타입 {len(PROTOS)+1}개, 트리거 1개)")

if __name__ == '__main__':
    main()
