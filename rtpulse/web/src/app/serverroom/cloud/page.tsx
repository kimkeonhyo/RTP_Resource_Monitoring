import DeviceList from "@/components/serverroom/device-list";

export const metadata = { title: "서버실 · Cloud" };

export default function Page() {
  return <DeviceList kind="cloud" title="Cloud — 클라우드 VM" />;
}
