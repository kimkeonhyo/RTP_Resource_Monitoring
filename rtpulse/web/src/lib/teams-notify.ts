/**
 * Microsoft Teams Incoming Webhook 알림
 *
 * 채널에 Incoming Webhook 커넥터를 추가하고
 * 발급된 URL 을 TEAMS_COMPLAIN_WEBHOOK_URL 환경변수에 설정하세요.
 *
 * Teams 채널 > ··· > 커넥터 > Incoming Webhook > 구성 > 이름 입력 > URL 복사
 */

interface ComplaintNotifyPayload {
  id: number;
  customer_name: string;
  reporter: string;
  assignee: string;
  title: string;
  status: string;
  received_at: string;
  category?: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  complain: "고객 불만",
  business: "사업 문의",
  inquiry: "종합문의",
};

export async function notifyNewComplaint(c: ComplaintNotifyPayload): Promise<void> {
  const webhookUrl = process.env.TEAMS_COMPLAIN_WEBHOOK_URL;
  if (!webhookUrl) return; // 미설정 시 조용히 skip

  const baseUrl = (process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "");
  const detailUrl = `${baseUrl}/complain/${c.id}`;
  const catLabel = CATEGORY_LABEL[c.category ?? "complain"] ?? "고객 불만";

  // MessageCard 형식 (Teams Incoming Webhook 표준)
  const card = {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    themeColor: "E11D48", // rose-600
    summary: `[고객민원] 새 ${catLabel} 접수 — ${c.customer_name}`,
    sections: [
      {
        activityTitle: `🔔 새 ${catLabel}이(가) 접수되었습니다`,
        activitySubtitle: `RTPulse 고객민원 · ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
        facts: [
          { name: "유형",      value: catLabel },
          { name: "고객사",    value: c.customer_name || "-" },
          { name: "내용",      value: c.title          || "-" },
          { name: "접수자",    value: c.reporter        || "-" },
          { name: "담당자",    value: c.assignee        || "-" },
          { name: "진행 상태", value: c.status          || "접수" },
          { name: "접수일",    value: c.received_at     || "-" },
        ],
        markdown: true,
      },
    ],
    potentialAction: [
      {
        "@type": "OpenUri",
        name: "상세 보기",
        targets: [{ os: "default", uri: detailUrl }],
      },
    ],
  };

  await postCard(webhookUrl, card);
}

/**
 * NAS SFTP 다운 알림 — 자동업로드가 SFTP 연결/세션 단계에서 실패할 때.
 * 조치는 "ADM에서 SFTP 서비스 재시작"이라 사람이 클릭 한 번이면 되므로,
 * 무인 재시작 대신 알림만 보낸다. 도배 방지는 호출측 쿨다운에서.
 * 전용 웹훅(TEAMS_ALERT_WEBHOOK_URL) 없으면 민원 웹훅으로 폴백.
 */
export async function notifyNasSftpDown(detail: string): Promise<void> {
  const webhookUrl = process.env.TEAMS_ALERT_WEBHOOK_URL ?? process.env.TEAMS_COMPLAIN_WEBHOOK_URL;
  if (!webhookUrl) return; // 미설정 시 조용히 skip

  const card = {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    themeColor: "E11D48",
    summary: "[Watch] NAS 자동업로드 SFTP 연결 실패",
    sections: [
      {
        activityTitle: "🚨 NAS 자동업로드 SFTP 연결 실패 (전 고객사 영향 가능)",
        activitySubtitle: `RTPulse · ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
        facts: [
          { name: "대상 NAS", value: "nas01 (ASUSTOR) · SFTP 2222" },
          { name: "오류",     value: detail.slice(0, 300) || "-" },
          { name: "조치",     value: "ADM → 서비스 → SFTP 서비스 껐다 켜기(재시작). 인증은 되는데 세션이 죽는 경우 대개 이걸로 복구됨." },
        ],
        markdown: true,
      },
    ],
  };

  await postCard(webhookUrl, card);
}

async function postCard(webhookUrl: string, card: unknown): Promise<void> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(card),
    });
    if (!res.ok) {
      console.error("[teams-notify] webhook 전송 실패:", res.status, await res.text());
    }
  } catch (e) {
    console.error("[teams-notify] webhook 오류:", e);
  }
}
