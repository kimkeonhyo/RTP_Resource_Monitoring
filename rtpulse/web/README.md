# RTPulse Web

> **VMS(영상관제) 고객사 통합 모니터링 대시보드**  
> 원격 고객사의 AI 영상분석 스트림 상태, K8s 클러스터 리소스, 이벤트·탐지 통계를 한 화면에서 관리합니다.

---

## 주요 기능

### 🖥 통합 대시보드
- **고객사 카드** — 스트림 상태 (전체 / 정상 / 경고 / 다운), CPU · Memory 사용률 바
- **이벤트 통계** — 고객사별 이벤트 등록 건수를 일/주/월 단위 스택 바 차트로 집계
- **탐지결과 통계** — 고객사별 AI 탐지 건수를 일/주/월 단위로 집계

### 📡 고객사 유형별 모니터링

| 구분 | 네트워크 | 데이터 수집 방법 |
|------|---------|----------------|
| **원격 고객사** | VPN (Headscale) | rtpulse API → 실시간 스트림 지표 |
| **온프레미스 고객사** | 망분리 | NAS SSH 업로드 → 이벤트 등록 |

### 📊 고객사 상세
- **스트림 현황** — 전체 스트림 목록, 개별 헬스 뱃지 (Healthy / Degraded / Down)
- **Status Watch** — K8s 노드 CPU · Memory · Disk · 네트워크 실시간 모니터링 (SSH 기반)
- **Data Watch** — 탐지결과 조회, 이벤트 통계 차트, 영상 썸네일 · 다운로드
- **카메라 관리** — 카메라 목록 동기화 및 설정
- **프롬프트 관리** — 고객사별 AI 프롬프트 버전 이력

### 📋 Complain
고객 불만 사례를 등록·조회하고 파일을 첨부하는 인터널 이슈 트래커

### 🤖 Prompt
- **프롬프트 레코드** — NAS 업로드 이력, 버전별 활성화 상태 관리
- **CSV → JSON 변환기** — 프롬프트 데이터 포맷 변환 도구

---

## 기술 스택

| 영역 | 기술 |
|------|------|
| Framework | [Next.js 16](https://nextjs.org/) (App Router, Standalone) |
| Language | TypeScript 5 |
| Styling | Tailwind CSS |
| Charts | Recharts |
| Auth | NextAuth v4 (OIDC / Credentials) |
| Main DB | PostgreSQL (`pg`) |
| Customer DB | MySQL (`mysql2`) |
| Object Storage | MinIO |
| SSH | ssh2 |
| Runtime | Node.js 20 |

---

## 환경 변수

`.env.local` 파일을 생성하고 아래 변수를 설정하세요.

```env
# NextAuth
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=your-secret

# PostgreSQL (RTPulse 메인 DB)
DATABASE_URL=postgresql://user:password@host:5432/rtpulse

# MinIO (영상 오브젝트 스토리지)
MINIO_ENDPOINT=minio.internal
MINIO_ACCESS_KEY=access-key
MINIO_SECRET_KEY=secret-key

# Microsoft Teams / Azure (Complain 알림)
AZURE_TENANT_ID=...
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
```

---

## 개발 시작

```bash
# 환경 변수 준비 (전체 목록은 .env.local.example 참고)
cp .env.local.example .env.local

# 의존성 설치
npm install

# 개발 서버 실행 (http://localhost:3000)
npm run dev

# 타입 체크
npx tsc --noEmit

# 프로덕션 빌드
npm run build
npm run start
```

---

## Docker 배포

```bash
# 이미지 빌드
docker build -t rtpulse-web .

# 실행
docker run -d \
  --name rtpulse-web \
  -p 3000:3000 \
  --env-file .env.local \
  -v /data/rtpulse:/app/data \
  rtpulse-web
```

> **ffmpeg** 포함 — NAS 업로드 HLS → mp4 변환 파이프라인에 사용됩니다.

---

## 프로젝트 구조

```
src/
├── app/
│   ├── page.tsx                     # 통합 대시보드
│   ├── customers/[id]/page.tsx      # 고객사 상세
│   ├── complain/                    # 고객 불만 관리
│   ├── prompt/                      # 프롬프트 관리
│   └── api/
│       ├── customers/               # 고객사 CRUD, K8s 상태
│       ├── db/[customerId]/         # 원격 DB 통계 조회
│       ├── nas/[customerId]/        # NAS 파일 업로드·조회
│       ├── minio/[customerId]/      # MinIO 영상·썸네일
│       ├── proxy/[customerId]/      # rtpulse API 프록시
│       └── prompt-records/          # 프롬프트 레코드 CRUD
├── components/
│   ├── dashboard/                   # 통합 대시보드 컴포넌트
│   ├── customer-detail/             # 원격 고객사 상세 탭
│   ├── onprem-detail/               # 온프레미스 고객사 상세 탭
│   ├── data-watch/                  # 탐지·이벤트 데이터 뷰어
│   ├── complain/                    # 불만 목록·상세
│   ├── prompt/                      # 프롬프트 레코드·변환기
│   └── sidebar.tsx                  # 글로벌 사이드바
└── lib/
    ├── customers.ts                 # 고객사 CRUD (PostgreSQL)
    ├── types.ts                     # 공용 타입 정의
    ├── db.ts                        # PostgreSQL 연결 풀
    └── rtpulse-client.ts            # rtpulse API 클라이언트
```

---

## API 엔드포인트 요약

| 경로 | 설명 |
|------|------|
| `GET /api/customers` | 고객사 목록 |
| `GET /api/customers/[id]/k8s-status` | K8s 노드·시스템 메트릭 (SSH) |
| `POST /api/customers/[id]/ping` | 연결 상태 재확인 |
| `POST /api/db/[id]/stats` | 원격 DB 이벤트 통계 |
| `POST /api/nas/[id]/event-stats` | NAS 기반 이벤트 통계 (온프레미스) |
| `POST /api/nas/[id]/upload` | NAS 파일 업로드 |
| `GET /api/minio/[id]/thumbnail` | MinIO 썸네일 |
| `GET /api/minio/[id]/video` | MinIO 영상 스트리밍 |
| `GET/POST /api/proxy/[id]/[...path]` | rtpulse API 프록시 |

---

## 관련 프로젝트

- **[rtpulse](../README.md)** — 고객사 서버에 설치되는 RTP/RTSP 스트림 모니터링 TUI (Rust)
