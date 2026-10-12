#!/usr/bin/env python3
"""'IMS 서버 관제' 대시보드에 NPU 페이지를 추가한다 (이미 있으면 갱신).
  python3 npu_dashboard.py [--dry-run]
"""
import json, os, sys, urllib.request

API  = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DASH = os.environ.get('DASHBOARD', 'IMS 서버 관제')
HOST = os.environ.get('NPU_HOST', 'esc8000')
PAGE = 'esc8000 (NPU 8장)'
DRY  = '--dry-run' in sys.argv

def call(m, p, a=None):
    b = {'jsonrpc': '2.0', 'method': m, 'params': p, 'id': 1}
    if a: b['auth'] = a
    r = json.load(urllib.request.urlopen(urllib.request.Request(
        API, method='POST', headers={'Content-Type': 'application/json-rpc'},
        data=json.dumps(b).encode())))
    if 'error' in r: raise SystemExit(f"{m}: {json.dumps(r['error'], ensure_ascii=False)}")
    return r['result']

def F(t, n, v): return {'type': str(t), 'name': n, 'value': str(v)}

def main():
    tok = call('user.login', {'username': os.environ.get('ZBX_USER', 'Admin'),
                              'password': os.environ.get('ZBX_PASS', 'zabbix')})
    d = call('dashboard.get', {'output': ['dashboardid', 'name'], 'selectPages': 'extend',
                               'filter': {'name': [DASH]}}, tok)
    if not d: raise SystemExit(f'대시보드 없음: {DASH}')
    d = d[0]
    h = call('host.get', {'output': ['hostid'], 'filter': {'host': [HOST]}}, tok)
    if not h: raise SystemExit(f'호스트 없음: {HOST}')
    hostid = h[0]['hostid']

    used = {f['value'] for p in d['pages'] for w in p['widgets']
            for f in w['fields'] if f['name'] == 'reference'}
    seq = iter(f'N{n:03d}' for n in range(1, 200))
    def ref():
        while True:
            r = next(seq)
            if r not in used: used.add(r); return r

    def comb(name, x, y, w, hh, item, thresholds):
        f = [F(1, 'hosts.0', HOST), F(1, 'items.0', item),
             F(1, 'primary_label', '{{ITEM.NAME}}'),
             F(1, 'secondary_label', '{{ITEM.LASTVALUE}}'),
             F(0, 'secondary_label_decimal_places', 0), F(1, 'reference', ref())]
        for i, (thr, c) in enumerate(thresholds):
            f += [F(1, f'thresholds.{i}.color', c), F(1, f'thresholds.{i}.threshold', thr)]
        return {'type': 'honeycomb', 'name': name, 'x': str(x), 'y': str(y),
                'width': str(w), 'height': str(hh), 'fields': f}

    def graph(name, x, y, w, hh, series, ymin=None, ymax=None):
        f = [F(1, 'reference', ref())]
        for i, (item, color) in enumerate(series):
            f += [F(1, f'ds.{i}.hosts.0', HOST), F(1, f'ds.{i}.items.0', item),
                  F(1, f'ds.{i}.color', color)]
        if ymin is not None: f.append(F(0, 'lefty_min', ymin))
        if ymax is not None: f.append(F(0, 'lefty_max', ymax))
        return {'type': 'svggraph', 'name': name, 'x': str(x), 'y': str(y),
                'width': str(w), 'height': str(hh), 'fields': f}

    USE = [('0','B2DF8A'), ('40','FFD54F'), ('70','FF8C00'), ('90','FF465C')]
    TMP = [('0','B2DF8A'), ('55','FFD54F'), ('70','FF8C00'), ('85','FF465C')]

    widgets = [
        comb('NPU 사용률 (8장)', 0, 0, 24, 9, 'NPU *: 사용률', USE),
        comb('NPU 온도', 24, 0, 24, 9, 'NPU *: 온도', TMP),
        {'type': 'problems', 'name': '장애', 'x': '48', 'y': '0', 'width': '24', 'height': '9',
         'fields': [F(3, 'hostids.0', hostid), F(0, 'show_tags', 3)]},
        graph('NPU 사용률·온도 추이', 0, 9, 36, 8,
              [('NPU *: 사용률', 'FF465C'), ('NPU *: 온도', 'FF8C00')]),
        graph('NPU 메모리 사용률', 36, 9, 36, 8,
              [('NPU *: 메모리 사용률', '0EC9AC')], 0, 100),
        graph('NPU 소비전력', 0, 17, 36, 7, [('NPU *: 소비전력', 'FFD54F')]),
        graph('CPU / 메모리 / Load', 36, 17, 36, 7,
              [('CPU utilization', 'FF465C'), ('Memory utilization', '0EC9AC'),
               ('Load average (1m avg)', '4DA6FF')]),
        graph('파일시스템 사용률', 0, 24, 72, 7,
              [('FS *: Space: Used, in %', 'A16BFF')], 0, 100),
    ]

    pages = [p for p in d['pages'] if p['name'] != PAGE]
    pages.append({'name': PAGE, 'widgets': widgets})
    print(f"  '{PAGE}' 페이지 위젯 {len(widgets)}개 " + ('(기존 교체)' if len(pages) == len(d['pages']) else '(신규)'))
    if DRY: print('[dry-run] 적용하지 않음'); return
    call('dashboard.update', {'dashboardid': d['dashboardid'], 'pages': pages}, tok)
    print(f"'{DASH}' 갱신 완료 — 총 {len(pages)}장")

if __name__ == '__main__':
    main()
