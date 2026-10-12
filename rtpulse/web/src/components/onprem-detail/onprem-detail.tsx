"use client";

import { Customer } from "@/lib/types";
import Link from "next/link";
import ConfigInfo from "./config-info";
import OnpremDataList from "./data-list-onprem";
import PromptHistory from "@/components/data-watch/prompt-history";

export default function OnpremDetail({ customer }: { customer: Customer }) {
  return (
    <div className="p-6 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="px-2 py-0.5 text-xs rounded-full bg-amber-900/40 text-amber-400 border border-amber-800 font-medium">
              온프레미스
            </span>
            <h1 className="text-xl font-bold text-ink">{customer.name}</h1>
          </div>
          <p className="text-xs text-faint">
            VIP {customer.vip ?? "미설정"} · 망분리 환경
          </p>
        </div>
        <Link
          href={`/customers/${customer.id}/edit`}
          className="px-3 py-1.5 text-xs bg-input text-ink2 border border-line2 rounded-lg hover:bg-gray-700"
        >
          수정
        </Link>
      </div>

      {/* 1. Config Info */}
      <Section title="1. 고객사 Config" id="config">
        <ConfigInfo customer={customer} />
      </Section>

      {/* 2. Prompt 배포 이력 */}
      <Section title="2. Prompt 배포 이력" id="prompt">
        <PromptHistory customerId={customer.id} />
      </Section>

      {/* 3. Data List */}
      <Section title="3. Data List" id="data">
        <OnpremDataList customer={customer} />
      </Section>
    </div>
  );
}

function Section({ title, id, children }: { title: string; id: string; children: React.ReactNode }) {
  return (
    <section id={id}>
      <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-3 border-b border-line pb-2">
        {title}
      </h2>
      {children}
    </section>
  );
}
