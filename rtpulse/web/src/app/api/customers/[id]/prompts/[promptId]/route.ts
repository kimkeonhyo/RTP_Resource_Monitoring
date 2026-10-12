import { NextRequest, NextResponse } from "next/server";
import { deletePromptRecord, setActivePrompt, unsetActivePrompt } from "@/lib/prompt-history";

type Params = { params: Promise<{ id: string; promptId: string }> };

export async function DELETE(_: NextRequest, { params }: Params) {
  const { id, promptId } = await params;
  const ok = await deletePromptRecord(id, Number(promptId));
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/** PATCH /api/customers/[id]/prompts/[promptId]
 *  Body: { active: true }  → 이 버전을 사용 중으로 설정 (나머지 해제)
 *  Body: { active: false } → 사용 해제
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id, promptId } = await params;
  const { active } = await req.json() as { active: boolean };

  if (active) {
    const ok = await setActivePrompt(id, Number(promptId));
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  } else {
    await unsetActivePrompt(id, Number(promptId));
  }

  return NextResponse.json({ ok: true });
}
