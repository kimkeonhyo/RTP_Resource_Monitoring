import { notFound } from "next/navigation";
import { getCustomer } from "@/lib/customers";
import CustomerDetail from "@/components/customer-detail/customer-detail";
import OnpremDetail from "@/components/onprem-detail/onprem-detail";

export const dynamic = "force-dynamic";

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const customer = await getCustomer(id);
  if (!customer) notFound();

  if (customer.networkType === "onprem") {
    return <OnpremDetail customer={customer} />;
  }
  return <CustomerDetail customer={customer} />;
}
