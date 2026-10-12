#!/usr/bin/env python3
"""Load average 트리거 임계를 호스트별로 조정한다.

`Linux by Zabbix agent` 의 'Load average is too high' 는
    min(load1,5m) / CPU수 > {$LOAD_AVG_PER_CPU.MAX.WARN}
이고 템플릿 기본값이 1.5 다. 대부분 장비는 이 값이 맞지만 두 대는 어긋난다.
아래 값은 2026-09-07 에 최근 7일 시간별 추세(trend)로 per-CPU load 분포를
뽑아서 정했다.

  dev-media01   CPU 4개, 중앙값 6.11 / p95 6.28 / 최대 8.68
                → 상시 4배 초과 상태라 알림이 굳어 있다. 8 로 올려
                  '평소보다 나빠질 때' 만 잡게 한다.
                  ※ 이건 알림 문제가 아니라 용량 문제다. 4코어에 load 24 가
                    상시이고 CPU 98% 다. 임계를 올리는 것은 포화를 덮는 것이므로
                    증설·작업 분산을 별도로 검토해야 한다.

  dev-storage01 CPU 32개, 중앙값 0.06 / p95 2.41 / 최대 13.20
                → 평소 한가한데 급증이 반복된다. 3 으로 올려 잔잔한 것은
                  넘기고 진짜 급증(최대 13.2)은 계속 잡는다.

손대지 않는 것:
  ai-gpu04      CPU 96개, p95 1.23 / 최대 2.08.
                2026-09-07 장애 때 175/96 = 1.82 로 넘겨 정확히 울렸다.
                올리면 같은 사고를 놓친다.
  그 외 16대    p95 가 모두 0.8 이하다. 기본값 1.5 로 충분하다.

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/zabbix -- python3 alerts/load_threshold.py

미리 보기:
    DRY_RUN=1 infisical run ... -- python3 alerts/load_threshold.py

되돌리기 (호스트 매크로를 지워 템플릿 기본값 1.5 로 복귀):
    REVERT=1 infisical run ... -- python3 alerts/load_threshold.py
"""
import json
import os
import urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DRY = os.environ.get('DRY_RUN') == '1'
REVERT = os.environ.get('REVERT') == '1'

MACRO = '{$LOAD_AVG_PER_CPU.MAX.WARN}'
THRESHOLDS = {
    'dev-media01':   '8',
    'dev-storage01': '3',
}


def call(method, params, token=None):
    body = {'jsonrpc': '2.0', 'method': method, 'params': params, 'id': 1}
    if token:
        body['auth'] = token
    req = urllib.request.Request(API, json.dumps(body).encode(),
                                 {'Content-Type': 'application/json-rpc'})
    res = json.load(urllib.request.urlopen(req, timeout=60))
    if 'error' in res:
        raise SystemExit(f"{method}: {res['error']}")
    return res['result']


def main():
    pw = os.environ.get('ZBX_PASS')
    if not pw:
        raise SystemExit('ZBX_PASS 가 없다. infisical run 으로 주입해서 실행해라.')
    tok = call('user.login',
               {'username': os.environ.get('ZBX_USER', 'Admin'), 'password': pw})

    for host, value in THRESHOLDS.items():
        hs = call('host.get', {'filter': {'host': [host]},
                               'output': ['hostid', 'name']}, tok)
        if not hs:
            print(f'{host}: 호스트 없음 — 건너뜀')
            continue
        h = hs[0]
        cur = call('usermacro.get', {'hostids': h['hostid'], 'output': 'extend',
                                     'filter': {'macro': MACRO}}, tok)

        if REVERT:
            if not cur:
                print(f"{h['name']}: 호스트 매크로 없음 — 건너뜀")
                continue
            print(f"{h['name']}: 매크로 삭제 → 템플릿 기본값 1.5 로 복귀"
                  + (' (DRY_RUN)' if DRY else ''))
            if not DRY:
                call('usermacro.delete', [cur[0]['hostmacroid']], tok)
            continue

        if cur and cur[0]['value'] == value:
            print(f"{h['name']}: 이미 {value} — 건너뜀")
            continue

        was = cur[0]['value'] if cur else '1.5 (템플릿 기본값)'
        print(f"{h['name']}: {was} → {value}" + (' (DRY_RUN)' if DRY else ''))
        if DRY:
            continue
        if cur:
            call('usermacro.update',
                 {'hostmacroid': cur[0]['hostmacroid'], 'value': value}, tok)
        else:
            call('usermacro.create',
                 {'hostid': h['hostid'], 'macro': MACRO, 'value': value,
                  'description': '실측 p95 기반. alerts/load_threshold.py 참고.'}, tok)

    print('\n완료' + (' (DRY_RUN — 아무것도 바꾸지 않았다)' if DRY else ''))
    if not REVERT and not DRY:
        print('dev-media01 은 임계만 올렸을 뿐 포화 상태 그대로다 — 용량 검토가 별도로 필요하다.')


if __name__ == '__main__':
    main()
