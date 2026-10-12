# RTP Resource Monitoring

영상 스트림(RTSP/RTP)과 서버 인프라를 함께 관제하기 위해 만든 모니터링 도구 모음입니다.
실무에서 운영하던 코드를 포트폴리오용으로 정리한 것으로, 회사·고객사 식별 정보와
비밀값, 실제 IP·호스트명은 모두 일반화(예: `site-a`, `<HOST_IP>`, `example.com`)해 두었습니다.

| 디렉터리 | 내용 |
|---|---|
| [`rtpulse/`](rtpulse/) | RTSP/RTP 스트림 상태를 실시간으로 측정하는 Rust TUI·데몬 |
| [`rtpulse/web/`](rtpulse/web/) | 여러 사이트의 rtpulse·K8s·이벤트 통계를 모아 보는 Next.js 운영 대시보드 |
| [`zabbix/`](zabbix/) | Zabbix 7.0 관제를 코드로 관리 — 템플릿·대시보드·알림·Ansible 에이전트 배포 |

---

## 1. rtpulse — RTP/RTSP 스트림 모니터

카메라·VMS 스트림이 "살아 있는지"뿐 아니라 **실제로 영상 패킷이 정상적으로 흐르는지**를 봅니다.

- **RTSP 전 과정 프로브** — `DESCRIBE → SETUP → PLAY → RTP 수집 → TEARDOWN`, Digest 인증 지원
- **실측 RTP 지표** — 비트레이트, 패킷 손실, 지터(RFC 3550), 지연, FPS(RTP marker bit 기준)
- **Healthy / Degraded / Down** 3단계 헬스 판정과 상태 전이 알림 (Slack / Generic Webhook)
- **멀티캐스트 RTP** — `mio`(epoll) 기반 배치 UDP 수신기로 다수 스트림을 한 스레드에서 처리
- **네트워크 디스커버리** — pcap 으로 RTSP/RTP 스트림을 자동 탐지해 설정 파일 생성 (옵션 기능)
- **SQLite 통계 + Excel 내보내기** — 일/7일/30일 다운 이력, `e` 키로 `.xlsx` 출력
- **HTTP API 모드** — `--api-port` 로 띄우면 웹 대시보드가 원격에서 지표를 조회하고,
  `--api-url` 을 주면 대시보드에 등록된 카메라 목록을 주기적으로 받아 자동으로 추가/삭제

```
main.rs ─▶ App(state) ◀─ MonitorHandle (tokio tasks, mpsc)
              │              ├─ monitor.rs  RTSP 프로브
              │              ├─ batch.rs    RTP 멀티캐스트 (mio)
              │              └─ capture.rs  pcap 수집 (feature)
              ├─ ui.rs       ratatui 5개 탭 (Dashboard/Overview/Detail/Logs/Stats)
              ├─ alert.rs    헬스 전이 → Slack/Webhook
              ├─ stats.rs    SQLite 다운 이력
              └─ api.rs      axum HTTP API
```

## 2. rtpulse web — 통합 운영 대시보드

원격(VPN) 사이트와 망분리(온프레미스) 사이트를 한 화면에서 관리하는 내부 운영 포털입니다.

- **사이트 대시보드** — 스트림 상태(전체/정상/경고/다운), 노드 CPU·메모리, 이벤트·탐지 통계 차트
- **사이트 상세** — 스트림 목록·헬스 뱃지, K8s 노드 상태(SSH), 카메라 등록·동기화, 영상 썸네일/다운로드(MinIO)
- **데이터 파이프라인** — 망분리 사이트의 이벤트 영상을 NAS(SFTP)로 업로드·등록, HLS → mp4 변환(ffmpeg)
- **프롬프트 / 오토 라벨링** — AI 탐지 프롬프트 버전 이력, LLM(Gemini) 기반 이벤트 자동 라벨링
- **서버실** — Zabbix API 로 서버·스위치·클라우드 VM 현황과 토폴로지를 보여주고, 신규 장비 등록 스크립트 생성
- **헬프데스크 / 유지보수** — 고객 문의 접수·처리, 정기 점검 일정과 점검표(xlsx) 관리
- **WebRTC 분석기** — `chrome://webrtc-internals` 덤프를 업로드해 손실·지터·프레임 드롭 원인을 점수화

## 3. zabbix — 인프라 관제 as Code

GPU 서버·워크스테이션·NAS·스위치·BMC·클라우드 VM·원격 사이트를 Zabbix 하나로 관제합니다.
설정은 웹 UI 에서 손으로 만들지 않고 **Zabbix API 를 호출하는 멱등 스크립트**로 만듭니다.

| 폴더 | 하는 일 |
|---|---|
| `hosts/` | 호스트 등록·동기화 (Ansible 인벤토리 / NetBox 기준), 자동 등록 액션 |
| `templates/` | NVIDIA GPU, Mobilint NPU, Synology/ASUSTOR NAS, Netgear 스위치, BMC(IPMI) 템플릿 |
| `dashboards/` | 서버·네트워크 관제 대시보드, 토폴로지 맵 생성 |
| `alerts/` | 알림 액션·한글 메시지 템플릿·노이즈 억제(다운만 알림, 임계 조정), Teams 연동 |
| `ansible/` | Zabbix Agent2 설치(온프렘 Ubuntu / GCP Ubuntu·Rocky), BMC 관제 계정 생성, Tailscale 경로 점검 |
| `migrate/` | 설정 전체 export/import |

설계 원칙: 비밀값은 환경변수로만 받기, 여러 번 돌려도 안전(멱등), `DRY_RUN=1` / `REVERT=1` 지원,
의존성은 Python 표준 라이브러리만 사용. 자세한 내용은 [`zabbix/README.md`](zabbix/README.md),
필요한 비밀값 목록은 [`zabbix/SECRETS.md`](zabbix/SECRETS.md) 참고.

---

## 기술 스택

| 영역 | 사용 기술 |
|---|---|
| 스트림 모니터 | Rust (edition 2024), tokio, mio, ratatui, axum, reqwest, rusqlite, rust_xlsxwriter, pcap |
| 웹 대시보드 | Next.js 16 (App Router), TypeScript, Tailwind CSS, Recharts, SWR, NextAuth (Azure AD OIDC) |
| 데이터 | PostgreSQL, MySQL, MinIO, SFTP(NAS), Notion API |
| 관제 | Zabbix 7.0, SNMP v2c, IPMI, NetBox, VictoriaMetrics / Grafana |
| 인프라 | Ansible (+ Vault), GCP, Docker, Tailscale / Headscale |

## 디렉터리 구조

```
.
├── rtpulse/
│   ├── src/                 # Rust TUI / 데몬
│   ├── docs/LAYOUT.md       # 화면·아키텍처 설명
│   ├── config.example.yaml  # 스트림 설정 예시
│   ├── alerts.yaml          # 알림 설정 예시
│   └── web/                 # Next.js 대시보드
│       ├── src/app/         #   페이지 + API 라우트
│       ├── src/components/
│       └── src/lib/
└── zabbix/
    ├── hosts/ templates/ dashboards/ alerts/ migrate/   # Zabbix API 스크립트 (Python)
    ├── alertscripts/        # Zabbix 서버용 알림 스크립트
    └── ansible/             # 에이전트·BMC 배포
```

## 실행 방법

### rtpulse (TUI)

```bash
cd rtpulse
cargo run --release -- --demo                     # 시뮬레이션 스트림으로 화면 확인
cargo run --release -- -c config.example.yaml     # 설정 파일로 실제 스트림 모니터링
cargo run --release -- -s rtsp://user:pass@<CAMERA_IP>:554/live
cargo run --release -- -c config.yaml --api-port 9999   # 대시보드 연동용 HTTP API

# pcap 기반 수집/디스커버리 (libpcap 필요)
cargo run --release --features pcap-capture -- discover -I eth0 -d 30
```

### rtpulse web

```bash
cd rtpulse/web
cp .env.local.example .env.local   # DB·인증 등 값 채우기 (선택 기능은 비워 두면 비활성)
npm install
npm run dev                        # http://localhost:3000
```

PostgreSQL 이 필요하며, 테이블은 첫 기동 시 자동 생성됩니다. Docker 이미지는 `rtpulse/web/Dockerfile` 로 빌드합니다.

### zabbix

```bash
cd zabbix
export ZBX_API=http://<zabbix-host>/api_jsonrpc.php ZBX_PASS=<password>
DRY_RUN=1 python3 alerts/alert_noise_fix.py      # 변경 미리 보기
python3 hosts/internal_sync.py                    # 인벤토리 기준 호스트 동기화

cd ansible
ansible-playbook playbooks/install-zabbix-agent.yml --ask-vault-pass --limit <host>
```
