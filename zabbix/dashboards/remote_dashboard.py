#!/usr/bin/env python3
"""고객사 사이트 대시보드(Remote_server) 생성.

개요 1장 + 사이트별 1장씩. 사이트 목록은 'IMS 고객사' 그룹에서 읽으므로
사이트가 늘거나 줄면 다시 실행하면 된다 (같은 이름이면 갱신).
  python3 remote_dashboard.py [--dry-run]
"""
import json, os, sys, urllib.request

API   = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
GROUP = os.environ.get('GROUP', 'IMS 고객사')
NAME  = os.environ.get('DASHBOARD', 'Remote_server')
DRY   = '--dry-run' in sys.argv

def call(m, p, a=None):
    b = {'jsonrpc': '2.0', 'method': m, 'params': p, 'id': 1}
    if a: b['auth'] = a
    r = json.load(urllib.request.urlopen(urllib.request.Request(
        API, method='POST', headers={'Content-Type': 'application/json-rpc'},
        data=json.dumps(b).encode())))
    if 'error' in r: raise SystemExit(f"{m}: {json.dumps(r['error'], ensure_ascii=False)}")
    return r['result']

_n = [0]
def ref():
    _n[0] += 1
    return f'R{_n[0]:03d}'

def F(t, n, v):  return {'type': str(t), 'name': n, 'value': str(v)}

def graph(name, x, y, w, h, series, y_min=None, y_max=None):
    """series: [(호스트패턴들, 아이템패턴, 색)] — 기존 대시보드와 같은 필드 구조"""
    f = [F(1, 'reference', ref())]
    for i, (hosts, item, color) in enumerate(series):
        for j, hp in enumerate(hosts):
            f.append(F(1, f'ds.{i}.hosts.{j}', hp))
        f += [F(1, f'ds.{i}.items.0', item), F(1, f'ds.{i}.color', color)]
    if y_min is not None: f += [F(0, 'lefty_min', y_min)]
    if y_max is not None: f += [F(0, 'lefty_max', y_max)]
    return {'type': 'svggraph', 'name': name, 'x': str(x), 'y': str(y),
            'width': str(w), 'height': str(h), 'fields': f}

def comb(name, x, y, w, h, item, scope, thresholds):
    """scope: ('group', groupid) 또는 ('host', 호스트명)"""
    f = [F(1, 'items.0', item),
         F(1, 'primary_label', '{{HOST.NAME}}'),
         F(1, 'secondary_label', '{{ITEM.LASTVALUE}}'),
         F(0, 'secondary_label_decimal_places', 0),
         F(1, 'reference', ref())]
    f.insert(0, F(2, 'groupids.0', scope[1]) if scope[0] == 'group' else F(1, 'hosts.0', scope[1]))
    for i, (thr, color) in enumerate(thresholds):
        f += [F(1, f'thresholds.{i}.color', color), F(1, f'thresholds.{i}.threshold', thr)]
    return {'type': 'honeycomb', 'name': name, 'x': str(x), 'y': str(y),
            'width': str(w), 'height': str(h), 'fields': f}

def problems(name, x, y, w, h, scope):
    f = [F(2, 'groupids.0', scope[1]) if scope[0] == 'group' else F(3, 'hostids.0', scope[1]),
         F(0, 'show_tags', 3)]
    return {'type': 'problems', 'name': name, 'x': str(x), 'y': str(y),
            'width': str(w), 'height': str(h), 'fields': f}

USE = [('0', 'B2DF8A'), ('40', 'FFD54F'), ('70', 'FF8C00'), ('90', 'FF465C')]   # 사용률
TMP = [('0', 'B2DF8A'), ('60', 'FFD54F'), ('75', 'FF8C00'), ('85', 'FF465C')]   # 온도

def main():
    tok = call('user.login', {'username': os.environ.get('ZBX_USER', 'Admin'),
                              'password': os.environ.get('ZBX_PASS', 'zabbix')})
    g = call('hostgroup.get', {'output': ['groupid'], 'filter': {'name': [GROUP]}}, tok)
    if not g: raise SystemExit(f'그룹 없음: {GROUP}')
    gid = g[0]['groupid']
    hosts = sorted(call('host.get', {'output': ['hostid', 'host'], 'groupids': [gid]}, tok),
                   key=lambda h: h['host'])
    if not hosts: raise SystemExit(f'{GROUP} 그룹에 호스트가 없습니다')
    names = [h['host'] for h in hosts]
    print(f"사이트 {len(names)}곳: {', '.join(names)}")

    pages = [{'name': '전체 개요', 'widgets': [
        comb('GPU 사용률', 0, 0, 24, 9, 'GPU *: 사용률', ('group', gid), USE),
        comb('GPU 온도', 24, 0, 24, 9, 'GPU *: 온도', ('group', gid), TMP),
        problems('현재 장애', 48, 0, 24, 9, ('group', gid)),
        graph('CPU 사용률', 0, 9, 36, 8, [(names, 'CPU utilization', 'FF465C')], 0, 100),
        graph('메모리 사용률', 36, 9, 36, 8, [(names, 'Memory utilization', '0EC9AC')], 0, 100),
        graph('GPU 온도 추이', 0, 17, 36, 8, [(names, 'GPU *: 온도', 'FF8C00')]),
        graph('네트워크 수신', 36, 17, 36, 8, [(names, 'Interface *: Bits received', '4DA6FF')]),
        graph('루트 파일시스템 사용률', 0, 25, 72, 7,
              [(names, 'FS [/]: Space: Used, in %', 'A16BFF')], 0, 100),
    ]}]

    # 사이트마다 GPU 유무가 다르다 — site-d 은 컨트롤 노드라 GPU 가 없고,
    # 빈 위젯을 두면 화면만 차지한다. 실제 아이템 유무로 페이지 구성을 나눈다.
    has_gpu = {}
    for h in hosts:
        gi = call('item.get', {'output': ['itemid'], 'hostids': [h['hostid']],
                               'search': {'name': 'GPU '}, 'startSearch': True, 'limit': 1}, tok)
        has_gpu[h['host']] = bool(gi)
    print('  GPU 있음: ' + ', '.join(n for n, v in has_gpu.items() if v))
    print('  GPU 없음: ' + (', '.join(n for n, v in has_gpu.items() if not v) or '없음'))

    for h in hosts:
        n = h['host']
        if not has_gpu[n]:
            pages.append({'name': n, 'widgets': [
                problems('장애', 0, 0, 36, 9, ('host', h['hostid'])),
                graph('CPU / 메모리', 36, 0, 36, 9,
                      [([n], 'CPU utilization', 'FF465C'), ([n], 'Memory utilization', '0EC9AC')], 0, 100),
                graph('Load average', 0, 9, 36, 8,
                      [([n], 'Load average (1m avg)', 'FF465C'),
                       ([n], 'Load average (5m avg)', 'FFD54F'),
                       ([n], 'Load average (15m avg)', '4DA6FF')]),
                graph('네트워크 트래픽', 36, 9, 36, 8,
                      [([n], 'Interface *: Bits received', '4DA6FF'),
                       ([n], 'Interface *: Bits sent', 'A16BFF')]),
                graph('파일시스템 사용률', 0, 17, 72, 8,
                      [([n], 'FS *: Space: Used, in %', 'A16BFF')], 0, 100),
            ]})
            continue
        pages.append({'name': n, 'widgets': [
            comb('GPU 사용률', 0, 0, 24, 9, 'GPU *: 사용률', ('host', n), USE),
            comb('GPU 온도', 24, 0, 24, 9, 'GPU *: 온도', ('host', n), TMP),
            problems('장애', 48, 0, 24, 9, ('host', h['hostid'])),
            graph('GPU 사용률·온도', 0, 9, 36, 8,
                  [([n], 'GPU *: 사용률', 'FF465C'), ([n], 'GPU *: 온도', 'FF8C00')]),
            graph('GPU VRAM 사용률 / 소비전력', 36, 9, 36, 8,
                  [([n], 'GPU *: VRAM 사용률', '0EC9AC'), ([n], 'GPU *: 소비전력', 'FFD54F')]),
            graph('CPU / 메모리 / Load', 0, 17, 36, 7,
                  [([n], 'CPU utilization', 'FF465C'), ([n], 'Memory utilization', '0EC9AC'),
                   ([n], 'Load average (1m avg)', '4DA6FF')]),
            graph('네트워크 트래픽', 36, 17, 36, 7,
                  [([n], 'Interface *: Bits received', '4DA6FF'),
                   ([n], 'Interface *: Bits sent', 'A16BFF')]),
            graph('파일시스템 사용률', 0, 24, 72, 7,
                  [([n], 'FS *: Space: Used, in %', 'A16BFF')], 0, 100),
        ]})

    if DRY:
        for p in pages: print(f"  [{p['name']}] 위젯 {len(p['widgets'])}개")
        print(f"[dry-run] 페이지 {len(pages)}장"); return

    cur = call('dashboard.get', {'output': ['dashboardid'], 'filter': {'name': [NAME]}}, tok)
    params = {'name': NAME, 'display_period': 30, 'auto_start': 1, 'pages': pages}
    if cur:
        params['dashboardid'] = cur[0]['dashboardid']
        call('dashboard.update', params, tok); print(f"대시보드 '{NAME}' 갱신 — 페이지 {len(pages)}장")
    else:
        params['userGroups'] = []; params['users'] = []
        call('dashboard.create', params, tok); print(f"대시보드 '{NAME}' 생성 — 페이지 {len(pages)}장")

if __name__ == '__main__':
    main()
