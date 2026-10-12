/**
 * 유지보수 점검 리포트 → 디자인된 점검문서 Excel(.xlsx) 내보내기.
 *
 * 참고 양식(VMS_점검표.xlsx) 수준의 서식(제목 바·섹션 음영·표 테두리·Pass/Fail 색상)을
 * 갖춘 담당자 전달용 점검표를 ExcelJS로 생성해 브라우저에서 바로 다운로드한다.
 */
import type ExcelJS from "exceljs"; // 타입 전용 — 런타임은 클릭 시 동적 import(번들 분리)
import {
  INSPECT_TYPES,
  normalizeDetectionStats,
  formatDetectionDate,
  type InspectionReport,
} from "@/lib/maintenance";

/** 내보내기에 필요한 최소 점검 정보 (inspection-list의 Inspection과 구조적으로 호환). */
export interface ExportableInspection {
  customer_name: string;
  inspection_name: string;
  cycle: string | null;
  scheduled_date: string;
  completed_date: string | null;
  inspector: string;
  purpose: string;
  report: InspectionReport;
}

/** 팔레트 (ARGB). */
const C = {
  title: "FF1F3864",   // 제목 바 (남색)
  section: "FF305496", // 섹션 헤더 (파랑)
  thead: "FF4472C4",   // 표 헤더 (밝은 파랑)
  label: "FFEDEFF2",   // 메타 라벨 (연회색)
  zebra: "FFF6F8FC",   // 데이터 짝수행
  border: "FFBFBFBF",  // 테두리
  pass: "FF2E7D32",    // Pass 녹색
  fail: "FFC62828",    // Fail 적색
  na: "FF7F7F7F",      // N/A 회색
  white: "FFFFFFFF",
  ink: "FF1A1A1A",
} as const;

const CYCLE_LABEL: Record<string, string> = {
  "2주": "2주 1회",
  "1개월": "월 1회",
  "6개월": "반기 1회",
  "1년": "연 1회",
  "없음": "비주기(1회성)",
};

const CHECK_HEADER = ["유형", "점검항목", "검사방법", "검사결과", "조치결과", "비고"];

const safe = (v: unknown): string => (v == null ? "" : String(v));
const slug = (s: string): string =>
  (s || "").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 40);

/** 얇은 회색 사방 테두리. */
function box(): Partial<ExcelJS.Borders> {
  const side = { style: "thin", color: { argb: C.border } } as ExcelJS.Border;
  return { top: side, left: side, bottom: side, right: side };
}
function fillCell(cell: ExcelJS.Cell, argb: string): void {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
}

/** 섹션 제목 줄 (A..F 병합, 파랑 배경 흰 글씨). */
function sectionRow(ws: ExcelJS.Worksheet, r: number, title: string, cols = 6): void {
  ws.mergeCells(r, 1, r, cols);
  const cell = ws.getCell(r, 1);
  cell.value = title;
  fillCell(cell, C.section);
  cell.font = { bold: true, size: 11, color: { argb: C.white } };
  cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  ws.getRow(r).height = 22;
}

/** 메타 라벨/값 쌍. */
function metaPair(ws: ExcelJS.Worksheet, r: number, cLabel: number, label: string, cVal: number, value: string): void {
  const lc = ws.getCell(r, cLabel);
  lc.value = label;
  fillCell(lc, C.label);
  lc.font = { bold: true, color: { argb: C.ink } };
  lc.alignment = { vertical: "middle", horizontal: "center" };
  lc.border = box();
  const vc = ws.getCell(r, cVal);
  vc.value = value || null;
  vc.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  vc.border = box();
}

/** 시트1 「점검표」 — 메타 + 점검 내용(체크리스트) + 부가 섹션. */
function buildSummarySheet(wb: ExcelJS.Workbook, insp: ExportableInspection): void {
  const r0 = insp.report;
  const ws = wb.addWorksheet("점검표", {
    properties: { defaultRowHeight: 18 },
    pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } },
  });
  ws.columns = [{ width: 16 }, { width: 24 }, { width: 42 }, { width: 12 }, { width: 26 }, { width: 20 }];

  const inspTypeLabel =
    INSPECT_TYPES.find((t) => t.key === (r0.env?.inspect_type ?? "remote"))?.label ?? "원격 검사";
  const inspectDate = (insp.completed_date || r0.env?.inspect_date || insp.scheduled_date || "").slice(0, 10);
  const cycleLabel = insp.cycle ? CYCLE_LABEL[insp.cycle] ?? insp.cycle : "—";
  const productName = safe(r0.env?.product_name);

  let r = 1;

  // 제목 바
  ws.mergeCells(r, 1, r, 6);
  const title = ws.getCell(r, 1);
  title.value = `${productName ? productName + " " : ""}점검표`;
  fillCell(title, C.title);
  title.font = { bold: true, size: 16, color: { argb: C.white } };
  title.alignment = { vertical: "middle", horizontal: "center" };
  ws.getRow(r).height = 30;
  r += 2; // 제목 아래 한 줄 여백

  // 메타 블록
  metaPair(ws, r, 1, "점검 대상 사이트", 2, insp.customer_name);
  metaPair(ws, r, 3, "점검명", 4, insp.inspection_name);
  metaPair(ws, r, 5, "점검일", 6, inspectDate || "—");
  ws.getRow(r).height = 20; r++;
  metaPair(ws, r, 1, "점검자", 2, safe(insp.inspector) || "—");
  metaPair(ws, r, 3, "점검 주기", 4, cycleLabel);
  metaPair(ws, r, 5, "검사 방식", 6, inspTypeLabel);
  ws.getRow(r).height = 20; r++;
  metaPair(ws, r, 1, "제품명", 2, productName || "—");
  metaPair(ws, r, 3, "제품버전", 4, safe(r0.env?.product_version) || "—");
  metaPair(ws, r, 5, "최초 설치일", 6, safe(r0.env?.install_date) || "—");
  ws.getRow(r).height = 20; r++;
  if (safe(insp.purpose)) {
    metaPair(ws, r, 1, "목적", 2, insp.purpose);
    ws.mergeCells(r, 2, r, 6);
    ws.getRow(r).height = 20; r++;
  }
  r++; // 여백

  // 2-2 점검 내용 (체크리스트)
  const checklist = (r0.checklist ?? []).filter((c) => c.item || c.type || c.method);
  sectionRow(ws, r, "점검 내용"); r++;
  // 표 헤더
  CHECK_HEADER.forEach((h, i) => {
    const cell = ws.getCell(r, i + 1);
    cell.value = h;
    fillCell(cell, C.thead);
    cell.font = { bold: true, color: { argb: C.white } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = box();
  });
  ws.getRow(r).height = 20; r++;
  if (checklist.length === 0) {
    ws.mergeCells(r, 1, r, 6);
    const c = ws.getCell(r, 1);
    c.value = "(점검 항목 없음)";
    c.alignment = { horizontal: "center" }; c.font = { color: { argb: C.na } }; c.border = box();
    r++;
  } else {
    checklist.forEach((it, idx) => {
      const cells = [safe(it.type), safe(it.item), safe(it.method), safe(it.result), safe(it.action), safe(it.note)];
      cells.forEach((v, i) => {
        const cell = ws.getCell(r, i + 1);
        cell.value = v || null; // 빈 문자열은 null로 — ""는 공유문자열로 등록돼 일부 뷰어에서 인덱스가 표시됨
        cell.border = box();
        cell.alignment = { vertical: "top", wrapText: true, horizontal: i === 3 ? "center" : "left" };
        if (idx % 2 === 1) fillCell(cell, C.zebra);
        if (i === 3) {
          cell.font = {
            bold: true,
            color: { argb: v === "Pass" ? C.pass : v === "Fail" ? C.fail : C.na },
          };
          cell.alignment = { vertical: "middle", horizontal: "center" };
        }
      });
      ws.getRow(r).height = 30; r++;
    });
  }
  r++;

  // 탐지현황 통계 (2-3) — 점검 내용 바로 다음
  r = appendDetectionSection(ws, r0, r);

  // 고객민원 및 특이사항
  if (safe(r0.complaints)) {
    sectionRow(ws, r, "고객민원 및 특이사항"); r++;
    ws.mergeCells(r, 1, r, 6);
    const c = ws.getCell(r, 1);
    c.value = safe(r0.complaints);
    c.alignment = { vertical: "top", wrapText: true }; c.border = box();
    ws.getRow(r).height = 44; r++;
    r++;
  }

  // VMS 배포/이미지 버전
  const isVms = productName === "VMS";
  const images = (r0.images ?? []).filter((i) => i.image_name);
  if (isVms && r0.deploy_mode === "BUNDLE" && safe(r0.bundle_version)) {
    sectionRow(ws, r, "VMS 번들 버전"); r++;
    metaPair(ws, r, 1, "배포 방식", 2, "Bundle");
    metaPair(ws, r, 3, "번들 버전", 4, safe(r0.bundle_version));
    ws.getCell(r, 5).border = box(); ws.getCell(r, 6).border = box();
    ws.getRow(r).height = 20; r += 2;
  } else if (isVms && images.length > 0) {
    sectionRow(ws, r, "VMS 이미지 버전"); r++;
    ["이미지", "버전"].forEach((h, i) => {
      const cell = ws.getCell(r, i + 1); cell.value = h;
      fillCell(cell, C.thead); cell.font = { bold: true, color: { argb: C.white } };
      cell.alignment = { horizontal: "center" }; cell.border = box();
    });
    ws.mergeCells(r, 2, r, 6); r++;
    images.forEach((im, idx) => {
      const a = ws.getCell(r, 1); a.value = im.image_name || null; a.border = box();
      const b = ws.getCell(r, 2); b.value = safe(im.version) || null; b.border = box(); b.font = { name: "Consolas" };
      ws.mergeCells(r, 2, r, 6);
      if (idx % 2 === 1) { fillCell(a, C.zebra); fillCell(b, C.zebra); }
      r++;
    });
    r++;
  }

  // 레거시(구버전) 자유서술 호환
  const legacy = (label: string, value: string) => {
    sectionRow(ws, r, label); r++;
    ws.mergeCells(r, 1, r, 6);
    const c = ws.getCell(r, 1); c.value = value;
    c.alignment = { vertical: "top", wrapText: true }; c.border = box();
    ws.getRow(r).height = 44; r += 2;
  };
  if (safe(r0.contents)) legacy("점검 내용(구버전)", safe(r0.contents));
  if (safe(r0.results)) legacy("점검 결과(구버전)", safe(r0.results));
}

/** 시트2 「탐지현황 통계」 — 이벤트 × TP/FP × 날짜 매트릭스. 데이터 없으면 미생성. */
/** 날짜 단위 → 기간 표기 단어. */
function unitWord(unit: string): string {
  return unit === "day" ? "일" : unit === "week" ? "주" : "개월";
}

/**
 * 메인 점검표 시트에 '탐지현황 통계' 섹션을 추가한다.
 * 날짜별 매트릭스 대신 점검 기간(월/분기/반기)의 이벤트별 정탐·오탐 합계만 표기해
 * 다른 표와 열 폭을 맞춘다. 다음 행을 반환.
 */
function appendDetectionSection(ws: ExcelJS.Worksheet, report: InspectionReport, r: number): number {
  const det = normalizeDetectionStats(report.detectionStats);
  const hasData =
    det.events.some((e) => e.name || e.tp.some((n) => n != null) || e.fp.some((n) => n != null));
  if (!hasData) return r;

  const sum = (a: (number | null)[]): number => a.reduce((s: number, n) => s + (n ?? 0), 0);

  // 섹션 헤더
  sectionRow(ws, r, "탐지현황 통계"); r++;

  // 대상 기간 캡션
  if (det.dates.length > 0) {
    const f = formatDetectionDate(det.dates[0], det.unit);
    const l = formatDetectionDate(det.dates[det.dates.length - 1], det.unit);
    ws.mergeCells(r, 1, r, 6);
    const cap = ws.getCell(r, 1);
    cap.value = `대상 기간: ${f}${l !== f ? " ~ " + l : ""} (${det.dates.length}${unitWord(det.unit)})`;
    cap.font = { italic: true, size: 9, color: { argb: C.na } };
    cap.alignment = { horizontal: "left", indent: 1 };
    r++;
  }

  // 표 헤더: 이벤트명 | 정탐(TP) | 오탐(FP) | 합계
  ["이벤트명", "정탐(TP)", "오탐(FP)", "합계"].forEach((h, i) => {
    const cell = ws.getCell(r, i + 1); cell.value = h;
    fillCell(cell, C.thead); cell.font = { bold: true, color: { argb: C.white } };
    cell.alignment = { horizontal: "center", vertical: "middle" }; cell.border = box();
  });
  ws.getRow(r).height = 20; r++;

  let tTp = 0, tFp = 0;
  det.events.forEach((e, ei) => {
    const tp = sum(e.tp), fp = sum(e.fp);
    tTp += tp; tFp += fp;
    const zebra = ei % 2 === 1;
    [safe(e.name) || "-", tp, fp, tp + fp].forEach((v, i) => {
      const c = ws.getCell(r, i + 1); c.value = v;
      c.border = box();
      c.alignment = { horizontal: i === 0 ? "left" : "center", vertical: "middle" };
      if (i === 1) c.font = { color: { argb: C.pass } };
      if (i === 2) c.font = { color: { argb: C.fail } };
      if (zebra) fillCell(c, C.zebra);
    });
    r++;
  });

  // 합계 행
  [["합계", tTp, tFp, tTp + tFp]][0].forEach((v, i) => {
    const cell = ws.getCell(r, i + 1); cell.value = v;
    fillCell(cell, C.label); cell.font = { bold: true, color: { argb: i === 3 ? C.section : C.ink } };
    cell.alignment = { horizontal: i === 0 ? "left" : "center" }; cell.border = box();
  });
  r++;
  return r + 1; // 여백 포함 다음 행
}

/** 워크북을 브라우저에서 다운로드. */
async function downloadWorkbook(wb: ExcelJS.Workbook, fileName: string): Promise<void> {
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 점검 리포트 → 디자인된 점검표 워크북 (다운로드 없이 워크북만; 테스트/서버용도 겸용). */
export async function buildInspectionWorkbook(insp: ExportableInspection): Promise<ExcelJS.Workbook> {
  const { default: ExcelJSRuntime } = await import("exceljs"); // 클릭 시에만 로드
  const wb = new ExcelJSRuntime.Workbook();
  wb.creator = "RTPulse";
  wb.created = new Date();
  buildSummarySheet(wb, insp);
  return wb;
}

/** 완료 점검 리포트를 디자인된 점검표 엑셀로 내보낸다(담당자 전달용). */
export async function exportInspectionXlsx(insp: ExportableInspection): Promise<void> {
  const wb = await buildInspectionWorkbook(insp);

  const datePart =
    (insp.completed_date || insp.report.env?.inspect_date || insp.scheduled_date || "")
      .slice(0, 10)
      .replace(/-/g, "") || "점검";
  const fileName = `RTPulse_점검표_${slug(insp.customer_name)}_${slug(insp.inspection_name)}_${datePart}.xlsx`;
  await downloadWorkbook(wb, fileName);
}
