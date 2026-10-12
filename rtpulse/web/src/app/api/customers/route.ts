import { NextRequest, NextResponse } from "next/server";
import { getCustomers, createCustomer } from "@/lib/customers";
import { getActor, logAudit } from "@/lib/audit";

export async function GET() {
  return NextResponse.json(await getCustomers());
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!body.name || !body.apiUrl) {
    return NextResponse.json({ error: "name and apiUrl are required" }, { status: 400 });
  }
  const customer = await createCustomer({
    name: body.name,
    networkType: body.networkType ?? "remote",
    apiUrl: body.apiUrl,
    ip: body.ip ?? undefined,
    rtpulsePort: body.rtpulsePort ?? undefined,
    description: body.description ?? "",
    slackWebhook: body.slackWebhook ?? undefined,
    vip: body.vip ?? undefined,
    dbName: body.dbName ?? undefined,
    dbPort: body.dbPort ?? undefined,
    dbUser: body.dbUser ?? undefined,
    dbPassword: body.dbPassword ?? undefined,
    sshUser: body.sshUser ?? undefined,
    nasPath: body.nasPath ?? undefined,
    metricsLabel: body.metricsLabel ?? undefined,
  });
  await logAudit({ actor: (await getActor(req)) ?? "unknown", action: "create", target_type: "customer", target_id: customer.id, target_label: customer.name, status: "success" });
  return NextResponse.json(customer, { status: 201 });
}
