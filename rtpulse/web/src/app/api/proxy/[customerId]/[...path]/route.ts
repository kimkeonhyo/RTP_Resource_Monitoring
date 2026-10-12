import { NextRequest, NextResponse } from "next/server";
import { getCustomer } from "@/lib/customers";

type Params = { params: Promise<{ customerId: string; path: string[] }> };

async function proxyRequest(req: NextRequest, { params }: Params, method: string) {
  const { customerId, path } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const targetPath = "/" + path.join("/");
  const search = req.nextUrl.search;
  const targetUrl = `${customer.apiUrl.replace(/\/$/, "")}${targetPath}${search}`;

  try {
    // rtpulse 미도달/무응답 시 outbound fetch가 무한정 대기하며 쌓이면
    // 소켓·메모리를 소진해 앱이 죽을 수 있다 → 타임아웃으로 빠르게 실패.
    // (GET 지표는 짧게, POST(등록 등)는 여유 있게)
    const timeoutMs = method === "POST" ? 30_000 : 8_000;
    const fetchOptions: RequestInit = { method, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) };
    if (method === "POST") {
      const body = await req.text();
      fetchOptions.body = body;
      fetchOptions.headers = { "Content-Type": "application/json" };
    }
    const res = await fetch(targetUrl, fetchOptions);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e: unknown) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return NextResponse.json(
      { error: "Failed to reach rtpulse instance", detail: String(e), timeout: timedOut },
      { status: 502 }
    );
  }
}

export async function GET(req: NextRequest, ctx: Params) {
  return proxyRequest(req, ctx, "GET");
}

export async function POST(req: NextRequest, ctx: Params) {
  return proxyRequest(req, ctx, "POST");
}

export async function DELETE(req: NextRequest, ctx: Params) {
  return proxyRequest(req, ctx, "DELETE");
}
