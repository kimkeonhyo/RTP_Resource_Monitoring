import { NextRequest, NextResponse } from "next/server";
import { getCustomer, updateCustomer, deleteCustomer } from "@/lib/customers";
import { getActor, logAudit } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

export async function GET(_: NextRequest, { params }: Params) {
  const { id } = await params;
  const customer = await getCustomer(id);
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(customer);
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await req.json();
  const updated = await updateCustomer(id, body);
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await logAudit({ actor: (await getActor(req)) ?? "unknown", action: "update", target_type: "customer", target_id: id, target_label: updated.name, status: "success" });
  return NextResponse.json(updated);
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const existing = await getCustomer(id);
  const ok = await deleteCustomer(id);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await logAudit({ actor: (await getActor(req)) ?? "unknown", action: "delete", target_type: "customer", target_id: id, target_label: existing?.name ?? id, status: "success" });
  return NextResponse.json({ ok: true });
}
