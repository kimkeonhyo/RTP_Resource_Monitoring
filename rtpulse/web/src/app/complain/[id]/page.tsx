import ComplainDetail from "@/components/complain/complain-detail";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export default async function ComplainDetailPage({ params }: Params) {
  const { id } = await params;
  return <ComplainDetail id={id} />;
}
