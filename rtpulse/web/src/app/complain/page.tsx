import CsTabs from "@/components/complain/cs-tabs";

export const dynamic = "force-dynamic";

export default function ComplainPage() {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">HELPDESK</h1>
      </div>
      <CsTabs />
    </div>
  );
}
