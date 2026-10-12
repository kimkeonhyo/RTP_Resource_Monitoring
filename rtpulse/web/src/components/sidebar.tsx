"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { useSession, signOut } from "next-auth/react";
import { useTheme } from "@/lib/theme";
import { Customer } from "@/lib/types";
import clsx from "clsx";

type ConnStatus = "checking" | "ok" | "error";

export default function Sidebar() {
  const pathname                  = usePathname();
  const router                    = useRouter();
  const { data: session }         = useSession();
  const { theme, toggle: toggleTheme } = useTheme();

  const [customers,   setCustomers]   = useState<Customer[]>([]);
  const [deletingId,  setDeletingId]  = useState<string | null>(null);
  const [conn,        setConn]        = useState<Record<string, ConnStatus>>({});
  const [collapsed,   setCollapsed]   = useState(false);

  // 사이드바 접힘 상태를 localStorage에 유지
  useEffect(() => {
    const saved = localStorage.getItem("sidebar-collapsed");
    if (saved === "true") setCollapsed(true);
  }, []);

  const toggleCollapse = () =>
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("sidebar-collapsed", String(next));
      return next;
    });

  // 원격 고객사 통신 상태 체크
  const checkConnectivity = useCallback(async (remoteCustomers: Customer[]) => {
    if (remoteCustomers.length === 0) return;
    setConn((prev) => {
      const next = { ...prev };
      for (const c of remoteCustomers) next[c.id] = "checking";
      return next;
    });
    await Promise.all(
      remoteCustomers.map(async (c) => {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        try {
          const res = await fetch(`/api/proxy/${c.id}/api/info`, { signal: ctrl.signal, cache: "no-store" });
          setConn((prev) => ({ ...prev, [c.id]: res.ok ? "ok" : "error" }));
        } catch {
          setConn((prev) => ({ ...prev, [c.id]: "error" }));
        } finally {
          clearTimeout(timer);
        }
      }),
    );
  }, []);

  useEffect(() => {
    fetch("/api/customers")
      .then((r) => r.json())
      .then((list: Customer[]) => {
        setCustomers(list);
        checkConnectivity(list.filter((c) => (c.networkType ?? "remote") === "remote"));
      })
      .catch(console.error);
  }, [pathname, checkConnectivity]);

  async function handleDelete(e: React.MouseEvent, id: string, name: string) {
    e.preventDefault(); e.stopPropagation();
    if (!confirm(`"${name}"을(를) 삭제하시겠습니까?`)) return;
    setDeletingId(id);
    await fetch(`/api/customers/${id}`, { method: "DELETE" });
    setCustomers((prev) => prev.filter((c) => c.id !== id));
    setDeletingId(null);
    if (pathname.startsWith(`/customers/${id}`)) router.push("/");
  }

  const remoteCustomers = customers.filter((c) => (c.networkType ?? "remote") === "remote");
  const onpremCustomers = customers.filter((c) => c.networkType === "onprem");

  return (
    <aside
      className={clsx(
        "flex-shrink-0 bg-panel border-r border-line flex flex-col transition-all duration-200",
        collapsed ? "w-14" : "w-56",
      )}
    >
      {/* ── 로고 + 접기 버튼 ── */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-line">
        {!collapsed && (
          <Link
            href="/"
            className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-input transition-colors group"
          >
            <Image src="/logo.svg" alt="RTPulse" width={72} height={28} className="object-contain" />
            <span className="font-semibold text-cyan-500 text-xs tracking-wide group-hover:text-cyan-400 transition-colors">
              Watch
            </span>
          </Link>
        )}
        {collapsed && (
          <Link href="/" className="mx-auto p-1.5 rounded-lg hover:bg-input transition-colors">
            <Image src="/logo.svg" alt="RTPulse" width={28} height={28} className="object-contain" />
          </Link>
        )}
        <button
          onClick={toggleCollapse}
          className={clsx(
            "p-1.5 rounded-lg text-muted hover:bg-input hover:text-ink transition-colors",
            collapsed && "mx-auto",
          )}
          title={collapsed ? "사이드바 펼치기" : "사이드바 접기"}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            {collapsed
              ? <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              : <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            }
          </svg>
        </button>
      </div>

      {/* ── Nav ── */}
      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-1">

        {/* MONITORING */}
        <MonitoringSection
          collapsed={collapsed}
          remoteCustomers={remoteCustomers}
          onpremCustomers={onpremCustomers}
          pathname={pathname}
          deletingId={deletingId}
          onDelete={handleDelete}
          connMap={conn}
        />

        {/* 인프라 구성도 — 최상위 메뉴 */}
        <NavItem
          href="/serverroom/topology"
          active={pathname.startsWith("/serverroom/topology")}
          collapsed={collapsed}
          label="인프라 구성도"
          icon={
            <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z" />
            </svg>
          }
          activeClass="bg-indigo-900/40 text-indigo-300"
          inactiveClass="text-indigo-400 hover:bg-indigo-900/20 hover:text-indigo-300"
        />

        {/* HELPDESK */}
        <HelpdeskSection collapsed={collapsed} pathname={pathname} />

        {/* PROMPT */}
        <PromptSection
          collapsed={collapsed}
          pathname={pathname}
        />

      </nav>

      {/* ── 활동 로그 ── */}
      {!collapsed && (
        <div className="px-3 pt-2 border-t border-line">
          <Link
            href="/logs"
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-faint hover:text-ink hover:bg-input transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
            </svg>
            <span>활동 로그</span>
          </Link>
        </div>
      )}

      {/* ── 고객사 등록 ── */}
      {!collapsed && (
        <div className="px-3 py-2">
          <Link
            href="/customers/new"
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-cyan-500 hover:bg-input transition-colors"
          >
            <span>+</span>
            <span>고객사 등록</span>
          </Link>
        </div>
      )}

      {/* ── 사용자 정보 ── */}
      {session?.user && (
        <div className="px-3 py-3 border-t border-line">
          <div className={clsx("flex items-center gap-2", collapsed ? "justify-center flex-col" : "px-2")}>
            {/* 아바타 */}
            <div className="w-6 h-6 rounded-full bg-cyan-800 flex items-center justify-center text-xs text-white font-semibold flex-shrink-0">
              {(session.user.name ?? session.user.email ?? "U")[0].toUpperCase()}
            </div>

            {!collapsed && (
              <span className="text-xs text-muted truncate flex-1 min-w-0">
                {session.user.name ?? session.user.email}
              </span>
            )}

            {/* 테마 토글 */}
            <button
              onClick={toggleTheme}
              title={theme === "dark" ? "라이트 모드로 전환" : "다크 모드로 전환"}
              className="text-muted hover:text-ink transition-colors p-1 flex-shrink-0 rounded"
            >
              {theme === "dark" ? (
                /* 태양 아이콘 */
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
                </svg>
              ) : (
                /* 달 아이콘 */
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
                </svg>
              )}
            </button>

            {/* 로그아웃 */}
            <button
              onClick={() => signOut({ callbackUrl: "/login" })}
              title="로그아웃"
              className="text-muted hover:text-ink transition-colors p-1 flex-shrink-0 rounded"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

// ── 범용 NavItem ─────────────────────────────────────────────────────────────

function NavItem({
  href, active, collapsed, label, icon, activeClass, inactiveClass,
}: {
  href:          string;
  active:        boolean;
  collapsed:     boolean;
  label:         string;
  icon:          React.ReactNode;
  activeClass:   string;
  inactiveClass: string;
}) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      className={clsx(
        "flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors",
        collapsed && "justify-center",
        active ? activeClass : inactiveClass,
      )}
    >
      {icon}
      {!collapsed && (
        <span className="text-xs font-semibold uppercase tracking-wider">{label}</span>
      )}
    </Link>
  );
}

// ── MONITORING 섹션 ─────────────────────────────────────────────────────────

function MonitoringSection({
  collapsed,
  remoteCustomers, onpremCustomers,
  pathname, deletingId, onDelete, connMap,
}: {
  collapsed:       boolean;
  remoteCustomers: Customer[];
  onpremCustomers: Customer[];
  pathname:        string;
  deletingId:      string | null;
  onDelete:        (e: React.MouseEvent, id: string, name: string) => void;
  connMap:         Record<string, ConnStatus>;
}) {
  const [open, setOpen] = useState(true);
  const [infraOpen, setInfraOpen] = useState(true);
  // 인프라 구성도(/serverroom/topology)는 최상위 메뉴로 분리했으므로 Monitoring 활성에서 제외
  const inServerroom = pathname.startsWith("/serverroom") && !pathname.startsWith("/serverroom/topology");
  const isActive = pathname.startsWith("/customers") || pathname === "/"
                || pathname.startsWith("/webrtc") || inServerroom;

  if (collapsed) {
    return (
      <Link
        href="/"
        title="Monitoring"
        className={clsx(
          "flex justify-center px-3 py-2 rounded-lg transition-colors",
          isActive ? "bg-blue-900/40 text-blue-300" : "text-blue-400 hover:bg-blue-900/20 hover:text-blue-300",
        )}
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0H3" />
        </svg>
      </Link>
    );
  }

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          "w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-semibold transition-colors",
          isActive ? "bg-blue-900/40 text-blue-300" : "text-blue-400 hover:bg-blue-900/20 hover:text-blue-300",
        )}
      >
        <span className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0H3" />
          </svg>
          <span className="text-xs font-semibold uppercase tracking-wider">Monitoring</span>
        </span>
        <svg
          className={`w-3 h-3 transition-transform duration-150 ${open ? "" : "-rotate-90"}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="ml-2 pl-2 border-l border-line mt-1 space-y-0.5">
          <CustomerGroup
            title="원격 고객사"
            customers={remoteCustomers}
            pathname={pathname}
            deletingId={deletingId}
            onDelete={onDelete}
            connMap={connMap}
            accent="cyan"
          />
          <CustomerGroup
            title="폐쇄망 고객사"
            customers={onpremCustomers}
            pathname={pathname}
            deletingId={deletingId}
            onDelete={onDelete}
            connMap={{}}
            accent="amber"
          />

          {/* 사내인프라 — Zabbix 수집 데이터 (드롭다운) */}
          <div className="pt-3 pb-1">
            <button
              onClick={() => setInfraOpen((o) => !o)}
              className="w-full flex items-center justify-between px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wider text-indigo-400 hover:bg-indigo-900/20 transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <span>◆</span>
                사내인프라
              </span>
              <svg
                className={`w-3 h-3 transition-transform duration-150 ${infraOpen ? "" : "-rotate-90"}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
          {infraOpen && [
            { href: "/serverroom/switch", label: "Switch", hint: "라우터·스위치·공유기" },
            { href: "/serverroom/server", label: "Server", hint: "서버·워크스테이션" },
            { href: "/serverroom/cloud",  label: "Cloud",  hint: "클라우드 VM" },
          ].map(({ href, label, hint }) => (
            <Link
              key={href}
              href={href}
              title={hint}
              className={clsx(
                "flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors",
                pathname.startsWith(href)
                  ? "bg-indigo-900/40 text-indigo-300"
                  : "text-indigo-400 hover:bg-indigo-900/20 hover:text-indigo-300",
              )}
            >
              <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-3-4h.01M17 16h.01" />
              </svg>
              {label}
            </Link>
          ))}

          {/* WebRTC */}
          <div className="pt-2 pb-0.5">
            <Link
              href="/webrtc"
              className={clsx(
                "flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors",
                pathname.startsWith("/webrtc")
                  ? "bg-emerald-900/40 text-emerald-300"
                  : "text-emerald-400 hover:bg-emerald-900/20 hover:text-emerald-300",
              )}
            >
              <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z" />
              </svg>
              WebRTC
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

// ── HELPDESK 섹션 ────────────────────────────────────────────────────────────

const HELPDESK_ICON = (
  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
  </svg>
);

function HelpdeskSection({ collapsed, pathname }: { collapsed: boolean; pathname: string }) {
  const [open, setOpen] = useState(true);
  const isActive = pathname.startsWith("/complain") || pathname.startsWith("/maintenance");

  if (collapsed) {
    return (
      <Link
        href="/complain"
        title="Helpdesk"
        className={clsx(
          "flex justify-center px-3 py-2 rounded-lg transition-colors",
          isActive ? "bg-rose-900/50 text-rose-300" : "text-rose-400 hover:bg-rose-900/20 hover:text-rose-300",
        )}
      >
        {HELPDESK_ICON}
      </Link>
    );
  }

  const subItems: { href: string; label: string }[] = [
    { href: "/complain",    label: "민원 관리" },
    { href: "/maintenance", label: "유지보수" },
  ];

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          "w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-semibold transition-colors",
          isActive ? "bg-rose-900/50 text-rose-300" : "text-rose-400 hover:bg-rose-900/20 hover:text-rose-300",
        )}
      >
        <span className="flex items-center gap-2">
          {HELPDESK_ICON}
          <span className="text-xs font-semibold uppercase tracking-wider">Helpdesk</span>
        </span>
        <svg className={`w-3 h-3 transition-transform duration-150 ${open ? "" : "-rotate-90"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="ml-2 pl-2 border-l border-line mt-1 space-y-0.5">
          {subItems.map(({ href, label }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={clsx(
                  "flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors",
                  active ? "bg-rose-900/40 text-rose-300" : "text-muted hover:bg-input hover:text-ink",
                )}
              >
                {label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── PROMPT 섹션 ──────────────────────────────────────────────────────────────

const PROMPT_ICON = (
  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1 1 .28 2.716-1.107 2.716H4.907c-1.386 0-2.108-1.716-1.107-2.716L5 14.5" />
  </svg>
);

function PromptSection({
  collapsed,
  pathname,
}: {
  collapsed: boolean;
  pathname:  string;
}) {
  const [open, setOpen] = useState(true);
  const isActive = pathname.startsWith("/prompt");

  if (collapsed) {
    return (
      <Link
        href="/prompt"
        title="Prompt"
        className={clsx(
          "flex justify-center px-3 py-2 rounded-lg transition-colors",
          isActive
            ? "bg-purple-900/50 text-purple-300"
            : "text-purple-400 hover:bg-purple-900/20 hover:text-purple-300",
        )}
      >
        {PROMPT_ICON}
      </Link>
    );
  }

  const subItems: { href: string; label: string; exact?: boolean }[] = [
    { href: "/prompt",     label: "프롬프트 관리", exact: true },
    { href: "/prompt/apo", label: "APO" },
  ];

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          "w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-semibold transition-colors",
          isActive
            ? "bg-purple-900/50 text-purple-300"
            : "text-purple-400 hover:bg-purple-900/20 hover:text-purple-300",
        )}
      >
        <span className="flex items-center gap-2">
          {PROMPT_ICON}
          <span className="text-xs font-semibold uppercase tracking-wider">Prompt</span>
        </span>
        <svg
          className={`w-3 h-3 transition-transform duration-150 ${open ? "" : "-rotate-90"}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="ml-2 pl-2 border-l border-line mt-1 space-y-0.5">
          {subItems.map(({ href, label, exact }) => {
            const active = exact ? pathname === href : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={clsx(
                  "flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors",
                  active
                    ? "bg-purple-900/40 text-purple-300"
                    : "text-muted hover:bg-input hover:text-ink",
                )}
              >
                {label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── CustomerGroup ─────────────────────────────────────────────────────────────

interface GroupProps {
  title:      string;
  customers:  Customer[];
  pathname:   string;
  deletingId: string | null;
  onDelete:   (e: React.MouseEvent, id: string, name: string) => void;
  connMap:    Record<string, ConnStatus>;
  accent:     "cyan" | "amber";
}

function CustomerGroup({ title, customers, pathname, deletingId, onDelete, connMap, accent }: GroupProps) {
  const [open, setOpen] = useState(true);

  return (
    <>
      <div className="pt-3 pb-1">
        <button
          onClick={() => setOpen((o) => !o)}
          className={clsx(
            "w-full flex items-center justify-between px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wider hover:bg-input/50 transition-colors",
            accent === "amber" ? "text-amber-500" : "text-green-400",
          )}
        >
          <span className="flex items-center gap-1.5">
            <span>{accent === "amber" ? "◈" : "◉"}</span>
            {title}
          </span>
          <svg
            className={`w-3 h-3 transition-transform duration-150 ${open ? "" : "-rotate-90"}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {open && (
        <>
          {customers.map((c) => (
            <CustomerItem
              key={c.id}
              customer={c}
              active={pathname.startsWith(`/customers/${c.id}`)}
              deleting={deletingId === c.id}
              onDelete={onDelete}
              connStatus={connMap[c.id] ?? (accent === "amber" ? undefined : "checking")}
              accent={accent}
            />
          ))}
          {customers.length === 0 && (
            <p className="px-4 text-xs text-faint">없음</p>
          )}
        </>
      )}
    </>
  );
}

// ── CustomerItem ──────────────────────────────────────────────────────────────

function CustomerItem({
  customer, active, deleting, onDelete, connStatus, accent,
}: {
  customer:   Customer;
  active:     boolean;
  deleting:   boolean;
  onDelete:   (e: React.MouseEvent, id: string, name: string) => void;
  connStatus: ConnStatus | undefined;
  accent:     "cyan" | "amber";
}) {
  const activeClass = accent === "amber"
    ? "bg-amber-900/30 text-amber-400"
    : "bg-cyan-900/40 text-cyan-400";

  return (
    <div className="group relative flex items-center">
      <Link
        href={`/customers/${customer.id}`}
        className={clsx(
          "flex-1 flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors pr-8",
          active ? activeClass : "text-ink2 hover:bg-input hover:text-ink",
        )}
      >
        <StatusDot status={connStatus} accent={accent} />
        <span className="truncate">{customer.name}</span>
      </Link>
      <button
        onClick={(e) => onDelete(e, customer.id, customer.name)}
        disabled={deleting}
        className="absolute right-1 opacity-0 group-hover:opacity-100 p-1 text-faint hover:text-red-400 transition-all disabled:opacity-30 rounded"
        title="고객사 삭제"
      >
        {deleting ? (
          <span className="text-[10px]">…</span>
        ) : (
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        )}
      </button>
    </div>
  );
}

// ── StatusDot ─────────────────────────────────────────────────────────────────

function StatusDot({ status, accent }: { status: ConnStatus | undefined; accent: "cyan" | "amber" }) {
  if (accent === "amber") return <span className="text-[8px] text-amber-700 leading-none">●</span>;
  if (status === "error")  return <span className="text-[8px] text-red-500 leading-none">●</span>;
  const pulse = status === "checking" ? " animate-pulse" : "";
  return <span className={`text-[8px] text-green-400 leading-none${pulse}`}>●</span>;
}
