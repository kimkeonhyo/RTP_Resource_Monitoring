import { NextRequest, NextResponse } from "next/server";
import {
  createHost, installAgent, planFor, validate,
  type RegisterInput, type SshCreds,
} from "@/lib/serverroom-register";
import { addHostToMap, type TopologyAdd } from "@/lib/topology";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// apt 설치가 오래 걸린다. 설치 자체는 5분에서 끊는다.
export const maxDuration = 330;

/**
 * POST /api/serverroom/register
 *
 * 장비 한 대를 Zabbix 에 등록한다. 서버·워크스테이션이면 접속 정보를 함께 받아
 * 에이전트까지 설치한다. 등록되면 서버실 화면이 그룹을 읽어 그리므로
 * 대시보드를 따로 만들 필요가 없다.
 *
 * 순서: 에이전트 설치 → Zabbix 등록.
 * 설치가 실패한 채로 호스트를 만들면 곧바로 "에이전트 응답 없음" 알람이 뜬다.
 */
export async function POST(req: NextRequest) {
  let body: RegisterInput & { ssh?: SshCreds };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "본문이 JSON 이 아닙니다" }, { status: 400 });
  }

  const bad = validate(body);
  if (bad) return NextResponse.json({ error: bad }, { status: 400 });

  const plan = planFor(body);

  // NDJSON 스트림: 설치 로그를 오는 대로 흘려보내고, 마지막에 결과/오류 한 줄.
  //   {"type":"log","data":"..."}  진행 로그
  //   {"type":"result", ...}       등록 성공
  //   {"type":"error","error":"..."} 실패
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      let install: { ok: boolean; log: string } | null = null;
      try {
        if (plan.needsAgent && body.ssh?.user && (body.ssh.password || body.ssh.privateKey)) {
          send({ type: "log", data: `[${body.ip}] 에이전트 설치 시작…\n` });
          install = await installAgent(body.ip, body.host, body.kind, body.ssh, (chunk) => send({ type: "log", data: chunk }));
          if (!install.ok) {
            send({ type: "error", error: "에이전트 설치가 실패해 등록을 중단했습니다", install });
            return;
          }
        }
        send({ type: "log", data: "Zabbix 에 호스트 등록 중…\n" });
        const result = await createHost(body);

        // 토폴로지에도 얹는다. 여기서 실패해도 등록 자체는 성공이므로 결과만 알린다.
        let topology: TopologyAdd | { added: false; reason: string };
        try {
          topology = await addHostToMap(result.hostid, body.kind);
          send({ type: "log", data: topology.added
            ? `구성도에 추가${topology.linkedTo ? ` (${topology.linkedTo} 에 연결)` : ""}\n`
            : `구성도 추가 안 함 — ${topology.reason}\n` });
        } catch (e) {
          topology = { added: false, reason: e instanceof Error ? e.message : String(e) };
          send({ type: "log", data: `구성도 추가 실패 — ${topology.reason}\n` });
        }

        send({ type: "result", ...result, install, topology, zabbixWeb: process.env.ZABBIX_URL });
      } catch (e) {
        // 에이전트는 깔렸는데 등록만 실패한 경우도 로그를 돌려줘야 원인을 잡는다.
        send({ type: "error", error: e instanceof Error ? e.message : String(e), install });
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
