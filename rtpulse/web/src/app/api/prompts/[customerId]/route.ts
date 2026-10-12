import { NextRequest, NextResponse } from "next/server";
import { getPrompts, addPrompt, filesDir } from "@/lib/prompts";
import { getCustomer } from "@/lib/customers";
import path from "path";
import fs from "fs";

type Params = { params: Promise<{ customerId: string }> };

export async function GET(_: NextRequest, { params }: Params) {
  const { customerId } = await params;
  return NextResponse.json(getPrompts(customerId));
}

// POST: multipart/form-data — 파일 + 메타데이터 업로드
export async function POST(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  if (!getCustomer(customerId))
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const meta = {
    title: String(formData.get("title") ?? ""),
    version: String(formData.get("version") ?? ""),
    f1Score: formData.get("f1Score") ? Number(formData.get("f1Score")) : undefined,
    appliedOnSite: formData.get("appliedOnSite") === "true",
    appliedAt: formData.get("appliedAt") ? String(formData.get("appliedAt")) : undefined,
    tuner: String(formData.get("tuner") ?? ""),
    purpose: String(formData.get("purpose") ?? ""),
    inUse: formData.get("inUse") === "true",
    fileName: "",
  };

  // 파일 저장
  if (file) {
    const buf = Buffer.from(await file.arrayBuffer());
    const saveName = `${Date.now()}_${file.name}`;
    fs.writeFileSync(path.join(filesDir(customerId), saveName), buf);
    meta.fileName = saveName;
    if (!meta.title) meta.title = file.name;
  } else {
    meta.fileName = `${Date.now()}_${meta.title}`;
  }

  const record = addPrompt(customerId, meta);
  return NextResponse.json(record, { status: 201 });
}
