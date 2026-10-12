#!/usr/bin/env python3
"""mblt-status 출력을 Zabbix 종속 아이템이 쓰기 좋은 JSON 으로 바꾼다.

장치당 항목마다 명령을 실행하면 분당 수십 번이 되므로, 한 번에 전부 뽑아
{"0": {"Temperature": 34, "Power.Total": 16.32, ...}, "1": {...}} 형태로 낸다.
클러스터/코어별 세부 사용률은 아이템이 너무 늘어나 제외한다(들여쓰기 8칸까지만).
"""
import json, re, subprocess, sys

SECTIONS = 'PRODUCT,TEMPERATURE,POWER,MEMORY,UTILIZATION'

def main():
    try:
        p = subprocess.run(['mblt-status', '-q', '-s', SECTIONS],
                           capture_output=True, text=True, timeout=20)
        out = p.stdout
    except Exception:
        print('{}'); return          # 도구가 없거나 실패하면 빈 객체 — LLD 가 조용히 비워진다

    data, dev, sect = {}, None, None
    for line in out.splitlines():
        if not line.strip():
            continue
        m = re.match(r'^/dev/\D*(\d+)\s*$', line)
        if m:
            dev, sect = m.group(1), None
            data[dev] = {}
            continue
        if dev is None:
            continue
        indent = len(line) - len(line.expandtabs().lstrip())
        if indent > 8:               # Cluster0/Core0 같은 세부 항목은 버린다
            continue
        if ':' not in line:
            sect = line.strip()      # 'Power', 'Memory', 'Utilization' 같은 구역 이름
            continue
        k, v = [x.strip() for x in line.split(':', 1)]
        key = k if indent <= 4 else f'{sect}.{k}'
        num = re.sub(r'[^0-9.\-]', '', v)
        try:
            data[dev][key] = float(num)
        except ValueError:
            data[dev][key] = v       # 'Aries' 같은 문자열은 그대로
    print(json.dumps(data, ensure_ascii=False))

if __name__ == '__main__':
    main()
