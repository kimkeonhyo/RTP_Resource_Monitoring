#!/usr/bin/env python3
"""BMC(IPMI) 온도·팬 위젯을 'IMS 서버 관제' 대시보드에 추가한다.

기존 위젯 아래(빈 행)에 붙이므로 배치를 건드리지 않는다. 이미 있으면 건너뛴다.
  python3 bmc_widgets.py [--dry-run]
"""
import json, os, sys, urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DRY = '--dry-run' in sys.argv
DASH = 'IMS 서버 관제'

# 페이지 이름 → BMC 호스트. BMC 가 없는 서버(ai-gpu02, inf-gpu02, dev-media01)는 넣지 않는다.
PAGE_BMC = {
    'dev-gpu01 (4G)': 'dev-gpu01-bmc',  'dev-gpu02 (4G)': 'dev-gpu02-bmc',
    'dev-gpu03 (4G)': 'dev-gpu03-bmc',  'dev-gpu04 (3G)': 'dev-gpu04-bmc',
    'ai-gpu04 (4G)':  'ai-gpu04-bmc',   'inf-gpu01 (4G)': 'inf-gpu01-bmc',
    'WS (07) (2G)':  'ws-07-bmc',     'dev-storage01':  'dev-storage01-bmc',
}
# DIMM 은 'Temp' 라 'Temperature' 패턴에서 빠진다 — CPU/PCH/TR 만 남아 읽을 만하다
TEMP, FAN = '*Temperature*', '*RPM*'

def call(m, p, a=None):
    b = {'jsonrpc': '2.0', 'method': m, 'params': p, 'id': 1}
    if a: b['auth'] = a
    r = json.load(urllib.request.urlopen(urllib.request.Request(
        API, method='POST', headers={'Content-Type': 'application/json-rpc'},
        data=json.dumps(b).encode())))
    if 'error' in r: raise SystemExit(f"{m}: {json.dumps(r['error'], ensure_ascii=False)}")
    return r['result']

def graph(name, x, y, w, h, ref, series):
    """series: [(호스트패턴, 아이템패턴, 색)] — 기존 위젯과 같은 필드 구조를 쓴다"""
    f = [{'type': '1', 'name': 'reference', 'value': ref}]
    for i, (host, item, color) in enumerate(series):
        f += [{'type': '1', 'name': f'ds.{i}.hosts.0', 'value': host},
              {'type': '1', 'name': f'ds.{i}.items.0', 'value': item},
              {'type': '1', 'name': f'ds.{i}.color',   'value': color}]
    return {'type': 'svggraph', 'name': name, 'x': str(x), 'y': str(y),
            'width': str(w), 'height': str(h), 'fields': f}

def main():
    tok = call('user.login', {'username': os.environ.get('ZBX_USER', 'Admin'),
                              'password': os.environ.get('ZBX_PASS', 'zabbix')})
    d = call('dashboard.get', {'output': ['dashboardid', 'name'], 'selectPages': 'extend',
                               'filter': {'name': [DASH]}}, tok)
    if not d: raise SystemExit(f'대시보드 없음: {DASH}')
    d = d[0]

    used = {f['value'] for p in d['pages'] for w in p['widgets']
            for f in w['fields'] if f['name'] == 'reference'}
    seq = iter(f'B{n:03d}' for n in range(1, 400))
    def ref():
        while True:
            r = next(seq)
            if r not in used: used.add(r); return r

    changed = 0
    for page in d['pages']:
        adds = []
        if page['name'] in PAGE_BMC:
            bmc = PAGE_BMC[page['name']]
            adds = [('하드웨어 온도 (BMC)', [(bmc, TEMP, 'FF465C')]),
                    ('팬 RPM (BMC)',        [(bmc, FAN,  '0EC9AC')])]
        elif page['name'] == '서버 공통':
            adds = [('CPU 온도 — 전 서버 (BMC)', [('*-bmc', 'CPU? Temperature*', 'FF465C')])]
        if not adds: continue

        have = {w.get('name') for w in page['widgets']}
        adds = [a for a in adds if a[0] not in have]
        if not adds:
            print(f"  {page['name']:20} 이미 있음"); continue

        y = max((int(w['y']) + int(w['height']) for w in page['widgets']), default=0)
        for i, (name, series) in enumerate(adds):
            w = 36 if len(adds) > 1 else 72
            page['widgets'].append(graph(name, i * 36 if len(adds) > 1 else 0, y, w, 7, ref(), series))
        changed += len(adds)
        print(f"  {page['name']:20} y={y} 에 {len(adds)}개 추가")

    if not changed:
        print('추가할 위젯 없음'); return
    if DRY:
        print(f'[dry-run] 총 {changed}개 추가 예정'); return
    call('dashboard.update', {'dashboardid': d['dashboardid'], 'pages': d['pages']}, tok)
    print(f'총 {changed}개 위젯 추가 완료')

if __name__ == '__main__':
    main()
