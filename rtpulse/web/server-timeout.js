// Node HTTP requestTimeout 상향 — 대용량 NAS 업로드가 Node 기본 5분(300s) 제한에
// 걸려 "connection reset by peer"로 끊기는 문제 방지.
//
// standalone(node server.js) 진입 전 --require 로 미리 로드되어, http.createServer 를
// 감싸 생성되는 서버의 requestTimeout 을 늘린다. 실제 상한은 앞단 Caddy/GCP LB 타임아웃.
const http = require("http");

const origCreate = http.createServer.bind(http);
http.createServer = function patchedCreateServer(...args) {
  const server = origCreate(...args);
  server.requestTimeout = 30 * 60 * 1000; // 30분 (기본 300초 → 상향)
  // headersTimeout 은 기본(60초) 유지 — 헤더는 빠르게 도착하므로 그대로 둔다.
  return server;
};
