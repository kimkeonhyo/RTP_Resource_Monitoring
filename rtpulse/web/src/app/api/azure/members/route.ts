import { NextResponse } from "next/server";

export const runtime = "nodejs";

interface AzureUser {
  subjectKind: string;
  displayName: string;
  mailAddress: string;
  descriptor: string;
}

interface AzureGraphResponse {
  value: AzureUser[];
}

// Azure DevOps Graph API → 실패 시 Identities API 로 폴백
export async function GET() {
  const org = process.env.AZURE_DEVOPS_ORG;
  const pat = process.env.AZURE_DEVOPS_PAT;

  if (!org || !pat) {
    return NextResponse.json({
      members: [],
      error: "AZURE_DEVOPS_ORG 또는 AZURE_DEVOPS_PAT 환경변수 미설정",
    });
  }

  const token = Buffer.from(`:${pat}`).toString("base64");
  const headers = {
    Authorization: `Basic ${token}`,
    "Content-Type": "application/json",
  };

  // ── 1차 시도: Graph API (vso.graph 권한 필요) ──────────────────────────────
  try {
    const res = await fetch(
      `https://vssps.dev.azure.com/${org}/_apis/graph/users?api-version=7.1-preview.1`,
      { headers, cache: "no-store" }
    );

    if (res.ok) {
      const data = await res.json() as AzureGraphResponse;
      const members = (data.value ?? [])
        .filter((u) => u.subjectKind === "user" && u.displayName)
        .map((u) => ({
          subjectKind: u.subjectKind,
          displayName: u.displayName,
          mailAddress: u.mailAddress ?? "",
          descriptor: u.descriptor,
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName, "ko"));
      return NextResponse.json({ members });
    }

    const errText = await res.text();
    // 권한 부족(401/403)이면 Identities API 로 폴백
    if (res.status !== 401 && res.status !== 403) {
      return NextResponse.json({
        members: [],
        error: `Graph API ${res.status}: ${errText.slice(0, 200)}`,
      });
    }
  } catch {
    // 네트워크 오류 시도 → 폴백
  }

  // ── 2차 시도: Identities API (vso.identity 권한, 더 낮은 scope) ─────────────
  try {
    const res = await fetch(
      `https://vssps.dev.azure.com/${org}/_apis/identities?searchFilter=General&filterValue=&queryMembership=None&api-version=6.0`,
      { headers, cache: "no-store" }
    );

    if (res.ok) {
      const data = await res.json() as { value: { providerDisplayName: string; subjectDescriptor: string; properties?: { Mail?: { $value?: string } } }[] };
      const members = (data.value ?? [])
        .filter((u) => u.providerDisplayName && !u.providerDisplayName.startsWith("["))
        .map((u) => ({
          subjectKind: "user",
          displayName: u.providerDisplayName,
          mailAddress: u.properties?.Mail?.$value ?? "",
          descriptor: u.subjectDescriptor ?? u.providerDisplayName,
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName, "ko"));
      return NextResponse.json({ members });
    }

    const errText = await res.text();
    return NextResponse.json({
      members: [],
      error: `Identities API ${res.status}: ${errText.slice(0, 200)}`,
    });
  } catch (e) {
    return NextResponse.json({
      members: [],
      error: `요청 실패: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
