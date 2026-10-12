import { withAuth } from "next-auth/middleware";

export default withAuth({
  pages: {
    signIn: "/login",
  },
});

export const config = {
  // /login, /api/auth/*, /api/alert-check(내부 호출), 정적 자산 제외하고 모두 보호.
  // /api/cameras/{customerId}/config 는 rtpulse 폴러가 인증 없이 접근해야 하므로 제외.
  matcher: [
    // 파일 업로드 경로는 Edge 미들웨어에서 제외 — multipart body 파괴 방지
    // api/prompt-records/upload (신규 등록)
    // api/prompt-records/{id}/upload (기존 레코드 파일 추가)
    "/((?!login|api/auth|api/health|oidc/callback|api/alert-check|api/helpdesk/ingest|api/helpdesk/card|complain/embed|api/cameras/[^/]+/config|api/prompt-records/upload|api/prompt-records/[^/]+/upload|_next/static|_next/image|logo\\.svg|favicon\\.ico).*)",
  ],
};
