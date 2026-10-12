import { NextResponse } from "next/server";
import { getCustomers } from "@/lib/customers";
import { loadAlertState, saveAlertState } from "@/lib/alert-state";
import type { ApiStream, Customer, StreamHealth } from "@/lib/types";

/**
 * 알람 발송 임계값:
 *   - DOWN/DEGRADED 상태가 ALERT_THRESHOLD_MS 이상 지속된 경우에만 알람 발송
 *   - 수 초 단위 flicker는 알람 제외
 */
const ALERT_THRESHOLD_MS = 5 * 60 * 1000; // 5분

/** DOWN/DEGRADED 판별 헬퍼 */
const isBad = (h: string) => h === "DOWN" || h === "DEGRADED";

// ─── Slack 메시지 발송 ────────────────────────────────────────────────────────

async function sendSlack(webhookUrl: string, payload: object) {
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
}

function buildDownMessage(
  customer: Customer,
  stream: ApiStream,
  health: StreamHealth,
  badSince: number,
) {
  const isDown  = health === "DOWN";
  const emoji   = isDown ? "🔴" : "🟡";
  const label   = isDown ? "DOWN" : "DEGRADED";
  const color   = isDown ? "#e53e3e" : "#d69e2e";
  const elapsed = Math.round((Date.now() - badSince) / 60_000); // 분 단위

  return {
    attachments: [
      {
        color,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${emoji} *[${label}] ${stream.name}*\n고객사: *${customer.name}* · ${elapsed}분째 지속 중`,
            },
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*Bitrate*\n${stream.bitrate_kbps.toFixed(0)} kbps` },
              { type: "mrkdwn", text: `*Packet Loss*\n${stream.packet_loss_pct.toFixed(1)}%` },
              { type: "mrkdwn", text: `*Jitter*\n${stream.jitter_ms.toFixed(1)} ms` },
              { type: "mrkdwn", text: `*FPS*\n${stream.fps.toFixed(1)}` },
            ],
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `RTPulse · ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
              },
            ],
          },
        ],
      },
    ],
  };
}

function buildRecoveryMessage(customer: Customer, stream: ApiStream, prevHealth: string) {
  return {
    attachments: [
      {
        color: "#38a169",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `🟢 *[RECOVERED] ${stream.name}*\n고객사: *${customer.name}* · ${prevHealth} → HEALTHY`,
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `RTPulse · ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
              },
            ],
          },
        ],
      },
    ],
  };
}

// ─── Alert Check 핵심 로직 ───────────────────────────────────────────────────

export async function POST() {
  const customers = await getCustomers();
  const state     = await loadAlertState();
  const now       = Date.now();
  let alertsSent  = 0;

  for (const customer of customers) {
    if (!customer.slackWebhook) continue;

    let streams: ApiStream[];
    try {
      const res = await fetch(`${customer.apiUrl}/api/streams`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      streams = await res.json();
    } catch {
      continue; // rtpulse 미접속 — 이 고객사 스킵
    }

    for (const stream of streams) {
      const key        = `${customer.id}:${stream.id}`;
      const prev       = state.streams[key];
      const currHealth = stream.health as StreamHealth;

      // ── 초기 상태 or UNKNOWN ──
      if (currHealth === "UNKNOWN" || !prev) {
        state.streams[key] = { health: currHealth };
        continue;
      }

      const prevHealth = prev.health;

      // ── HEALTHY ──────────────────────────────────────────────────────────
      if (!isBad(currHealth)) {
        if (!isBad(prevHealth)) {
          // HEALTHY → HEALTHY: 변화 없음
          continue;
        }
        // bad → HEALTHY: 실제 알람이 나간 구간에서 회복된 경우만 RECOVERED 발송
        if (prev.alertSent) {
          try {
            await sendSlack(
              customer.slackWebhook,
              buildRecoveryMessage(customer, stream, prevHealth),
            );
            alertsSent++;
          } catch { /* Slack 실패 무시 */ }
        }
        // badSince, alertSent 초기화 — alertedAt은 보존(필요 시 참고용)
        state.streams[key] = { health: currHealth, alertedAt: prev.alertedAt };
        continue;
      }

      // ── DOWN / DEGRADED ──────────────────────────────────────────────────
      if (!isBad(prevHealth)) {
        // HEALTHY → bad: 불량 구간 시작 — 아직 알람 없음
        state.streams[key] = { health: currHealth, badSince: now, alertSent: false };
        continue;
      }

      // bad → bad (DOWN↔DEGRADED 전환 포함): badSince 유지하며 경과 시간 체크
      const badSince = prev.badSince ?? now;
      const elapsed  = now - badSince;

      if (prev.alertSent) {
        // 이미 알람 발송됨 — 상태 갱신만 (재알람 없음, 회복 시 RECOVERED 발송)
        state.streams[key] = { health: currHealth, badSince, alertedAt: prev.alertedAt, alertSent: true };
        continue;
      }

      if (elapsed >= ALERT_THRESHOLD_MS) {
        // 5분 이상 지속 → 알람 발송
        try {
          await sendSlack(
            customer.slackWebhook,
            buildDownMessage(customer, stream, currHealth, badSince),
          );
          alertsSent++;
          state.streams[key] = { health: currHealth, badSince, alertedAt: now, alertSent: true };
        } catch {
          // Slack 실패 시 alertSent=false 유지 → 다음 주기에 재시도
          state.streams[key] = { health: currHealth, badSince, alertSent: false };
        }
      } else {
        // 아직 임계값 미달 — 대기 중
        state.streams[key] = { health: currHealth, badSince, alertSent: false };
      }
    }
  }

  state.updatedAt = now;
  await saveAlertState(state);

  return NextResponse.json({ ok: true, alertsSent, checkedCustomers: customers.length });
}
