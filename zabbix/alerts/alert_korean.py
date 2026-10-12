#!/usr/bin/env python3
"""Teams 알림을 한글로 보낸다.

두 군데를 바꾼다.
  1) 심각도 이름 — 관리 > 일반 > 트리거 표시. {EVENT.SEVERITY} 가 이 이름으로 찍힌다.
  2) MS Teams Workflow 미디어 타입의 메시지 템플릿 (문제/복구/업데이트).

트리거 이름({EVENT.NAME})은 템플릿에서 오는 값이라 여기서 못 바꾼다.
우리가 만든 트리거는 이미 한글이고(GPU 0: 온도 심각, NAS 온도 높음, 시스템 다운),
벤더 템플릿 것은 영어로 남는다.

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/zabbix -- python3 alert_korean.py

되돌리려면 REVERT=1 을 준다 (영문 기본값으로 복원):
    ... -- REVERT=1 python3 alert_korean.py
"""
import json
import os
import urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
REVERT = os.environ.get('REVERT') == '1'
MEDIA = 'MS Teams Workflow'

SEV_KO = ['미분류', '정보', '경고', '보통', '높음', '심각']
SEV_EN = ['Not classified', 'Information', 'Warning', 'Average', 'High', 'Disaster']

# recovery: 0=문제, 1=복구, 2=업데이트
KO = {
    '0': ('[장애] {EVENT.NAME}',
          '발생: {EVENT.DATE} {EVENT.TIME}\n'
          '호스트: {HOST.NAME} ({HOST.IP})\n'
          '심각도: {EVENT.SEVERITY}\n'
          '측정값: {EVENT.OPDATA}\n'
          '이벤트 ID: {EVENT.ID}\n'
          '{TRIGGER.URL}'),
    '1': ('[복구] {EVENT.DURATION} 만에 해소 — {EVENT.NAME}',
          '해소: {EVENT.RECOVERY.DATE} {EVENT.RECOVERY.TIME}\n'
          '지속: {EVENT.DURATION}\n'
          '호스트: {HOST.NAME} ({HOST.IP})\n'
          '심각도: {EVENT.SEVERITY}\n'
          '이벤트 ID: {EVENT.ID}\n'
          '{TRIGGER.URL}'),
    '2': ('[변경] {EVENT.AGE} 경과 — {EVENT.NAME}',
          '{USER.FULLNAME} 님이 {EVENT.UPDATE.DATE} {EVENT.UPDATE.TIME} 에 처리했습니다.\n'
          '{EVENT.UPDATE.MESSAGE}\n\n'
          '현재 상태 {EVENT.STATUS}, 경과 {EVENT.AGE}, 확인 여부 {EVENT.ACK.STATUS}.'),
}
EN = {
    '0': ('Problem: {EVENT.NAME}',
          'Problem started at {EVENT.TIME} on {EVENT.DATE}\n'
          'Problem name: {EVENT.NAME}\nHost: {HOST.NAME}\n'
          'Severity: {EVENT.SEVERITY}\nOperational data: {EVENT.OPDATA}\n'
          'Original problem ID: {EVENT.ID}\n{TRIGGER.URL}'),
    '1': ('Resolved in {EVENT.DURATION}: {EVENT.NAME}',
          'Problem has been resolved in {EVENT.DURATION} at {EVENT.RECOVERY.TIME}'
          ' on {EVENT.RECOVERY.DATE}\nProblem name: {EVENT.NAME}\nHost: {HOST.NAME}\n'
          'Severity: {EVENT.SEVERITY}\nOriginal problem ID: {EVENT.ID}\n{TRIGGER.URL}'),
    '2': ('Updated problem in {EVENT.AGE}: {EVENT.NAME}',
          '{USER.FULLNAME} {EVENT.UPDATE.ACTION} problem at {EVENT.UPDATE.DATE}'
          ' {EVENT.UPDATE.TIME}.\n{EVENT.UPDATE.MESSAGE}\n\n'
          'Current problem status is {EVENT.STATUS}, age is {EVENT.AGE},'
          ' acknowledged: {EVENT.ACK.STATUS}.'),
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

    names = SEV_EN if REVERT else SEV_KO
    call('settings.update', {f'severity_name_{i}': n for i, n in enumerate(names)}, tok)
    print('심각도 이름:', ' / '.join(names))

    mts = call('mediatype.get', {'filter': {'name': [MEDIA]},
                                 'output': ['mediatypeid'],
                                 'selectMessageTemplates': 'extend'}, tok)
    if not mts:
        raise SystemExit(f'미디어 타입 {MEDIA!r} 를 찾지 못했다')
    mt = mts[0]

    src = EN if REVERT else KO
    # 이 미디어 타입이 실제로 갖고 있는 템플릿만 손댄다 (eventsource 0 = 트리거)
    out = []
    for t in mt['message_templates']:
        if t['eventsource'] == '0' and t['recovery'] in src:
            subj, msg = src[t['recovery']]
            out.append({'eventsource': t['eventsource'], 'recovery': t['recovery'],
                        'subject': subj, 'message': msg})
        else:
            out.append({k: t[k] for k in
                        ('eventsource', 'recovery', 'subject', 'message')})

    call('mediatype.update', {'mediatypeid': mt['mediatypeid'],
                              'message_templates': out}, tok)
    print(f'{MEDIA}: 템플릿 {len(out)}개 갱신')
    print('\n예시 제목:', src['0'][0])


if __name__ == '__main__':
    main()
