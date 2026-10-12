"use client";

import { Customer } from "@/lib/types";

export default function ConfigInfo({ customer }: { customer: Customer }) {
  const hasDb = !!customer.dbPassword;

  return (
    <div className="border border-line rounded-xl p-4 space-y-4">
      <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-xs">
        <Row label="서버 IP" value={customer.ip ?? "미입력"} />
        <Row label="VIP (Virtual-IP)" value={customer.vip ?? "미설정"} warn={!customer.vip} />
        <Row label="DB 이름" value={customer.dbName ?? "미설정"} warn={!customer.dbName} />
        <Row label="DB 포트" value={String(customer.dbPort ?? 3306)} />
        <Row label="DB 사용자" value={customer.dbUser ?? "ops"} />
        <Row label="DB 비밀번호" value={hasDb ? "●●●●●●" : "미설정"} warn={!hasDb} />
        <Row label="SSH 사용자" value={customer.sshUser ?? customer.dbUser ?? "ops"} />
        <Row label="NAS 경로" value={customer.nasPath ?? "/rtpulse"} />
        <Row label="설명" value={customer.description ?? "—"} />
      </div>

      {(!customer.vip || !customer.dbName || !hasDb) && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 dark:text-amber-400 dark:bg-amber-900/20 dark:border-amber-800">
          {!customer.vip
            ? "VIP(Virtual-IP)가 설정되지 않았습니다."
            : !customer.dbName
            ? "DB 이름이 설정되지 않았습니다."
            : "DB 비밀번호가 설정되지 않았습니다."}{" "}
          고객사 수정 페이지에서 입력하세요.
        </p>
      )}

      <div className="pt-1 border-t border-line">
        <p className="text-xs text-faint">
          등록일: {new Date(customer.createdAt).toLocaleString("ko-KR")}
        </p>
      </div>
    </div>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-faint w-28 shrink-0">{label}</span>
      <span className={`font-mono break-all ${warn ? "text-red-400" : "text-ink2"}`}>{value}</span>
    </div>
  );
}
