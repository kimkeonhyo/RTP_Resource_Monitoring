"use client";

import { signIn } from "next-auth/react";
import Image from "next/image";

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center">
      <div className="bg-panel border border-line rounded-2xl p-10 w-80 flex flex-col items-center gap-6 shadow-2xl">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <Image src="/logo.svg" alt="RTPulse" width={80} height={32} className="object-contain" />
          <span className="font-semibold text-cyan-400 text-sm tracking-wide">Watch</span>
        </div>

        <div className="text-center space-y-1">
          <p className="text-ink font-semibold text-base">로그인</p>
          <p className="text-faint text-xs">Microsoft 계정으로 계속하세요</p>
        </div>

        {/* Microsoft sign-in button */}
        <button
          onClick={() => signIn("azure-ad", { callbackUrl: "/" })}
          className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-[#0078d4] hover:bg-[#006cbd] active:bg-[#005fa3] text-white rounded-xl transition-colors font-medium text-sm"
        >
          {/* Microsoft logo */}
          <svg width="20" height="20" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="1" y="1" width="9" height="9" fill="#F25022" />
            <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
            <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
            <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
          </svg>
          Microsoft로 로그인
        </button>

        <p className="text-faint text-xs text-center">
          조직 계정만 접근 가능합니다
        </p>
      </div>
    </div>
  );
}
