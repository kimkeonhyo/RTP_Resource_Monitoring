import { NextRequest, NextResponse } from "next/server";
import { getCustomer } from "@/lib/customers";
import { getCustomerStatus } from "@/lib/rtpulse-client";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/customers/{id}/ping
 * 고객사 rtpulse API 연결 상태를 즉시 재확인합니다.
 */
export async function POST(_: NextRequest, { params }: Params) {
  const { id } = await params;
  const customer = await getCustomer(id);
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const status = await getCustomerStatus(customer);
  return NextResponse.json(status);
}
