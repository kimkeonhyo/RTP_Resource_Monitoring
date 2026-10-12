import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // ── 도메인 색상 ─────────────────────────────────
        healthy:  "#22c55e",
        degraded: "#eab308",
        down:     "#ef4444",
        unknown:  "#6b7280",

        // ── 테마 시맨틱 토큰 ────────────────────────────
        // 사용법: bg-panel, bg-input, border-line, text-ink 등
        canvas: "rgb(var(--c-bg)   / <alpha-value>)",  // 페이지 배경
        panel:  "rgb(var(--c-panel)/ <alpha-value>)",  // 카드·패널·사이드바
        input:  "rgb(var(--c-input)/ <alpha-value>)",  // 입력·중첩 배경
        line:   "rgb(var(--c-line) / <alpha-value>)",  // 주요 테두리
        line2:  "rgb(var(--c-line2)/ <alpha-value>)",  // 보조 테두리
        ink:    "rgb(var(--c-ink)  / <alpha-value>)",  // 기본 텍스트
        ink2:   "rgb(var(--c-ink2) / <alpha-value>)",  // 보조 텍스트
        muted:  "rgb(var(--c-muted)/ <alpha-value>)",  // labels/headings
        faint:  "rgb(var(--c-faint)/ <alpha-value>)",  // secondary text
      },
    },
  },
  plugins: [],
};

export default config;
