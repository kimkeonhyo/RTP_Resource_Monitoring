import DeviceList from "@/components/serverroom/device-list";

export const metadata = { title: "서버실 · Server" };

export default function Page() {
  return <DeviceList kind="server" title="Server — 서버·워크스테이션" />;
}
