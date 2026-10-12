"use client";

import { useState } from "react";

interface Term {
  name:    string;       // 한글 이름
  en?:     string;       // 영문 표기 (선택)
  what:    string;       // 무엇인가
  bad:     string;       // 높을 때 / 낮을 때 어떤 의미
  hint?:   string;       // 문제 원인 힌트
  good:    string;       // 정상 임계치
  warn:    string;       // 주의 임계치
  alert:   string;       // 비정상 임계치
}

const HEALTH_AND_CAUSE: Term[] = [
  {
    name: "Health 점수",
    en: "stream_health_score",
    what: "한 비디오 스트림의 종합 품질 점수(0~100). 네트워크/디코더/렌더링/복구 4가지 점수를 가중평균으로 합산한 값.",
    bad: "낮을수록 사용자가 영상을 제대로 못 보고 있다는 뜻이에요.",
    good: "80 이상 — 양호",
    warn: "60~79 — 주의",
    alert: "60 미만 — 나쁨",
  },
  {
    name: "원인 추정",
    en: "primary_cause",
    what: "Health 점수가 떨어졌을 때 가장 영향이 큰 원인 한 가지. 4개 부문 점수 중 가장 낮은 것이 75점 이하면 그것을 원인으로 표시.",
    bad: "이 값을 보고 어디부터 손봐야 할지 결정해요.",
    good: "양호 (모든 부문 76점 이상)",
    warn: "—",
    alert: "—",
  },
];

const METRICS: Term[] = [
  {
    name: "Loss (패킷 손실율)",
    en: "packetsLost / (received + lost)",
    what: "받았어야 할 패킷 중 잃어버린 비율. 네트워크 품질의 가장 직접적인 지표.",
    bad: "높으면 화면이 깨지거나 멈춰요. 보통 무선 신호 약함, 회선 혼잡, 방화벽 문제 등.",
    hint: "→ 네트워크 문제로 분류됨",
    good: "2% 미만",
    warn: "2~5%",
    alert: "5% 이상",
  },
  {
    name: "Jitter (지연 변동)",
    en: "jitter (초)",
    what: "패킷이 도착하는 시간 간격의 흔들림. 같은 간격으로 와야 부드러운데 들쭉날쭉하면 이 값이 커짐.",
    bad: "높으면 영상이 끊기거나 음성이 늦게 와요. 무선 환경/네트워크 정체에서 흔함.",
    hint: "→ 네트워크 문제로 분류됨",
    good: "0.03초 미만",
    warn: "0.03~0.05초",
    alert: "0.05초 이상",
  },
  {
    name: "FPS (프레임 레이트)",
    en: "framesPerSecond",
    what: "1초당 화면에 그리는 프레임 수. 카메라 송신 FPS가 30이라면 수신측도 30에 가까워야 정상.",
    bad: "낮으면 영상이 뚝뚝 끊겨 보임. 디코딩 부하 또는 패킷 손실로 프레임이 부족할 때 떨어짐.",
    hint: "→ 렌더링/GPU/CPU 문제로 분류됨",
    good: "20 이상",
    warn: "10~19",
    alert: "10 미만",
  },
  {
    name: "Freeze (정지 횟수)",
    en: "freezeCount delta",
    what: "측정 구간 동안 영상이 일시 정지한 이벤트 수. WebRTC는 1초 이상 새 프레임이 없으면 freeze로 셈.",
    bad: "많으면 사용자가 '영상이 자주 멈춘다'고 느낌. 네트워크/디코더/CPU 어디서든 원인이 될 수 있음.",
    good: "0~4 — 경미",
    warn: "20 이상 — 주의",
    alert: "50 이상 — 심각",
  },
  {
    name: "NACK (재전송 요청)",
    en: "nackCount delta",
    what: "패킷이 빠졌을 때 보낸 쪽에 '다시 보내줘' 요청한 수. WebRTC가 손실을 자체 복구하려고 시도하는 횟수.",
    bad: "많으면 네트워크 손실이 잦다는 신호. 복구 자체는 좋지만 빈번하면 문제 시그널.",
    hint: "→ 복구 점수 + 네트워크 문제 시사",
    good: "30 미만",
    warn: "30~99",
    alert: "100 이상",
  },
  {
    name: "Frames Recv / Decoded / Dropped",
    en: "framesReceived / framesDecoded / framesDropped",
    what: "받은 프레임 / 디코딩 성공 / 디코딩은 됐지만 화면에 못 그린 프레임 수 (구간 누적).",
    bad: "Decoded ≪ Received → 디코더가 못 따라가는 중. Dropped 많음 → CPU/GPU 부하.",
    hint: "→ 디코더 병목 또는 렌더링 문제 신호",
    good: "Decoded ≈ Received, Dropped 거의 0",
    warn: "Decoded < Received 90%",
    alert: "Decoded < Received 80%",
  },
  {
    name: "PktLost (패킷 손실 누적)",
    en: "packetsLost delta",
    what: "측정 구간 동안 잃어버린 패킷의 절대 수. Loss(%) 와 함께 보면 트래픽 규모 감안 가능.",
    bad: "절대값이 200을 넘으면 트래픽 규모와 무관하게 네트워크 품질에 부담.",
    good: "200 미만",
    warn: "—",
    alert: "200 이상",
  },
];

const CAUSES: Array<{ key: string; color: string; what: string; example: string }> = [
  {
    key: "네트워크 문제",
    color: "text-cyan-300",
    what: "패킷 손실(Loss) / 지터(Jitter) 가 임계치를 넘는 경우. 회선/Wi-Fi/방화벽이 의심됨.",
    example: "예: Loss 7%, Jitter 0.08s — 회선 점검 필요",
  },
  {
    key: "디코더 병목",
    color: "text-purple-300",
    what: "받은 프레임 대비 디코딩 성공률이 낮음. 코덱/디코더(SW vs HW)/CPU 부하 의심.",
    example: "예: Recv 470 vs Decoded 400 — HW 디코더 미지원, SW 폴백",
  },
  {
    key: "렌더링/GPU/CPU 문제",
    color: "text-orange-300",
    what: "FPS 낮음 / 프레임 드랍 많음 / Freeze 많음. 클라이언트 디바이스 부하·탭 백그라운드·GPU 문제 의심.",
    example: "예: FPS 11.5, Freeze 28 — 다른 창에 가려져 있거나 디바이스 노후",
  },
  {
    key: "복합/기타",
    color: "text-gray-300",
    what: "어느 한 부문도 75점 이하로 두드러지지 않음. 여러 지표가 함께 살짝 나쁜 상태.",
    example: "예: 모든 점수 80~90 — 큰 문제 없으나 모니터링 권장",
  },
];

// ────────────────────────────────────────────────────────────────────────

export default function Glossary() {
  const [open, setOpen] = useState(false);

  return (
    <section className="mt-10 border border-line rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-panel hover:bg-input/40 transition-colors"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-emerald-400">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
          </svg>
          용어 설명 / 임계치 가이드
        </span>
        <span className="text-xs text-gray-500">{open ? "▲ 접기" : "▼ 펼치기"}</span>
      </button>

      {open && (
        <div className="border-t border-line bg-panel/40 p-4 space-y-6">
          {/* Health & 원인 */}
          <Block title="🎯 Health 점수와 원인 추정" terms={HEALTH_AND_CAUSE} />

          {/* 4개 원인 */}
          <div>
            <h3 className="text-sm font-semibold text-gray-300 mb-2">🔍 4가지 원인 분류</h3>
            <div className="grid md:grid-cols-2 gap-3">
              {CAUSES.map((c) => (
                <div key={c.key} className="bg-panel border border-line rounded-lg p-3">
                  <p className={`text-xs font-semibold mb-1 ${c.color}`}>{c.key}</p>
                  <p className="text-xs text-gray-400 leading-relaxed mb-1.5">{c.what}</p>
                  <p className="text-[11px] text-gray-600 italic">{c.example}</p>
                </div>
              ))}
            </div>
          </div>

          {/* 지표 */}
          <Block title="📊 주요 지표 임계치" terms={METRICS} />

          <p className="text-[11px] text-gray-600 italic">
            * 임계치는 일반적인 권고 기준이며, 사용 환경(모바일·무선 vs 유선·서버)에 따라 다를 수 있습니다.
          </p>
        </div>
      )}
    </section>
  );
}

function Block({ title, terms }: { title: string; terms: Term[] }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-300 mb-2">{title}</h3>
      <div className="space-y-2">
        {terms.map((t) => (
          <div key={t.name} className="bg-panel border border-line rounded-lg p-3">
            <div className="flex items-baseline gap-2 mb-1.5 flex-wrap">
              <span className="text-sm font-semibold text-emerald-400">{t.name}</span>
              {t.en && <span className="text-[10px] font-mono text-gray-500">{t.en}</span>}
            </div>
            <p className="text-xs text-gray-400 leading-relaxed mb-1.5">{t.what}</p>
            <p className="text-xs text-gray-500 leading-relaxed mb-2">
              <span className="text-amber-400">▸ </span>{t.bad}
              {t.hint && <span className="text-gray-600 ml-1">{t.hint}</span>}
            </p>
            <div className="flex items-center gap-3 text-[11px] flex-wrap">
              <span className="px-2 py-0.5 rounded-full bg-emerald-900/40 text-emerald-300 border border-emerald-700/50">
                정상: {t.good}
              </span>
              {t.warn !== "—" && (
                <span className="px-2 py-0.5 rounded-full bg-amber-900/40 text-amber-300 border border-amber-700/50">
                  주의: {t.warn}
                </span>
              )}
              {t.alert !== "—" && (
                <span className="px-2 py-0.5 rounded-full bg-rose-900/40 text-rose-300 border border-rose-700/50">
                  비정상: {t.alert}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
