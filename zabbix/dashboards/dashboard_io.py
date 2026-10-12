#!/usr/bin/env python3
"""전역 대시보드 export/import.

Zabbix의 configuration.export/import는 전역 대시보드를 다루지 못한다(템플릿 대시보드만 지원).
그래서 API로 직접 복사하되, 위젯이 그룹을 숫자 ID로 참조하는 탓에 그대로 옮기면 다른
인스턴스에서 깨진다. export 시 ID를 이름으로 바꿔 저장하고, import 시 다시 해석한다.

  python3 dashboard_io.py export "IMS 네트워크 관제"
  python3 dashboard_io.py import dashboards/xxx.json [새이름]
"""
import json, os, sys, urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
USER = os.environ.get('ZBX_USER', 'Admin')
PW   = os.environ.get('ZBX_PASS', 'zabbix')
HERE = os.path.dirname(os.path.abspath(__file__))

def call(method, params, auth=None):
    body = {'jsonrpc':'2.0','method':method,'params':params,'id':1}
    if auth: body['auth'] = auth
    req = urllib.request.Request(API, method='POST',
        headers={'Content-Type':'application/json-rpc'}, data=json.dumps(body).encode())
    r = json.load(urllib.request.urlopen(req))
    if 'error' in r:
        raise SystemExit(f"{method}: {json.dumps(r['error'], ensure_ascii=False)}")
    return r['result']

def login():
    return call('user.login', {'username': USER, 'password': PW})

# 위젯 필드 타입 2=호스트그룹, 3=호스트 — 인스턴스마다 ID가 달라 이름으로 바꿔 둔다
GROUP_FIELD, HOST_FIELD = '2', '3'

def export(name):
    tok = login()
    d = call('dashboard.get', {'output':['name','display_period','auto_start'],
             'selectPages':'extend', 'filter':{'name':[name]}}, tok)
    if not d: raise SystemExit(f'대시보드 없음: {name}')
    d = d[0]
    gname = {g['groupid']: g['name'] for g in call('hostgroup.get', {'output':['groupid','name']}, tok)}
    hname = {h['hostid']: h['host'] for h in call('host.get', {'output':['hostid','host']}, tok)}
    for p in d['pages']:
        p.pop('dashboard_pageid', None)
        for w in p['widgets']:
            w.pop('widgetid', None)
            for f in w['fields']:
                if f['type'] == GROUP_FIELD: f['value'] = gname.get(f['value'], f['value'])
                elif f['type'] == HOST_FIELD: f['value'] = hname.get(f['value'], f['value'])
    d.pop('dashboardid', None)
    path = os.path.join(HERE, 'dashboards', f"{name.replace(' ', '_')}.json")
    json.dump(d, open(path, 'w'), ensure_ascii=False, indent=2)
    print(f'export: {path}')

def imp(path, newname=None):
    tok = login()
    d = json.load(open(path if os.path.isabs(path) else os.path.join(HERE, path)))
    if newname: d['name'] = newname
    gid = {g['name']: g['groupid'] for g in call('hostgroup.get', {'output':['groupid','name']}, tok)}
    hid = {h['host']: h['hostid'] for h in call('host.get', {'output':['hostid','host']}, tok)}
    missing = []
    for p in d['pages']:
        for w in p['widgets']:
            for f in w['fields']:
                if f['type'] == GROUP_FIELD:
                    if f['value'] not in gid: missing.append(f"호스트그룹 '{f['value']}'")
                    else: f['value'] = gid[f['value']]
                elif f['type'] == HOST_FIELD:
                    if f['value'] not in hid: missing.append(f"호스트 '{f['value']}'")
                    else: f['value'] = hid[f['value']]
    if missing:
        raise SystemExit('대상 인스턴스에 없음: ' + ', '.join(sorted(set(missing))))
    old = call('dashboard.get', {'output':['dashboardid'], 'filter':{'name':[d['name']]}}, tok)
    if old: call('dashboard.delete', [old[0]['dashboardid']], tok)
    r = call('dashboard.create', d, tok)
    print(f"import 완료: {d['name']} (id={r['dashboardids'][0]})")

if __name__ == '__main__':
    if len(sys.argv) < 3: raise SystemExit(__doc__)
    (export if sys.argv[1] == 'export' else imp)(*sys.argv[2:])
