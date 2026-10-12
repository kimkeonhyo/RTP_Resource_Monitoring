import { promises as fs } from "fs";
import path from "path";

export interface StreamAlertState {
  health:     string;
  alertedAt?: number;  // epoch ms — 마지막 DOWN/DEGRADED 알람 발송 시각
  badSince?:  number;  // epoch ms — 현재 불량 상태(DOWN/DEGRADED) 진입 시각
  alertSent?: boolean; // 현재 불량 구간에서 알람이 실제로 나갔으면 true
}

export interface AlertState {
  streams: Record<string, StreamAlertState>; // key: `${customerId}:${streamId}`
  updatedAt: number;
}

const STATE_PATH = path.join(process.cwd(), "data", "alert-state.json");

export async function loadAlertState(): Promise<AlertState> {
  try {
    const data = await fs.readFile(STATE_PATH, "utf-8");
    return JSON.parse(data);
  } catch {
    return { streams: {}, updatedAt: 0 };
  }
}

export async function saveAlertState(state: AlertState): Promise<void> {
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}
