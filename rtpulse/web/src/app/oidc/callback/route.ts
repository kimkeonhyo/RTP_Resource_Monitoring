import { NextRequest, NextResponse } from "next/server";

/**
 * Azure AD에서 등록된 리디렉션 URI: https://watch.example.com/oidc/callback
 * NextAuth 실제 콜백 경로:         /api/auth/callback/azure-ad
 *
 * Azure가 /oidc/callback 으로 code + state 를 보내면
 * NextAuth 콜백으로 그대로 포워딩합니다.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const params = searchParams.toString();

  // request.url은 내부 컨테이너 주소(http://0.0.0.0:3000)를 반환하므로
  // NEXTAUTH_URL을 명시적으로 사용해 공개 URL로 리디렉션
  const baseUrl = process.env.NEXTAUTH_URL ?? request.nextUrl.origin;

  return NextResponse.redirect(
    new URL(`/api/auth/callback/azure-ad?${params}`, baseUrl)
  );
}
