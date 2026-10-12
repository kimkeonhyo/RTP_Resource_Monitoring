import InspectionDetailPage from "@/components/maintenance/inspection-detail-page";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InspectionDetailPage id={Number(id)} />;
}
