#!/usr/bin/env python3
"""NetBox 의 office_wifi 기록을 실측값으로 맞춘다.

AP 가 공유기 모드에서 AP 모드로 바뀌면서 관리 주소가 <OFFICE_WIFI_OLD_IP> →
<OFFICE_WIFI_IP> 으로 옮겨갔는데 NetBox 는 옛 주소를 들고 있었다.

MAC 을 같이 넣는다. 이번에 주소를 찾을 때 NetBox 에 MAC 이 없어 라우터 ARP
테이블 236건을 훑고 OUI 를 일일이 조회해야 했다. MAC 이 있었으면 한 번에 끝났다.

값은 전부 실측이다:
  IP   <OFFICE_WIFI_IP>        (MikroTik ARP, 완료 상태)
  MAC  00:00:5E:00:53:01   (EFM Networks)
  모델 ipTIME BE19000      (사설 MIB enterprises.12874.1.1.2.0)
  펌웨어 15.102            (같은 MIB .1.1.3.0)

실행:
    infisical run --projectId=<INFISICAL_PROJECT_ID> \
        --env=gcp --path=/ims -- python3 hosts/netbox_wifi_ap.py
미리 보기:  DRY_RUN=1 ...
"""
import json
import os
import urllib.error
import urllib.parse
import urllib.request

NB = os.environ.get('NETBOX_API', 'https://ims.example.com/netbox/api')
TOKEN = os.environ.get('NETBOX_TOKEN')
DRY = os.environ.get('DRY_RUN') == '1'

DEVICE = 'Office_wifi (IP-Time)'
OLD_CIDR = '<OFFICE_WIFI_OLD_IP>/16'
NEW_CIDR = '<OFFICE_WIFI_IP>/16'
MAC = '00:00:5E:00:53:01'
MODEL, FIRMWARE = 'ipTIME BE19000', '15.102'
NOTE = ('AP(브리지) 모드. 인터넷 공유 기능(NAT) 꺼짐 — 2026-08-04 변경. '
        '관리 주소가 WAN(<OFFICE_WIFI_OLD_IP>) 에서 LAN 브리지(<OFFICE_WIFI_IP>) 로 옮겨졌다. '
        f'모델 {MODEL}, 펌웨어 {FIRMWARE}. SNMP v2c 읽기전용 사용.')


def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(f'{NB}{path}', data=data, method=method, headers={
        'Authorization': f'Token {TOKEN}', 'Content-Type': 'application/json',
        'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(r, timeout=30) as f:
            return json.load(f) if f.status != 204 else None
    except urllib.error.HTTPError as e:
        raise SystemExit(f'{method} {path} → HTTP {e.code}\n{e.read().decode()[:400]}')


def main():
    if not TOKEN:
        raise SystemExit('NETBOX_TOKEN 이 없다. infisical run --path=/ims 으로 실행해라.')
    print('NetBox office_wifi 정리' + (' (DRY_RUN)' if DRY else ''))
    print(f'{NB}\n')

    d = req('GET', f'/dcim/devices/?name={urllib.parse.quote(DEVICE)}')
    if d['count'] != 1:
        raise SystemExit(f"'{DEVICE}' 장비가 {d['count']}건 — 이름을 확인해라")
    dev = d['results'][0]
    print(f"장비 {dev['name']} (id {dev['id']})")

    ifs = req('GET', f"/dcim/interfaces/?device_id={dev['id']}")['results']
    for i in ifs:
        print(f"  iface {i['name']:<8} MAC={i.get('mac_address') or '없음'}")

    # IP 주소 갱신
    ips = req('GET', f'/ipam/ip-addresses/?device_id={dev["id"]}')['results']
    for ip in ips:
        if ip['address'] == NEW_CIDR:
            print(f'  IP 이미 {NEW_CIDR}')
            break
        if ip['address'] == OLD_CIDR:
            print(f"  IP {OLD_CIDR} → {NEW_CIDR}")
            if not DRY:
                req('PATCH', f"/ipam/ip-addresses/{ip['id']}/",
                    {'address': NEW_CIDR, 'description': 'AP 모드 LAN 브리지 관리 주소'})
            break
    else:
        print(f'  ⚠ {OLD_CIDR} 를 못 찾았다 — 수동 확인 필요')

    # MAC: 주소를 들고 있는 인터페이스에 넣는다
    target = next((i for i in ifs if any(x['address'] in (OLD_CIDR, NEW_CIDR)
                                         for x in ips
                                         if (x.get('assigned_object') or {}).get('id') == i['id'])),
                  ifs[0] if ifs else None)
    if not target:
        print('  ⚠ 인터페이스가 없어 MAC 을 넣을 곳이 없다')
    elif (target.get('mac_address') or '').upper() == MAC:
        print(f"  MAC 이미 {MAC}")
    else:
        print(f"  iface '{target['name']}' MAC ← {MAC}")
        if not DRY:
            req('PATCH', f"/dcim/interfaces/{target['id']}/", {'mac_address': MAC})

    # 모델·모드는 comments 에 남긴다. device_type 을 바꾸는 건 별개 작업이다.
    if (dev.get('comments') or '').strip() == NOTE:
        print('  비고 이미 최신')
    else:
        print('  비고 갱신 (모델·펌웨어·AP 모드 경위)')
        if not DRY:
            req('PATCH', f"/dcim/devices/{dev['id']}/", {'comments': NOTE})

    print('\n완료' + (' (DRY_RUN — 아무것도 바꾸지 않았다)' if DRY else ''))


if __name__ == '__main__':
    main()
