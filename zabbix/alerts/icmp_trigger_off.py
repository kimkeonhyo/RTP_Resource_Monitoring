#!/usr/bin/env python3
"""ICMP 응답시간 트리거를 비활성화한다.

Zabbix 가 Docker 안에 있어 사내 장비까지 터널을 거친다. 전 장비가 69~151ms 로
고르게 나오는데 이는 장비 상태가 아니라 측정 경로의 산물이라 알림으로 쓸 수 없다.
지표 수집은 그대로 두고 트리거만 끈다 — VM 이전 후 다시 켜면 의미가 생긴다.
  python3 icmp_trigger_off.py [--dry-run] [--on]
"""
import json, os, sys, urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DRY = '--dry-run' in sys.argv
STATUS = 0 if '--on' in sys.argv else 1        # 0=사용, 1=중지
PAT = 'High ICMP ping response time'

def call(m, p, a=None):
    b = {'jsonrpc': '2.0', 'method': m, 'params': p, 'id': 1}
    if a: b['auth'] = a
    r = json.load(urllib.request.urlopen(urllib.request.Request(
        API, method='POST', headers={'Content-Type': 'application/json-rpc'},
        data=json.dumps(b).encode())))
    if 'error' in r: raise SystemExit(f"{m}: {json.dumps(r['error'], ensure_ascii=False)}")
    return r['result']

def main():
    tok = call('user.login', {'username': os.environ.get('ZBX_USER', 'Admin'),
                              'password': os.environ.get('ZBX_PASS', 'zabbix')})
    trs = call('trigger.get', {'output': ['triggerid', 'description', 'status'],
                               'search': {'description': PAT},
                               'selectHosts': ['host'], 'templated': False}, tok)
    todo = [t for t in trs if t['status'] != str(STATUS)]
    print(f"'{PAT}' 트리거 {len(trs)}개 중 변경 대상 {len(todo)}개")
    for t in todo[:30]:
        print(f"  {t['hosts'][0]['host']}")
    if not todo or DRY:
        if DRY: print('[dry-run] 적용하지 않음')
        return
    call('trigger.update', [{'triggerid': t['triggerid'], 'status': STATUS} for t in todo], tok)
    print(f"{len(todo)}개 {'활성화' if STATUS == 0 else '비활성화'} 완료")

if __name__ == '__main__':
    main()
