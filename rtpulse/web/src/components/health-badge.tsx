import clsx from "clsx";
import { StreamHealth } from "@/lib/types";

const MAP: Record<StreamHealth, { label: string; cls: string }> = {
  HEALTHY: { label: "HEALTHY", cls: "bg-green-100 text-green-700 border-green-400 dark:bg-green-900/40 dark:text-green-400 dark:border-green-700" },
  DEGRADED: { label: "DEGRADED", cls: "bg-yellow-100 text-yellow-700 border-yellow-400 dark:bg-yellow-900/40 dark:text-yellow-400 dark:border-yellow-700" },
  DOWN: { label: "DOWN", cls: "bg-red-100 text-red-700 border-red-400 dark:bg-red-900/40 dark:text-red-400 dark:border-red-700" },
  UNKNOWN: { label: "UNKNOWN", cls: "bg-input text-faint border-line2" },
};

export default function HealthBadge({ health }: { health: StreamHealth }) {
  const { label, cls } = MAP[health] ?? MAP.UNKNOWN;
  return (
    <span className={clsx("px-2 py-0.5 rounded border text-xs font-mono font-bold", cls)}>
      {label}
    </span>
  );
}
