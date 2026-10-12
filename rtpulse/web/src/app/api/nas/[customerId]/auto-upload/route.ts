import { NextRequest, NextResponse } from "next/server";
import { getCustomer } from "@/lib/customers";
import { getAutoUploadConfig, saveAutoUploadConfig, runNasAutoUploadForCustomer } from "@/lib/nas-auto-upload";

type Params = { params: Promise<{ customerId: string }> };

/**
 * GET /api/nas/{customerId}/auto-upload
 * 자동 업로드 설정 + 상태 조회
 */
export async function GET(_: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const config = await getAutoUploadConfig(customerId);
  if (!config.nasSubPath) config.nasSubPath = customer.name;
  return NextResponse.json(config);
}

/**
 * PUT /api/nas/{customerId}/auto-upload
 * Body: Partial<AutoUploadConfig>  (enabled, intervalHours, nasSubPath, resetLastRunAt)
 */
export async function PUT(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json() as {
    enabled?: boolean; intervalHours?: number; nasSubPath?: string;
    lastRunAt?: string | null;   // 직접 지정 (초기화 시 과거 날짜 설정용)
    resetLastRunAt?: boolean;    // true → lastRunAt = null
  };
  const current = await getAutoUploadConfig(customerId);
  if (!current.nasSubPath) current.nasSubPath = customer.name;

  await saveAutoUploadConfig(customerId, {
    ...current,
    ...(body.enabled        !== undefined ? { enabled:        body.enabled }        : {}),
    ...(body.intervalHours  !== undefined ? { intervalHours:  body.intervalHours }  : {}),
    ...(body.nasSubPath     !== undefined ? { nasSubPath:      body.nasSubPath }     : {}),
    ...("lastRunAt" in body               ? { lastRunAt: body.lastRunAt ?? null, lastResult: null } : {}),
    ...(body.resetLastRunAt               ? { lastRunAt: null, lastResult: null, isRunning: false } : {}),
  });

  return NextResponse.json({ ok: true });
}

/**
 * POST /api/nas/{customerId}/auto-upload
 * "지금 실행" 버튼 — HTTP self-call 없이 직접 함수 호출
 */
export async function POST(_: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const result = await runNasAutoUploadForCustomer(customerId);
  const status = result.ok ? 200 : (result.error === "고객사 없음" ? 404 : 500);
  return NextResponse.json(result, { status });
}
