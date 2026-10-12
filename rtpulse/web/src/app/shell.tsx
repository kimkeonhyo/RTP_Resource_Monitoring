"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import Sidebar from "@/components/sidebar";

/**
 * 앱 공통 껍데기(사이드바 + Chatwoot 위젯)를 렌더링한다.
 * 단, /complain/embed (Chatwoot 사이드패널 임베드)는 카드만 단독 표시해야 하므로
 * 사이드바·라이브챗 위젯 없이 children만 렌더링한다.
 */
const CHATWOOT_URL   = process.env.NEXT_PUBLIC_CHATWOOT_URL;
const CHATWOOT_TOKEN = process.env.NEXT_PUBLIC_CHATWOOT_TOKEN;

export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isEmbed = pathname?.startsWith("/complain/embed");

  if (isEmbed) {
    return <main className="flex-1 overflow-y-auto">{children}</main>;
  }

  return (
    <>
      <Sidebar />
      <main className="flex-1 overflow-y-auto">{children}</main>

      {/* Chatwoot 라이브 채팅 위젯 (임베드 화면에서는 로드하지 않음, 환경변수 미설정 시 비활성) */}
      {CHATWOOT_URL && CHATWOOT_TOKEN && <Script id="chatwoot-sdk" strategy="afterInteractive">
        {`
          (function(d,t) {
            var BASE_URL=${JSON.stringify(CHATWOOT_URL)};
            var g=d.createElement(t),s=d.getElementsByTagName(t)[0];
            g.src=BASE_URL+"/packs/js/sdk.js";
            g.async=true;
            s.parentNode.insertBefore(g,s);
            g.onload=function(){
              window.chatwootSDK.run({
                websiteToken: ${JSON.stringify(CHATWOOT_TOKEN)},
                baseUrl: BASE_URL
              })
            }
          })(document,"script");
        `}
      </Script>}
    </>
  );
}
