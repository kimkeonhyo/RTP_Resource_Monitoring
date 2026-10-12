#!/usr/bin/env python3
"""'IMS 서버 관제' 대시보드와 '서버 공통' 페이지를 만든다.
서버별 페이지는 수집이 시작된 뒤 server_page.py 로 붙인다 (GPU 개수를 알아야 한다).
"""
import json, os, sys, urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
NAME = 'IMS 서버 관제'
GROUP = 'IMS 서버·워크스테이션'

def call(m, p, a=None):
    b = {'jsonrpc': '2.0', 'method': m, 'params': p, 'id': 1}
    if a: b['auth'] = a
    r = json.load(urllib.request.urlopen(urllib.request.Request(
        API, method='POST', headers={'Content-Type': 'application/json-rpc'},
        data=json.dumps(b).encode()), timeout=60))
    if 'error' in r: raise SystemExit(f"{m}: {json.dumps(r['error'], ensure_ascii=False)}")
    return r['result']

def F(t, n, v): return {'type': str(t), 'name': n, 'value': str(v)}

def main():
    tok = call('user.login', {'username': os.environ.get('ZBX_USER', 'Admin'),
                              'password': os.environ['ZBX_PASS']})
    if call('dashboard.get', {'output': ['dashboardid'], 'filter': {'name': [NAME]}}, tok):
        print(f"'{NAME}' 이미 있음"); return
    g = call('hostgroup.get', {'output': ['groupid'], 'filter': {'name': [GROUP]}}, tok)
    if not g: raise SystemExit(f'그룹 없음: {GROUP}')
    gid = g[0]['groupid']
    n = [0]
    def ref():
        n[0] += 1; return f'C{n[0]:03d}'
    def comb(name, x, y, w, h, item, thr):
        f = [F(2, 'groupids.0', gid), F(1, 'items.0', item),
             F(1, 'primary_label', '{{HOST.NAME}}'), F(1, 'secondary_label', '{{ITEM.LASTVALUE}}'),
             F(0, 'secondary_label_decimal_places', 0), F(1, 'reference', ref())]
        for i, (t, c) in enumerate(thr):
            f += [F(1, f'thresholds.{i}.color', c), F(1, f'thresholds.{i}.threshold', t)]
        return {'type': 'honeycomb', 'name': name, 'x': str(x), 'y': str(y),
                'width': str(w), 'height': str(h), 'fields': f}
    def graph(name, x, y, w, h, item, color, lo=None, hi=None):
        f = [F(1, 'reference', ref()), F(1, 'ds.0.hosts.0', '*'),
             F(1, 'ds.0.items.0', item), F(1, 'ds.0.color', color)]
        if lo is not None: f.append(F(0, 'lefty_min', lo))
        if hi is not None: f.append(F(0, 'lefty_max', hi))
        return {'type': 'svggraph', 'name': name, 'x': str(x), 'y': str(y),
                'width': str(w), 'height': str(h), 'fields': f}
    USE = [('0','B2DF8A'),('40','FFD54F'),('70','FF8C00'),('90','FF465C')]
    TMP = [('0','B2DF8A'),('60','FFD54F'),('75','FF8C00'),('85','FF465C')]
    page = {'name': '서버 공통', 'widgets': [
        comb('GPU 사용률 — 전체', 0, 0, 24, 9, 'GPU *: 사용률', USE),
        comb('GPU 온도', 24, 0, 24, 9, 'GPU *: 온도', TMP),
        {'type': 'problems', 'name': '현재 장애', 'x': '48', 'y': '0', 'width': '24', 'height': '9',
         'fields': [F(2, 'groupids.0', gid), F(0, 'show_tags', 3)]},
        graph('서버 CPU', 0, 9, 36, 8, 'CPU utilization', 'FF465C', 0, 100),
        graph('서버 메모리', 36, 9, 36, 8, 'Memory utilization', '0EC9AC', 0, 100),
        graph('GPU 온도 추이', 0, 17, 36, 8, 'GPU *: 온도', 'FF8C00'),
        graph('네트워크 수신', 36, 17, 36, 8, 'Interface *: Bits received', '4DA6FF'),
        graph('루트 파일시스템 사용률', 0, 25, 72, 7, 'FS [/]: Space: Used, in %', 'A16BFF', 0, 100),
    ]}
    call('dashboard.create', {'name': NAME, 'display_period': 30, 'auto_start': 1,
                              'pages': [page], 'userGroups': [], 'users': []}, tok)
    print(f"'{NAME}' 생성 — '서버 공통' 페이지 위젯 {len(page['widgets'])}개")

if __name__ == '__main__':
    main()
