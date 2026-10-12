import HostDetail from "@/components/serverroom/host-detail";

export const metadata = { title: "서버실 · 장비 상세" };

export default async function Page({
  params, searchParams,
}: {
  params: Promise<{ hostid: string }>;
  searchParams: Promise<{ kind?: string }>;
}) {
  const { hostid } = await params;
  const { kind } = await searchParams;
  return (
    <div className="p-6">
      <HostDetail hostid={hostid} kind={kind ?? "server"} />
    </div>
  );
}
