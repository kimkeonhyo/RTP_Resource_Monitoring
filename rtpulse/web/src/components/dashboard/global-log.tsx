import { CustomerStatus } from "@/lib/types";
import { format } from "date-fns";
import { ko } from "date-fns/locale";

export default function GlobalLog({ statuses }: { statuses: CustomerStatus[] }) {
  const entries = statuses
    .filter((s) => s.reachable && s.stats?.event_log)
    .flatMap((s) =>
      (s.stats?.event_log ?? []).map((e) => ({
        customerName: s.customer.name,
        ...e,
      }))
    )
    .sort((a, b) => b.happened_at_epoch - a.happened_at_epoch)
    .slice(0, 30);

  if (entries.length === 0) return null;

  const kindColor: Record<string, string> = {
    DOWN: "text-red-400",
    WARNING: "text-yellow-400",
    RECONNECT: "text-green-400",
  };

  return (
    <div>
      <h2 className="text-sm font-semibold text-muted mb-3">통합 이벤트 로그</h2>
      <div className="bg-panel border border-line rounded-xl overflow-hidden">
        <div className="divide-y divide-line">
          {entries.map((e, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span className="text-faint text-xs w-36 flex-shrink-0">
                {format(new Date(e.happened_at_epoch * 1000), "MM/dd HH:mm:ss", { locale: ko })}
              </span>
              <span className="text-faint text-xs w-20 flex-shrink-0 truncate">
                {e.customerName}
              </span>
              <span className="text-ink2 text-xs w-24 flex-shrink-0 truncate">
                {e.stream_name}
              </span>
              <span className={`text-xs font-bold w-20 flex-shrink-0 ${kindColor[e.event_kind] ?? "text-muted"}`}>
                {e.event_kind}
              </span>
              <span className="text-faint text-xs truncate">{e.cause}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
