# IMS Zabbix 운영

사내 관제(Zabbix 7.0)를 코드로 관리한다. 서버는 GCP `demo-infra-o11y-zabbix`
(`http://<ZABBIX_SERVER_IP>`) 하나뿐이다. 로컬 Docker PoC 는 2026-09-07 에 내렸다.

## 폴더 규칙

**스크립트는 Zabbix 안에서 무엇을 만드는지로 나눈다.** 실행 순서나 시기가 아니라
결과물 기준이다 — 무언가를 고칠 때 어디를 열지가 바로 나오게 하려는 것이다.

| 폴더 | 담는 것 |
|---|---|
| `hosts/` | 호스트 등록·수정·비활성화, 자동 등록 액션 |
| `templates/` | 템플릿 생성 스크립트와 반출된 템플릿 YAML |
| `dashboards/` | 대시보드·페이지·위젯 생성, 대시보드 export/import |
| `alerts/` | 미디어 타입, 알림 액션, 메시지 템플릿, 트리거 켜고 끄기 |
| `migrate/` | 설정 전체 반출/반입. 반출된 데이터는 커밋하지 않는다 |
| `ansible/` | 에이전트·BMC 설치. 대상 서버에서 도는 것은 전부 여기 |
| `alertscripts/` | Zabbix 서버 컨테이너에 올라가는 스크립트 |

`notify/` 는 로컬 실행 로그라 커밋하지 않는다.

**새 스크립트는 위 다섯 중 하나에 넣는다.** 어디에도 안 맞으면 폴더를 새로 만들지
말고 먼저 "이게 Zabbix 안에서 뭘 만드는가"를 다시 물어본다. 대개 답이 나온다.

## 스크립트 규칙

- **비밀값은 환경변수로만 받는다.** 소스에 기본값을 두지 않는다. 자세한 것은
  [SECRETS.md](SECRETS.md)
- **Zabbix 주소 기본값은 `http://<ZABBIX_SERVER_IP>/api_jsonrpc.php`** 이고
  `ZBX_API` 로 덮어쓸 수 있다
- **여러 번 돌려도 안전하게 만든다.** 이미 있는 것은 건너뛰거나 갱신한다
- **되돌릴 수 있게 만든다.** 끄는 스크립트는 켜는 길도 같이 둔다
  (`ENABLE=1`, `REVERT=1` 처럼)
- **바꾸는 양이 많으면 `DRY_RUN=1` 을 지원한다.** `alerts/alert_noise_fix.py` 참고
- 의존성은 표준 라이브러리만 쓴다. `urllib.request` 로 충분하다

## 실행

```bash
infisical run --projectId=<INFISICAL_PROJECT_ID> \
    --env=gcp --path=/zabbix -- python3 alerts/alert_noise_fix.py
```

`infisical run --` 는 셸을 거치지 않고 바로 exec 하므로 `VAR=값` 을 뒤에 못 붙인다.
환경변수는 앞에 둔다:

```bash
DRY_RUN=1 infisical run ... -- python3 alerts/alert_noise_fix.py
```

## 알려진 빚

- 23개 스크립트가 각자 같은 `call()` 과 로그인 코드를 갖고 있다. 공용 모듈로
  빼면 20줄 남짓씩 줄지만, 지금은 전부 동작하고 있어 건드리지 않았다
