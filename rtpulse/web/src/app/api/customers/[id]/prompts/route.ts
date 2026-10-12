import { NextRequest, NextResponse } from "next/server";
import { getCustomer } from "@/lib/customers";
import { getPromptHistory, addPromptRecord } from "@/lib/prompt-history";

type Params = { params: Promise<{ id: string }> };

export async function GET(_: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!(await getCustomer(id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(await getPromptHistory(id));
}

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!(await getCustomer(id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = await req.json();
  const result = await addPromptRecord(id, body);
  if (result.error) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json(result.row, { status: 201 });
}
