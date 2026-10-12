#!/usr/bin/env python3
"""'IMS 서버 관제' 대시보드에 GPU 서버 페이지를 추가한다 (같은 이름이면 교체).

기존 서버 페이지와 같은 배치를 쓴다. GPU 가 없으면 GPU 위젯을 빼고 구성한다.
  HOST=h200 python3 server_page.py [--dry-run]
"""
import json, os, sys, urllib.request

API  = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DASH = os.environ.get('DASHBOARD', 'IMS 서버 관제')
HOST = os.environ.get('HOST')
DRY  = '--dry-run' in sys.argv

def call(m, p, a=None):
    b = {'jsonrpc': '2.0', 'method': m, 'params': p, 'id': 1}
    if a: b['auth'] = a
    r = json.load(urllib.request.urlopen(urllib.request.Request(
        API, method='POST', headers={'Content-Type': 'application/json-rpc'},
        data=json.dumps(b).encode())))
    if 'error' in r: raise SystemExit(f"{m}: {json.dumps(r['error'], ensure_ascii=False)}")
    return r['result']

_n = [0]
def F(t, n, v): return {'type': str(t), 'name': n, 'value': str(v)}

def main():
    if not HOST: raise SystemExit('HOST 환경변수가 필요합니다: HOST=h200 python3 server_page.py')
    tok = call('user.login', {'username': os.environ.get('ZBX_USER', 'Admin'),
                              'password': os.environ.get('ZBX_PASS', 'zabbix')})
    h = call('host.get', {'output': ['hostid', 'host'], 'filter': {'host': [HOST]}}, tok)
    if not h: raise SystemExit(f'Zabbix 에 호스트 없음: {HOST}')
    hostid = h[0]['hostid']

    gpus = {i['name'].split(':')[0] for i in
            call('item.get', {'output': ['name'], 'hostids': [hostid],
                              'search': {'name': 'GPU '}, 'startSearch': True}, tok)}
    n_gpu = len(gpus)
    page = f'{HOST} ({n_gpu}G)' if n_gpu else HOST
    print(f"  {HOST}: GPU {n_gpu}장 → 페이지 '{page}'")

    d = call('dashboard.get', {'output': ['dashboardid'], 'selectPages': 'extend',
                               'filter': {'name': [DASH]}}, tok)
    if not d: raise SystemExit(f'대시보드 없음: {DASH}')
    d = d[0]
    used = {f['value'] for p in d['pages'] for w in p['widgets']
            for f in w['fields'] if f['name'] == 'reference'}
    seq = iter(f'S{i:03d}' for i in range(1, 400))
    def ref():
        while True:
            r = next(seq)
            if r not in used: used.add(r); return r

    def comb(name, x, y, w, hh, item, thr):
        f = [F(1, 'hosts.0', HOST), F(1, 'items.0', item),
             F(1, 'primary_label', '{{ITEM.NAME}}'),
             F(1, 'secondary_label', '{{ITEM.LASTVALUE}}'),
             F(0, 'secondary_label_decimal_places', 0), F(1, 'reference', ref())]
        for i, (t, c) in enumerate(thr):
            f += [F(1, f'thresholds.{i}.color', c), F(1, f'thresholds.{i}.threshold', t)]
        return {'type': 'honeycomb', 'name': name, 'x': str(x), 'y': str(y),
                'width': str(w), 'height': str(hh), 'fields': f}

    def graph(name, x, y, w, hh, series, lo=None, hi=None):
        f = [F(1, 'reference', ref())]
        for i, (item, color) in enumerate(series):
            f += [F(1, f'ds.{i}.hosts.0', HOST), F(1, f'ds.{i}.items.0', item),
                  F(1, f'ds.{i}.color', color)]
        if lo is not None: f.append(F(0, 'lefty_min', lo))
        if hi is not None: f.append(F(0, 'lefty_max', hi))
        return {'type': 'svggraph', 'name': name, 'x': str(x), 'y': str(y),
                'width': str(w), 'height': str(hh), 'fields': f}

    USE = [('0','B2DF8A'), ('40','FFD54F'), ('70','FF8C00'), ('90','FF465C')]
    TMP = [('0','B2DF8A'), ('60','FFD54F'), ('75','FF8C00'), ('85','FF465C')]
    prob = {'type': 'problems', 'name': '장애', 'x': '48', 'y': '0', 'width': '24', 'height': '9',
            'fields': [F(3, 'hostids.0', hostid), F(0, 'show_tags', 3)]}

    if n_gpu:
        widgets = [
            comb(f'GPU 사용률 ({n_gpu}장)', 0, 0, 24, 9, 'GPU *: 사용률', USE),
            comb('GPU 온도', 24, 0, 24, 9, 'GPU *: 온도', TMP), prob,
            graph('GPU 사용률·온도 추이', 0, 9, 36, 8,
                  [('GPU *: 사용률', 'FF465C'), ('GPU *: 온도', 'FF8C00')]),
            graph('VRAM 사용률 / 소비전력', 36, 9, 36, 8,
                  [('GPU *: VRAM 사용률', '0EC9AC'), ('GPU *: 소비전력', 'FFD54F')]),
            graph('CPU / 메모리 / Load', 0, 17, 36, 7,
                  [('CPU utilization', 'FF465C'), ('Memory utilization', '0EC9AC'),
                   ('Load average (1m avg)', '4DA6FF')], 0, 100),
            graph('네트워크 트래픽', 36, 17, 36, 7,
                  [('Interface *: Bits received', '4DA6FF'), ('Interface *: Bits sent', 'A16BFF')]),
            graph('파일시스템 사용률', 0, 24, 72, 7,
                  [('FS *: Space: Used, in %', 'A16BFF')], 0, 100),
        ]
    else:
        prob.update({'x': '0', 'width': '36'})
        widgets = [prob,
            graph('CPU / 메모리', 36, 0, 36, 9,
                  [('CPU utilization', 'FF465C'), ('Memory utilization', '0EC9AC')], 0, 100),
            graph('Load average', 0, 9, 36, 8,
                  [('Load average (1m avg)', 'FF465C'), ('Load average (5m avg)', 'FFD54F'),
                   ('Load average (15m avg)', '4DA6FF')]),
            graph('네트워크 트래픽', 36, 9, 36, 8,
                  [('Interface *: Bits received', '4DA6FF'), ('Interface *: Bits sent', 'A16BFF')]),
            graph('파일시스템 사용률', 0, 17, 72, 8,
                  [('FS *: Space: Used, in %', 'A16BFF')], 0, 100),
        ]

    pages = [p for p in d['pages'] if p['name'] != page]
    replaced = len(pages) != len(d['pages'])
    pages.append({'name': page, 'widgets': widgets})
    print(f"  위젯 {len(widgets)}개 {'(기존 페이지 교체)' if replaced else '(신규 페이지)'}")
    if DRY: print('[dry-run] 적용하지 않음'); return
    call('dashboard.update', {'dashboardid': d['dashboardid'], 'pages': pages}, tok)
    print(f"'{DASH}' 갱신 완료 — 총 {len(pages)}장")

if __name__ == '__main__':
    main()
