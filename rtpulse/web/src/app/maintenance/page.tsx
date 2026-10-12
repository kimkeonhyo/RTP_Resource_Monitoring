import MaintenanceShell from "@/components/maintenance/maintenance-shell";

export const dynamic = "force-dynamic";

export default function MaintenancePage() {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">유지보수</h1>
          <p className="text-xs text-faint mt-0.5">납품 고객사 정기 점검 일정·결과 관리</p>
        </div>
      </div>
      <MaintenanceShell />
    </div>
  );
}
