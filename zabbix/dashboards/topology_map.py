#!/usr/bin/env python3
"""사내 인프라 토폴로지를 Zabbix 맵으로 만든다.

배치는 담당자가 준 구성도(mermaid graph LR)를 그대로 옮긴 것이다.
맵은 호스트 상태에 따라 아이콘 색이 바뀌므로, 어디가 죽었을 때 무엇이 같이
끊기는지 한눈에 보는 용도다.

선을 두 종류로 나눴다.
  실선  물리 LAN 경로 (스위치 ↔ 장비)
  점선  테일넷/VPN 경로 (headscale ↔ 서브넷 라우터 ↔ 각 망)

구성도의 `dev-gpu01 --> data-center` 는 장비 10대로 선을 뽑는 대신
`dev-gpu01 --> sw-core` 한 줄로 그렸다. dev-gpu01 은 서브넷 라우터라
테일넷에서 들어온 트래픽이 거기서 LAN 으로 나가고, 그 다음은 sw-core 가
나른다. 선 10개보다 이쪽이 실제 경로에 가깝고 읽기도 낫다.

같은 이름의 맵이 있으면 지우고 다시 만든다 — 화면에서 손으로 옮긴 위치는
사라진다.

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/watch -- python3 dashboards/topology_map.py

미리 보기:  DRY_RUN=1 ...
"""
import json
import os
import urllib.request

API = os.environ.get('ZBX_API', 'http://<ZABBIX_SERVER_IP>/api_jsonrpc.php')
DRY = os.environ.get('DRY_RUN') == '1'
MAP_NAME = 'IMS 인프라 토폴로지'
W, H = 1760, 1150

# 아이콘 (image.get, imagetype=1). 64px 로 통일한다.
ICO_ROUTER, ICO_SWITCH, ICO_WIFI = '125', '155', '145'
ICO_SERVER, ICO_RACK, ICO_WS = '150', '102', '180'
ICO_VPN, ICO_SITE, ICO_BMC = '9', '34', '64'

# 선 종류. drawtype 0=실선, 2=굵은실선, 4=점선
LAN_MAIN = {'drawtype': 2, 'color': '1F6FEB'}   # 라우터~스위치 백본
LAN_LEAF = {'drawtype': 0, 'color': '8AA4C8'}   # 스위치~말단 장비
TAILNET = {'drawtype': 4, 'color': 'B45FCF'}    # 테일넷/VPN

# (기술명, x, y, 아이콘). 좌표는 아이콘 좌상단.
NODES = [
    # cloud-vpn-route
    ('headscale',       170, 470, ICO_SERVER),
    ('tsr',             400, 410, ICO_VPN),
    ('dev-gpu01',       400, 545, ICO_VPN),
    # cloud
    ('rtpulse',        590,  90, ICO_SERVER),
    ('ims',            730,  90, ICO_SERVER),
    ('demo-cx',          870,  90, ICO_SERVER),
    ('weknora',        1010,  90, ICO_SERVER),
    ('bot-exec',       1150,  90, ICO_SERVER),
    ('bot-kb',         1290,  90, ICO_SERVER),
    ('quoto-gen',       590, 195, ICO_SERVER),
    ('vaultwarden',     730, 195, ICO_SERVER),
    ('central-metrics', 870, 195, ICO_SERVER),
    ('vms-demo-relay',1010, 195, ICO_SERVER),
    ('derp-kr',        1150, 195, ICO_SERVER),
    # data-center — 서버·NAS
    ('inf-gpu01',       590, 425, ICO_RACK),
    ('inf-gpu02',       730, 425, ICO_RACK),
    ('dev-gpu02',       870, 425, ICO_RACK),
    ('dev-gpu03',      1010, 425, ICO_RACK),
    ('dev-gpu04',      1150, 425, ICO_RACK),
    ('ai-gpu01',       1290, 425, ICO_RACK),
    ('ai-gpu02',       1430, 425, ICO_RACK),
    ('ai-gpu04',       1570, 425, ICO_RACK),
    ('dev-media01',     590, 530, ICO_RACK),
    ('dev-storage01',   730, 530, ICO_RACK),
    ('esc8000',         870, 530, ICO_RACK),
    ('h200',           1010, 530, ICO_RACK),
    ('nas01',          1150, 530, ICO_RACK),
    ('nas03',          1290, 530, ICO_RACK),
    ('NAS02-main-36',  1430, 530, ICO_RACK),
    ('MS-201',         1570, 530, ICO_RACK),
    # data-center — BMC (호스트 NIC 과 케이블을 공유하는 관리 인터페이스)
    ('inf-gpu01-bmc',     590, 635, ICO_BMC),
    ('dev-gpu01-bmc',     730, 635, ICO_BMC),
    ('dev-gpu02-bmc',     870, 635, ICO_BMC),
    ('dev-gpu03-bmc',    1010, 635, ICO_BMC),
    ('dev-gpu04-bmc',    1150, 635, ICO_BMC),
    ('dev-storage01-bmc',1290, 635, ICO_BMC),
    ('ai-gpu04-bmc',     1430, 635, ICO_BMC),
    ('ws-07-bmc',       1570, 635, ICO_BMC),
    # sw
    ('r',               620, 785, ICO_ROUTER),
    ('sw-core',         830, 785, ICO_SWITCH),
    ('sw-access',      1040, 785, ICO_SWITCH),
    ('sw-office',      1250, 785, ICO_SWITCH),
    # ws
    ('ws-07',          590, 930, ICO_WS),
    ('ws-03',           720, 930, ICO_WS),
    ('ws-05',           850, 930, ICO_WS),
    ('ws-02',           980, 930, ICO_WS),
    ('ws-04',           590,1015, ICO_WS),
    ('ws-01',           720,1015, ICO_WS),
    ('ws-06',           850,1015, ICO_WS),
    # office
    ('kt_wifi',        1250, 930, ICO_WIFI),
    ('office_wifi',  1250,1015, ICO_WIFI),
    # remote
    ('site-b',            170, 730, ICO_SITE),
    ('site-e',          320, 730, ICO_SITE),
    ('site-d',        170, 840, ICO_SITE),
    ('site-c',          320, 840, ICO_SITE),
    ('site-f',             170, 950, ICO_SITE),
    ('site-a',           320, 950, ICO_SITE),
]

# (x, y, w, h, 제목, 배경색)
BOXES = [
    (560,  30,  880, 320, 'cloud (GCP VPC)',   'EAF2FC'),
    (140, 380,  400, 260, 'cloud-vpn-route',   'E6F5F2'),
    (560, 380, 1160, 355, 'data-center',       'F1F7EA'),
    (560, 755,  880, 120, 'sw',                'FFF5E3'),
    (560, 895,  620, 215, 'ws',                'F7F3FF'),
    (1200, 895, 240, 215, 'office',            'FDEDED'),
    (140, 690,  400, 350, 'remote (고객사)',     'F7EEF7'),
]

DC = ['inf-gpu01', 'inf-gpu02', 'dev-gpu02', 'dev-gpu03', 'dev-gpu04', 'ai-gpu01',
      'ai-gpu02', 'ai-gpu04', 'dev-media01', 'dev-storage01', 'esc8000', 'h200',
      'nas01', 'nas03', 'NAS02-main-36', 'MS-201']
# BMC 는 공유 LAN(NCSI) 이라 호스트 NIC 과 같은 케이블·같은 스위치 포트를 쓴다.
# 그래서 각자의 서버가 아니라 sw-core 로 선을 뽑는다 — 물리적으로 그게 맞다.
BMC = ['inf-gpu01-bmc', 'dev-gpu01-bmc', 'dev-gpu02-bmc', 'dev-gpu03-bmc', 'dev-gpu04-bmc',
       'dev-storage01-bmc', 'ai-gpu04-bmc', 'ws-07-bmc']
CLOUD = ['rtpulse', 'ims', 'demo-cx', 'weknora', 'bot-exec', 'bot-kb', 'quoto-gen',
         'vaultwarden', 'central-metrics', 'vms-demo-relay', 'derp-kr']
WS = ['ws-07', 'ws-03', 'ws-05', 'ws-02', 'ws-04', 'ws-01', 'ws-06']
REMOTE = ['site-b', 'site-e', 'site-d', 'site-c', 'site-f', 'site-a']

# (from, to, 선종류, 라벨)
LINKS = (
    [('r', 'sw-core', LAN_MAIN, ''),
     ('sw-core', 'sw-access', LAN_MAIN, ''),
     ('sw-access', 'sw-office', LAN_MAIN, ''),
     ('headscale', 'tsr', TAILNET, 'tailnet'),
     ('headscale', 'dev-gpu01', TAILNET, 'tailnet'),
     ('dev-gpu01', 'sw-core', TAILNET, '<OFFICE_SUBNET_CIDR>\nSNAT')]
    + [('sw-core', h, LAN_LEAF, '') for h in DC]
    + [('sw-core', h, LAN_LEAF, '') for h in BMC]
    + [('sw-access', h, LAN_LEAF, '') for h in WS]
    + [('sw-office', h, LAN_LEAF, '') for h in ('kt_wifi', 'office_wifi')]
    + [('tsr', h, TAILNET, '') for h in CLOUD]
    + [('headscale', h, TAILNET, '') for h in REMOTE]
)

_token = None


def call(method, params):
    body = {'jsonrpc': '2.0', 'method': method, 'params': params, 'id': 1}
    headers = {'Content-Type': 'application/json-rpc'}
    if _token:
        headers['Authorization'] = f'Bearer {_token}'
    r = urllib.request.Request(API, json.dumps(body).encode(), headers)
    out = json.load(urllib.request.urlopen(r, timeout=60))
    if 'error' in out:
        raise SystemExit(f"{method} → {out['error']}")
    return out['result']


def login():
    global _token
    _token = os.environ.get('ZABBIX_TOKEN') or os.environ.get('ZBX_TOKEN')
    if _token:
        return
    pw = os.environ.get('ZBX_PASS')
    if not pw:
        raise SystemExit('ZABBIX_TOKEN 이나 ZBX_PASS 가 필요하다.')
    _token = call('user.login', {'username': os.environ.get('ZBX_USER', 'Admin'), 'password': pw})


def main():
    login()
    print(f'{MAP_NAME}' + (' (DRY_RUN)' if DRY else ''))
    print(f'{API}\n')

    names = [n for n, *_ in NODES]
    found = {h['host']: h['hostid'] for h in
             call('host.get', {'output': ['hostid', 'host'], 'filter': {'host': names}})}
    missing = [n for n in names if n not in found]
    if missing:
        raise SystemExit(f'Zabbix 에 없는 호스트: {missing}')
    print(f'노드 {len(names)}개, 선 {len(LINKS)}개, 박스 {len(BOXES)}개')

    # 임시 selementid 로 선을 건다. map.create 가 실제 id 로 바꿔 준다.
    sid = {n: i + 1 for i, n in enumerate(names)}
    selements = [{
        'selementid': sid[n], 'elementtype': 0, 'elements': [{'hostid': found[n]}],
        'iconid_off': ico, 'x': x, 'y': y, 'label': '{HOST.NAME}', 'label_location': 0,
    } for n, x, y, ico in NODES]

    links = [{
        'selementid1': sid[a], 'selementid2': sid[b],
        'drawtype': style['drawtype'], 'color': style['color'],
        **({'label': lb} if lb else {}),
    } for a, b, style, lb in LINKS]

    shapes = [{
        'type': 0, 'x': x, 'y': y, 'width': w, 'height': h, 'text': t,
        'font_size': 12, 'font_color': '4A4A4A',
        'text_halign': 1, 'text_valign': 1,          # 좌상단에 제목
        'border_type': 1, 'border_width': 1, 'border_color': 'C6C6C6',
        'background_color': bg, 'zindex': 0,
    } for x, y, w, h, t, bg in BOXES]

    old = call('map.get', {'output': ['sysmapid'], 'filter': {'name': [MAP_NAME]}})
    if old:
        print(f"  기존 맵 {old[0]['sysmapid']} 삭제 (손으로 옮긴 위치는 사라진다)")
        if not DRY:
            call('map.delete', [old[0]['sysmapid']])

    if DRY:
        print('\nDRY_RUN — 아무것도 바꾸지 않았다')
        return

    r = call('map.create', {
        'name': MAP_NAME, 'width': W, 'height': H,
        'label_type': 0,              # 요소 라벨을 그대로 표시
        'expand_macros': 1,
        'highlight': 1,               # 문제 있는 요소에 테두리 강조
        'grid_show': 1, 'grid_align': 1, 'grid_size': 20,
        'selements': selements, 'links': links, 'shapes': shapes,
    })
    print(f"\n생성 완료 — sysmapid {r['sysmapids'][0]}")
    print('Zabbix → 모니터링 → 맵 에서 볼 수 있다.')


if __name__ == '__main__':
    main()
