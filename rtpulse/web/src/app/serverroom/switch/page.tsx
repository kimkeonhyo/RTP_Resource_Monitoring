import DeviceList from "@/components/serverroom/device-list";

export const metadata = { title: "서버실 · Switch" };

export default function Page() {
  return <DeviceList kind="switch" title="Switch — 네트워크 장비" />;
}
