import { NextRequest, NextResponse } from "next/server";
import { getCameras, addCamera, parseCsvCameras, Camera } from "@/lib/cameras";
import { getCustomer } from "@/lib/customers";

type Params = { params: Promise<{ customerId: string }> };

export async function GET(_: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const cameras = await getCameras(customerId);
  return NextResponse.json(cameras);
}

export async function POST(req: NextRequest, { params }: Params) {
  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const body = await req.json() as {
    cameras?: Omit<Camera, "id" | "createdAt" | "updatedAt" | "enabled">[];
    csv?: string;
    register?: boolean;
  };

  const rawCameras = body.csv
    ? parseCsvCameras(body.csv)
    : (body.cameras ?? []);

  if (rawCameras.length === 0) {
    return NextResponse.json({ error: "No cameras provided" }, { status: 400 });
  }

  const saved = await Promise.all(rawCameras.map((c) => addCamera(customerId, c)));

  // rtpulse에 즉시 반영 (best-effort — DB가 권위 소스이므로 실패해도 무방)
  if (body.register && customer.apiUrl) {
    const base = customer.apiUrl.replace(/\/$/, "");
    await Promise.allSettled(
      saved.flatMap((cam) => [
        fetch(`${base}/api/streams`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: `${cam.name} (메인)`, url: cam.mainstream_url }),
        }),
        ...(cam.substream_url
          ? [fetch(`${base}/api/streams`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: `${cam.name} (서브)`, url: cam.substream_url }),
            })]
          : []),
      ])
    );
  }

  return NextResponse.json({ saved, registered: body.register ? saved.length : 0 });
}
