#!/usr/bin/env python3
"""BMC(IPMI) 주소를 NetBox 에 기록한다.

Zabbix 에는 BMC 8대가 등록돼 있는데 NetBox(인프라 대장)에는 그 주소가 어디에도
없었다. 장비를 물리적으로 찾아가야 할 때 대장에서 BMC 주소를 못 찾으면 곤란하다.

NetBox 에는 out-of-band 주소를 담는 자리(`device.oob_ip`)가 따로 있다. 그런데
그 필드에 넣을 IP 는 **그 장비의 인터페이스에 배정돼 있어야** NetBox 가 받아준다.
그래서 세 단계로 만든다.

  1) `BMC` 인터페이스 (mgmt_only=True) — 없으면 만든다
  2) IP 주소 객체를 그 인터페이스에 배정
  3) device.oob_ip 로 지정

인터페이스를 따로 두는 이유: 이 서버들은 전부 **공유 LAN(NCSI) 모드**로,
케이블 하나가 호스트와 BMC 를 같이 나른다. 물리 포트가 따로 있는 것은 아니지만
NetBox UI 에서 OOB 주소를 한눈에 보려면 이 편이 낫다. 그 사정을 인터페이스
설명에 적어 둔다.

주소 출처는 Zabbix 의 'IMS BMC (IPMI)' 그룹이다 (2026-09-07 기준 8대).
BMC 는 ICMP 에 응답하지 않으므로 ping 으로 검증할 수 없다.

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/ims -- python3 hosts/netbox_bmc_ip.py

미리 보기:  DRY_RUN=1 infisical run ... --path=/ims -- python3 hosts/netbox_bmc_ip.py

NETBOX_URL 은 Infisical 에 없다(테라폼이 컨테이너 내부 주소로 넣는다).
여기서는 공개 경로를 기본값으로 쓰고, 필요하면 환경변수로 덮는다.
"""
import json
import os
import urllib.error
import urllib.parse
import urllib.request

NB = os.environ.get('NETBOX_API', 'https://ims.example.com/netbox/api')
TOKEN = os.environ.get('NETBOX_TOKEN')
DRY = os.environ.get('DRY_RUN') == '1'

IFACE = 'BMC'
IFACE_DESC = ('BMC/IPMI. 공유 LAN(NCSI) 모드라 호스트 NIC 과 케이블을 공유한다 '
              '— 물리 포트가 따로 있는 것은 아니다.')
PREFIX_LEN = 16          # 사내망 <OFFICE_SUBNET_CIDR>

# Zabbix 호스트명 → (NetBox 장비명, BMC 주소)
BMC = [
    ('ai-gpu04',      'ai-gpu04',      '<AI_GPU04_BMC_IP>'),
    ('dev-gpu01',     'dev-gpu01',     '<DEV_GPU01_BMC_IP>'),
    ('dev-gpu02',     'dev-gpu02',     '<DEV_GPU02_BMC_IP>'),
    ('dev-gpu03',     'dev-gpu03',     '<DEV_GPU03_BMC_IP>'),
    ('dev-gpu04',     'dev-gpu04',     '<DEV_GPU04_BMC_IP>'),
    ('dev-storage01', 'dev-storage01', '<DEV_STORAGE01_BMC_IP>'),
    ('inf-gpu01',     'inf-gpu01',     '<INF_GPU01_BMC_IP>'),
    ('ws-07',        'WS (07)',      '<WS07_BMC_IP>'),
]


def req(method, path, body=None):
    url = f'{NB}{path}'
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method, headers={
        'Authorization': f'Token {TOKEN}',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    })
    try:
        with urllib.request.urlopen(r, timeout=30) as f:
            return json.load(f) if f.status != 204 else None
    except urllib.error.HTTPError as e:
        raise SystemExit(f'{method} {path} → HTTP {e.code}\n{e.read().decode()[:400]}')


def one(path, what):
    d = req('GET', path)
    if d['count'] == 0:
        return None
    if d['count'] > 1:
        raise SystemExit(f'{what}: {d["count"]}개가 나왔다 — 이름이 모호하다')
    return d['results'][0]


def main():
    if not TOKEN:
        raise SystemExit('NETBOX_TOKEN 이 없다. infisical run --path=/ims 으로 실행해라.')

    st = req('GET', '/status/')
    print(f"NetBox {st.get('netbox-version')} @ {NB}")
    print(f"대상 {len(BMC)}대" + (' (DRY_RUN)' if DRY else ''))
    print()

    for zbx, dev_name, addr in BMC:
        dev = one(f'/dcim/devices/?name={urllib.parse.quote(dev_name)}', dev_name)
        if not dev:
            print(f'{dev_name:<16} 장비 없음 — 건너뜀')
            continue
        did = dev['id']
        cidr = f'{addr}/{PREFIX_LEN}'

        # 이미 맞게 들어가 있으면 아무것도 하지 않는다
        cur = (dev.get('oob_ip') or {}).get('address')
        if cur == cidr:
            print(f'{dev_name:<16} 이미 oob_ip = {cidr}')
            continue

        # 1) BMC 인터페이스
        iface = one(f'/dcim/interfaces/?device_id={did}&name={IFACE}', f'{dev_name}/{IFACE}')
        if iface:
            iid = iface['id']
            act = '기존 인터페이스 사용'
        elif DRY:
            iid = None
            act = f'{IFACE} 인터페이스 생성 예정'
        else:
            iid = req('POST', '/dcim/interfaces/', {
                'device': did, 'name': IFACE, 'type': 'other',
                'mgmt_only': True, 'description': IFACE_DESC,
            })['id']
            act = f'{IFACE} 인터페이스 생성'

        # 2) IP 주소 객체
        ip = one(f'/ipam/ip-addresses/?address={cidr}', cidr)
        if ip and not DRY:
            # 다른 장비에 붙어 있으면 손대지 않는다 — 잘못 옮기면 추적이 어려워진다
            a = ip.get('assigned_object')
            owner = (a or {}).get('device', {}).get('name') if a else None
            if owner and owner != dev_name:
                print(f'{dev_name:<16} {cidr} 가 이미 {owner} 에 배정돼 있다 — 건너뜀')
                continue
            req('PATCH', f"/ipam/ip-addresses/{ip['id']}/", {
                'assigned_object_type': 'dcim.interface', 'assigned_object_id': iid,
                'description': f'{zbx} BMC',
            })
            ipid = ip['id']
        elif DRY:
            ipid = None
        else:
            ipid = req('POST', '/ipam/ip-addresses/', {
                'address': cidr, 'status': 'active',
                'assigned_object_type': 'dcim.interface', 'assigned_object_id': iid,
                'description': f'{zbx} BMC',
            })['id']

        # 3) oob_ip 지정
        if not DRY:
            req('PATCH', f'/dcim/devices/{did}/', {'oob_ip': ipid})

        print(f'{dev_name:<16} oob_ip ← {cidr}  ({act})' + (' (DRY_RUN)' if DRY else ''))

    print('\n완료' + (' (DRY_RUN — 아무것도 바꾸지 않았다)' if DRY else ''))
    if not DRY:
        print('NetBox 장비 화면의 Out-of-band IP 칸에서 확인할 수 있다.')


if __name__ == '__main__':
    main()
