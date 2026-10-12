import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import Shell from "./shell";

export const metadata: Metadata = {
  title: "RTPulse",
  description: "RTSP/RTP stream monitoring dashboard",
  icons: {
    icon: "/logo.svg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: 서버·클라이언트 간 html class 불일치 억제
    <html lang="ko" suppressHydrationWarning>
      <body className="flex h-screen overflow-hidden bg-canvas">
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
