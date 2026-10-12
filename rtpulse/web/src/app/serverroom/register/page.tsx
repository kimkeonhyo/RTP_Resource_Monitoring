import RegisterForm from "@/components/serverroom/register-form";

export const metadata = { title: "서버실 · 장비 등록" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ for?: string }>;
}) {
  const { for: forKind } = await searchParams;
  return <RegisterForm defaultKind={forKind} />;
}
