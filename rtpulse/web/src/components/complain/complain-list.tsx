"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import Link from "next/link";
import {
  type Category,
  getCategory,
  statusBadgeClass,
  statusAccentClass,
  PRIORITIES,
  PRIORITY_LABEL,
  DEFAULT_PRIORITY,
  priorityBadgeClass,
} from "@/lib/complain-categories";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ComplaintRow {
  id: number;
  customer_name: string;
  applicant_name: string;
  job_title: string;
  email: string;
  phone: string;
  reporter: string;
  assignee: string;
  title: string;
  status: string;
  received_at: string;
  resolved_at: string | null;
  phenomenon: string;
  action_method: string;
  action_result: string;
  response_status: string;
  category: string;
  priority: string;
  created_at: string;
  updated_at: string;
  file_count: number;
}

interface AzureMember {
  subjectKind: string;
  displayName: string;
  mailAddress: string;
  descriptor: string;
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusBadgeClass(status)}`}>
      {status}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${priorityBadgeClass(priority)}`}>
      {PRIORITY_LABEL[priority as keyof typeof PRIORITY_LABEL] ?? priority}
    </span>
  );
}

// ─── Editable Cell ────────────────────────────────────────────────────────────

interface EditableCellProps {
  value: string;
  onSave: (val: string) => void;
  type?: "text" | "date" | "select" | "member";
  statuses?: string[];
  /** select 뱃지 스타일: 진행 상태(status) | 우선순위(priority) */
  badge?: "status" | "priority";
  members?: AzureMember[];
  membersLoading?: boolean;
}

function EditableCell({ value, onSave, type = "text", statuses = [], badge = "status", members, membersLoading }: EditableCellProps) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);

  useEffect(() => { setVal(value); }, [value]);
  useEffect(() => { if (editing && inputRef.current) inputRef.current.focus(); }, [editing]);

  const handleBlur = () => {
    setEditing(false);
    if (val !== value) onSave(val);
  };

  const inputCls = "px-2 py-1 bg-panel border border-line2 rounded text-xs text-ink focus:outline-none focus:border-cyan-600 w-full min-w-[80px]";

  if (editing) {
    if (type === "select") {
      return (
        <select
          ref={inputRef as React.RefObject<HTMLSelectElement>}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={handleBlur}
          className={inputCls}
        >
          {statuses.map((s) => (
            <option key={s} value={s}>
              {badge === "priority" ? PRIORITY_LABEL[s as keyof typeof PRIORITY_LABEL] ?? s : s}
            </option>
          ))}
        </select>
      );
    }

    if (type === "member") {
      if (membersLoading) {
        return (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type="text" value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={handleBlur}
            placeholder="로딩 중..."
            className={inputCls}
          />
        );
      }
      if (members && members.length > 0) {
        return (
          <select
            ref={inputRef as React.RefObject<HTMLSelectElement>}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={handleBlur}
            className={inputCls}
          >
            <option value="">선택...</option>
            {members.map((m) => (
              <option key={m.descriptor} value={m.displayName}>{m.displayName}</option>
            ))}
          </select>
        );
      }
      return (
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type="text" value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={handleBlur}
          className={inputCls}
        />
      );
    }

    return (
      <input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        type={type} value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={handleBlur}
        className={inputCls}
      />
    );
  }

  if (type === "select") {
    return (
      <span onClick={() => setEditing(true)} className="cursor-pointer inline-block" title="클릭하여 변경">
        {val ? (
          badge === "priority" ? <PriorityBadge priority={val} /> : <StatusBadge status={val} />
        ) : (
          <span className="text-faint italic text-xs">-</span>
        )}
      </span>
    );
  }

  return (
    <span
      onClick={() => setEditing(true)}
      className="cursor-pointer hover:text-cyan-400 transition-colors block truncate max-w-[120px]"
      title={val || "(클릭하여 편집)"}
    >
      {val || <span className="text-faint italic text-xs">-</span>}
    </span>
  );
}

// ─── New Complaint Modal ───────────────────────────────────────────────────────

interface NewComplaintModalProps {
  category: Category;
  onClose: () => void;
  onCreated: (c: ComplaintRow) => void;
  members: AzureMember[];
  membersLoading: boolean;
}

function NewComplaintModal({ category, onClose, onCreated, members, membersLoading }: NewComplaintModalProps) {
  const cfg = getCategory(category);
  const [form, setForm] = useState({
    customer_name: "",
    applicant_name: "",
    job_title: "",
    email: "",
    phone: "",
    reporter: "",
    assignee: "",
    title: "",
    status: cfg.defaultStatus,
    priority: DEFAULT_PRIORITY as string,
    received_at: new Date().toISOString().slice(0, 10),
    phenomenon: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) { setError(`${cfg.titleLabel}을(를) 입력하세요.`); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/complain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, category }),
      });
      if (!res.ok) throw new Error("생성 실패");
      const data = await res.json() as { complaint: ComplaintRow };
      onCreated(data.complaint);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "오류가 발생했습니다.");
    } finally {
      setSaving(false);
    }
  };

  const inputCls = "px-2 py-1.5 bg-panel border border-line2 rounded-lg text-xs text-ink focus:outline-none focus:border-cyan-600 w-full";
  const hasMemberList = !membersLoading && members.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-input border border-line2 rounded-xl p-6 w-full max-w-md space-y-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold text-ink">{cfg.newLabel}</h2>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs text-muted mb-1">{cfg.titleLabel} *</label>
            <input type="text" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} className={inputCls} placeholder={`${cfg.titleLabel} 제목/요약`} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-muted mb-1">고객사</label>
              <input type="text" value={form.customer_name} onChange={(e) => setForm((f) => ({ ...f, customer_name: e.target.value }))} className={inputCls} placeholder="고객사명" />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">신청자</label>
              <input type="text" value={form.applicant_name} onChange={(e) => setForm((f) => ({ ...f, applicant_name: e.target.value }))} className={inputCls} placeholder="신청자 이름" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-muted mb-1">직책</label>
              <input type="text" value={form.job_title} onChange={(e) => setForm((f) => ({ ...f, job_title: e.target.value }))} className={inputCls} placeholder="예) 대리, 매니저" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-muted mb-1">이메일</label>
              <input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className={inputCls} placeholder="user@example.com" />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">연락처</label>
              <input type="text" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} className={inputCls} placeholder="010-0000-0000" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-muted mb-1">
                접수자
                {membersLoading && <span className="ml-1 text-faint">(로딩 중...)</span>}
                {!membersLoading && members.length === 0 && <span className="ml-1 text-faint">(직접 입력)</span>}
              </label>
              {hasMemberList ? (
                <select value={form.reporter} onChange={(e) => setForm((f) => ({ ...f, reporter: e.target.value }))} className={inputCls}>
                  <option value="">선택...</option>
                  {members.map((m) => <option key={m.descriptor} value={m.displayName}>{m.displayName}</option>)}
                </select>
              ) : (
                <input type="text" value={form.reporter} onChange={(e) => setForm((f) => ({ ...f, reporter: e.target.value }))} className={inputCls} placeholder="접수자명" />
              )}
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">담당자</label>
              {hasMemberList ? (
                <select value={form.assignee} onChange={(e) => setForm((f) => ({ ...f, assignee: e.target.value }))} className={inputCls}>
                  <option value="">선택...</option>
                  {members.map((m) => <option key={m.descriptor} value={m.displayName}>{m.displayName}</option>)}
                </select>
              ) : (
                <input type="text" value={form.assignee} onChange={(e) => setForm((f) => ({ ...f, assignee: e.target.value }))} className={inputCls} placeholder="담당자명" />
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-muted mb-1">진행 상태</label>
              <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))} className={inputCls}>
                {cfg.statuses.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">우선순위</label>
              <select value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))} className={inputCls}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-muted mb-1">접수일</label>
              <input type="date" value={form.received_at} onChange={(e) => setForm((f) => ({ ...f, received_at: e.target.value }))} className={inputCls} />
            </div>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">현상 (상세)</label>
            <textarea
              value={form.phenomenon}
              onChange={(e) => setForm((f) => ({ ...f, phenomenon: e.target.value }))}
              rows={4}
              className={`${inputCls} resize-y leading-relaxed`}
              placeholder="발생 현상을 상세히 기록하세요. (증상, 발생 시점·조건, 영향 범위, 재현 방법 등)"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-muted hover:text-ink rounded-lg hover:bg-input transition-colors">취소</button>
            <button type="submit" disabled={saving} className="px-3 py-1.5 text-xs bg-cyan-700 text-white rounded-lg hover:bg-cyan-600 disabled:opacity-50">
              {saving ? "저장 중..." : "등록"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Detail Modal (빠른 보기) ─────────────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[11px] text-faint">{label}</span>
      <span className="text-xs text-ink2 truncate" title={typeof value === "string" ? value : undefined}>
        {value || <span className="text-faint italic">-</span>}
      </span>
    </div>
  );
}

function DetailTextBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] text-faint mb-1">{label}</p>
      <p className="text-xs text-ink2 whitespace-pre-wrap leading-relaxed bg-panel/60 border border-line rounded-lg px-3 py-2">
        {value || <span className="text-faint italic">-</span>}
      </p>
    </div>
  );
}

interface DetailModalProps {
  complaint: ComplaintRow;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
}

function DetailModal({ complaint: c, onClose, onPrev, onNext, hasPrev, hasNext }: DetailModalProps) {
  const cfg = getCategory(c.category);

  // ← / → 로 이전·다음 민원, Esc 로 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft")       onPrev();
      else if (e.key === "ArrowRight") onNext();
      else if (e.key === "Escape")     onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onPrev, onNext, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      {/* 이전 */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onPrev(); }}
        disabled={!hasPrev}
        className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-panel/80 border border-line2 hover:bg-panel text-ink text-xl flex items-center justify-center z-10 disabled:opacity-30 disabled:cursor-not-allowed"
        title="이전 (←)"
        aria-label="이전"
      >
        ‹
      </button>
      {/* 다음 */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onNext(); }}
        disabled={!hasNext}
        className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-panel/80 border border-line2 hover:bg-panel text-ink text-xl flex items-center justify-center z-10 disabled:opacity-30 disabled:cursor-not-allowed"
        title="다음 (→)"
        aria-label="다음"
      >
        ›
      </button>

      <div className="bg-input border border-line2 rounded-xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* 헤더: 좌측 확대(상세 이동) 버튼 + 제목 + 닫기 */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-line">
          <div className="flex items-center gap-2 min-w-0">
            <Link
              href={`/complain/${c.id}`}
              className="p-1 rounded text-faint hover:text-cyan-400 hover:bg-panel transition-colors flex-shrink-0"
              title="상세 페이지로 이동"
              aria-label="상세 페이지로 이동"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              </svg>
            </Link>
            <h2 className="text-sm font-semibold text-ink truncate" title={c.title}>
              {c.title || "(제목 없음)"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded text-faint hover:text-ink hover:bg-panel transition-colors flex-shrink-0"
            title="닫기"
            aria-label="닫기"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 본문 */}
        <div className="overflow-y-auto px-5 py-4 space-y-4">
          <div className="flex items-center gap-2">
            <StatusBadge status={c.status} />
            <PriorityBadge priority={c.priority || "medium"} />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
            <DetailRow label="고객사"  value={c.customer_name} />
            <DetailRow label="신청자"  value={c.applicant_name} />
            <DetailRow label="직책"    value={c.job_title} />
            <DetailRow label="이메일"  value={c.email} />
            <DetailRow label="연락처"  value={c.phone} />
            <DetailRow label="접수자"  value={c.reporter} />
            <DetailRow label="담당자"  value={c.assignee} />
            <DetailRow label="접수일"  value={c.received_at} />
            <DetailRow label="완료일"  value={c.resolved_at ?? ""} />
          </div>

          <div className="space-y-3 pt-1">
            <DetailTextBlock label={cfg.titleLabel} value={c.title} />
            <DetailTextBlock label="현상"      value={c.phenomenon} />
            <DetailTextBlock label="조치 방법" value={c.action_method} />
            <DetailTextBlock label="조치 결과" value={c.action_result} />
            {c.response_status && <DetailTextBlock label="대응 현황" value={c.response_status} />}
          </div>
        </div>

        {/* 푸터 */}
        <div className="px-5 py-3 border-t border-line flex justify-end">
          <Link
            href={`/complain/${c.id}`}
            className="px-3 py-1.5 text-xs bg-cyan-700 text-white rounded-lg hover:bg-cyan-600 transition-colors"
          >
            상세 페이지에서 편집
          </Link>
        </div>
      </div>
    </div>
  );
}

// ─── Delete Confirm Modal ───────────────────────────────────────────────────────

interface DeleteConfirmModalProps {
  complaint: ComplaintRow;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

function DeleteConfirmModal({ complaint, onCancel, onConfirm }: DeleteConfirmModalProps) {
  const [deleting, setDeleting] = useState(false);

  const handleConfirm = async () => {
    setDeleting(true);
    try { await onConfirm(); } finally { setDeleting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div className="bg-input border border-red-500/40 rounded-xl p-6 w-full max-w-sm space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-red-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <h2 className="text-sm font-semibold text-ink">삭제 확인</h2>
        </div>
        <p className="text-xs text-muted leading-relaxed">
          <span className="text-ink font-medium">{complaint.title || "(제목 없음)"}</span> 항목을 삭제하시겠습니까?<br />
          삭제하면 <span className="text-red-400">첨부 파일을 포함해 되돌릴 수 없습니다.</span>
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="px-3 py-1.5 text-xs text-muted hover:text-ink rounded-lg hover:bg-panel transition-colors disabled:opacity-50"
          >
            취소
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={deleting}
            className="px-3 py-1.5 text-xs bg-red-600 text-white rounded-lg hover:bg-red-500 disabled:opacity-50 transition-colors"
          >
            {deleting ? "삭제 중..." : "삭제"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Stat Cards ───────────────────────────────────────────────────────────────

function StatCards({ complaints, category }: { complaints: ComplaintRow[]; category: Category }) {
  const cfg = getCategory(category);
  const total = complaints.length;
  const doneCount = complaints.filter((c) => cfg.doneStatuses.includes(c.status)).length;
  const openCount = total - doneCount;
  const doneRate = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  const cards = [
    { label: "전체", value: total, hint: "건", accent: "text-ink" },
    { label: "진행 중", value: openCount, hint: "건", accent: "text-amber-400" },
    { label: "완료", value: doneCount, hint: "건", accent: "text-green-400" },
    { label: "완료율", value: doneRate, hint: "%", accent: "text-cyan-400" },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {cards.map((c) => (
        <div key={c.label} className="rounded-xl border border-line bg-input/40 px-4 py-3">
          <div className="text-xs text-faint">{c.label}</div>
          <div className={`mt-1 text-2xl font-semibold ${c.accent}`}>
            {c.value}<span className="ml-1 text-xs text-faint font-normal">{c.hint}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Kanban Board ─────────────────────────────────────────────────────────────

interface KanbanProps {
  complaints: ComplaintRow[];
  category: Category;
  onPatch: (id: number, field: string, value: string) => void;
  onDelete: (id: number) => void;
  onOpenDetail: (c: ComplaintRow) => void;
}

function Kanban({ complaints, category, onPatch, onDelete, onOpenDetail }: KanbanProps) {
  const cfg = getCategory(category);
  const [dragId, setDragId] = useState<number | null>(null);
  const [overStatus, setOverStatus] = useState<string | null>(null);

  const byStatus = useMemo(() => {
    const map: Record<string, ComplaintRow[]> = {};
    for (const s of cfg.statuses) map[s] = [];
    for (const c of complaints) {
      if (map[c.status]) map[c.status].push(c);
      else (map[c.status] = map[c.status] || []).push(c); // 정의 외 상태 방어
    }
    return map;
  }, [complaints, cfg.statuses]);

  const handleDrop = (status: string) => {
    if (dragId != null) {
      const card = complaints.find((c) => c.id === dragId);
      if (card && card.status !== status) onPatch(dragId, "status", status);
    }
    setDragId(null);
    setOverStatus(null);
  };

  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex gap-3 min-w-max">
        {cfg.statuses.map((status) => {
          const items = byStatus[status] ?? [];
          const isOver = overStatus === status;
          return (
            <div
              key={status}
              onDragOver={(e) => { e.preventDefault(); setOverStatus(status); }}
              onDragLeave={() => setOverStatus((s) => (s === status ? null : s))}
              onDrop={() => handleDrop(status)}
              className={`w-60 flex-shrink-0 rounded-xl border border-t-2 bg-input/30 ${statusAccentClass(status)} ${isOver ? "ring-2 ring-cyan-500/60 bg-input/60" : "border-line"}`}
            >
              <div className="flex items-center justify-between px-3 py-2 border-b border-line">
                <span className="text-xs font-medium text-ink2">{status}</span>
                <span className="text-xs text-faint bg-panel rounded-full px-1.5">{items.length}</span>
              </div>
              <div className="p-2 space-y-2 min-h-[60px] max-h-[480px] overflow-y-auto">
                {items.map((c) => (
                  <div
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    draggable
                    onDragStart={() => setDragId(c.id)}
                    onDragEnd={() => { setDragId(null); setOverStatus(null); }}
                    onClick={() => onOpenDetail(c)}
                    onKeyDown={(e) => { if (e.key === "Enter") onOpenDetail(c); }}
                    className={`group relative block rounded-lg border border-line bg-panel px-3 py-2 cursor-pointer active:cursor-grabbing hover:border-cyan-600/60 transition-colors ${dragId === c.id ? "opacity-40" : ""}`}
                  >
                    {/* 삭제 버튼 (호버 시 노출) */}
                    <button
                      type="button"
                      draggable={false}
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete(c.id); }}
                      className="absolute top-1 right-1 p-1 rounded text-faint hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-opacity"
                      title="삭제"
                      aria-label="삭제"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>

                    <div className="text-xs font-medium text-ink truncate pr-5" title={c.title}>
                      {c.title || <span className="text-faint italic">(제목 없음)</span>}
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-1">
                      <span className="text-xs text-faint truncate">
                        {[c.customer_name, c.applicant_name].filter(Boolean).join(" · ") || "-"}
                      </span>
                      {c.assignee && (
                        <span className="text-xs text-cyan-400 truncate flex-shrink-0">{c.assignee}</span>
                      )}
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-1">
                      <PriorityBadge priority={c.priority || "medium"} />
                      {c.received_at && (
                        <span className="text-[10px] text-faint">{c.received_at}</span>
                      )}
                    </div>
                  </div>
                ))}
                {items.length === 0 && (
                  <div className="text-[11px] text-faint text-center py-3">비어 있음</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Filter Bar ───────────────────────────────────────────────────────────────

interface FilterBarProps {
  category: Category;
  search: string;
  onSearch: (v: string) => void;
  statusFilter: string;
  onStatus: (v: string) => void;
  priorityFilter: string;
  onPriority: (v: string) => void;
  assigneeFilter: string;
  onAssignee: (v: string) => void;
  uniqueAssignees: string[];
  total: number;
  filtered: number;
  onReset: () => void;
}

function FilterBar({
  category,
  search, onSearch,
  statusFilter, onStatus,
  priorityFilter, onPriority,
  assigneeFilter, onAssignee,
  uniqueAssignees,
  total, filtered,
  onReset,
}: FilterBarProps) {
  const cfg = getCategory(category);
  const isFiltered = search || statusFilter !== "전체" || priorityFilter !== "전체" || assigneeFilter !== "전체";

  return (
    <div className="space-y-2">
      {/* 검색 + 담당자 + 초기화 */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* 검색창 */}
        <div className="relative flex-1 min-w-[180px]">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35m0 0A7 7 0 104.65 4.65a7 7 0 0011.99 11.99z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="고객사, 내용, 접수자, 담당자 검색..."
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-panel border border-line rounded-lg text-ink placeholder-faint focus:outline-none focus:border-cyan-600"
          />
          {search && (
            <button onClick={() => onSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-ink">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* 담당자 필터 */}
        {uniqueAssignees.length > 0 && (
          <select
            value={assigneeFilter}
            onChange={(e) => onAssignee(e.target.value)}
            className="px-2 py-1.5 text-xs bg-panel border border-line rounded-lg text-ink focus:outline-none focus:border-cyan-600"
          >
            <option value="전체">담당자 전체</option>
            {uniqueAssignees.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        )}

        {/* 결과 카운트 + 초기화 */}
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-xs text-faint">
            {isFiltered ? (
              <><span className="text-ink font-medium">{filtered}</span> / {total}건</>
            ) : (
              <>{total}건</>
            )}
          </span>
          {isFiltered && (
            <button
              onClick={onReset}
              className="text-xs text-faint hover:text-ink px-2 py-1 rounded hover:bg-input transition-colors flex items-center gap-1"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              초기화
            </button>
          )}
        </div>
      </div>

      {/* 상태 필터 칩 */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {["전체", ...cfg.statuses].map((s) => {
          const isActive = statusFilter === s;
          const base = "px-2.5 py-0.5 text-xs rounded-full border transition-colors";
          const cls = isActive
            ? "bg-ink text-panel border-ink"
            : "border-line text-muted hover:border-line2 hover:text-ink2";
          return (
            <button key={s} onClick={() => onStatus(s)} className={`${base} ${cls}`}>
              {s}
            </button>
          );
        })}
      </div>

      {/* 우선순위 필터 칩 */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {["전체", ...PRIORITIES].map((p) => {
          const isActive = priorityFilter === p;
          const base = "px-2.5 py-0.5 text-xs rounded-full border transition-colors";
          const cls = isActive
            ? "bg-ink text-panel border-ink"
            : "border-line text-muted hover:border-line2 hover:text-ink2";
          return (
            <button key={p} onClick={() => onPriority(p)} className={`${base} ${cls}`}>
              {p === "전체" ? p : PRIORITY_LABEL[p as keyof typeof PRIORITY_LABEL]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ComplainList({ category }: { category: Category }) {
  const cfg = getCategory(category);
  const [complaints, setComplaints] = useState<ComplaintRow[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState("");
  const [showModal, setShowModal]   = useState(false);
  const [members, setMembers]       = useState<AzureMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [view, setView]             = useState<"kanban" | "table">("kanban");

  // ── Filter state ────────────────────────────────────────────────────────────
  const [search, setSearch]               = useState("");
  const [statusFilter, setStatusFilter]   = useState("전체");
  const [priorityFilter, setPriorityFilter] = useState("전체");
  const [assigneeFilter, setAssigneeFilter] = useState("전체");

  const loadComplaints = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/complain?category=${category}`);
      if (!res.ok) throw new Error("데이터 로드 실패");
      const data = await res.json() as { complaints: ComplaintRow[] };
      setComplaints(data.complaints);
    } catch (e) {
      setError(e instanceof Error ? e.message : "오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }, [category]);

  useEffect(() => { loadComplaints(); }, [loadComplaints]);

  useEffect(() => {
    fetch("/api/azure/members")
      .then((r) => r.json())
      .then((data: { members: AzureMember[]; error?: string }) => {
        setMembers(data.members ?? []);
      })
      .catch(() => setMembers([]))
      .finally(() => setMembersLoading(false));
  }, []);

  const patch = useCallback(async (id: number, field: string, value: string) => {
    // 낙관적 업데이트 (칸반 드래그 반응성)
    setComplaints((prev) => prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
    try {
      const res = await fetch(`/api/complain/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) throw new Error("저장 실패");
      const data = await res.json() as { complaint: ComplaintRow };
      setComplaints((prev) => prev.map((c) => (c.id === id ? { ...c, ...data.complaint } : c)));
    } catch (e) {
      console.error("[complain] patch error:", e);
      loadComplaints(); // 실패 시 서버 상태로 복구
    }
  }, [loadComplaints]);

  // 빠른 보기(상세 팝업) 대상 (칸반·테이블 공통)
  const [detailTarget, setDetailTarget] = useState<ComplaintRow | null>(null);

  // 삭제 확인 모달 대상 (칸반·테이블 공통)
  const [deleteTarget, setDeleteTarget] = useState<ComplaintRow | null>(null);

  const requestDelete = useCallback((id: number) => {
    setComplaints((prev) => {
      const target = prev.find((c) => c.id === id) ?? null;
      setDeleteTarget(target);
      return prev;
    });
  }, []);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    try {
      await fetch(`/api/complain/${id}`, { method: "DELETE" });
      setComplaints((prev) => prev.filter((c) => c.id !== id));
    } catch (e) {
      console.error("[complain] delete error:", e);
    } finally {
      setDeleteTarget(null);
    }
  };

  // ── Derived: unique assignees, filtered list ────────────────────────────────
  const uniqueAssignees = useMemo(() => {
    const set = new Set(complaints.map((c) => c.assignee).filter(Boolean));
    return Array.from(set).sort();
  }, [complaints]);

  const filtered = useMemo(() => {
    return complaints.filter((c) => {
      if (statusFilter !== "전체" && c.status !== statusFilter) return false;
      if (priorityFilter !== "전체" && c.priority !== priorityFilter) return false;
      if (assigneeFilter !== "전체" && c.assignee !== assigneeFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          c.customer_name.toLowerCase().includes(q) ||
          c.applicant_name.toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q) ||
          c.phone.toLowerCase().includes(q) ||
          c.title.toLowerCase().includes(q) ||
          c.reporter.toLowerCase().includes(q) ||
          c.assignee.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [complaints, statusFilter, priorityFilter, assigneeFilter, search]);

  const resetFilters = () => {
    setSearch("");
    setStatusFilter("전체");
    setPriorityFilter("전체");
    setAssigneeFilter("전체");
  };

  if (loading) return <div className="text-xs text-faint py-8 text-center">로딩 중...</div>;
  if (error)   return <div className="text-xs text-red-400 py-8 text-center">{error}</div>;

  return (
    <div className="space-y-4">
      {/* 통계 카드 */}
      <StatCards complaints={complaints} category={category} />

      {/* Toolbar */}
      <div className="flex items-start justify-between gap-2">
        <FilterBar
          category={category}
          search={search} onSearch={setSearch}
          statusFilter={statusFilter} onStatus={setStatusFilter}
          priorityFilter={priorityFilter} onPriority={setPriorityFilter}
          assigneeFilter={assigneeFilter} onAssignee={setAssigneeFilter}
          uniqueAssignees={uniqueAssignees}
          total={complaints.length} filtered={filtered.length}
          onReset={resetFilters}
        />
        <div className="flex items-center gap-2 shrink-0">
          {/* 보기 전환 */}
          <div className="flex rounded-lg border border-line overflow-hidden">
            <button
              onClick={() => setView("kanban")}
              className={`px-2.5 py-1.5 text-xs transition-colors ${view === "kanban" ? "bg-cyan-700 text-white" : "text-muted hover:text-ink hover:bg-input"}`}
            >
              칸반
            </button>
            <button
              onClick={() => setView("table")}
              className={`px-2.5 py-1.5 text-xs transition-colors ${view === "table" ? "bg-cyan-700 text-white" : "text-muted hover:text-ink hover:bg-input"}`}
            >
              테이블
            </button>
          </div>
          <button
            onClick={() => setShowModal(true)}
            className="px-3 py-1.5 text-xs bg-cyan-700 text-white rounded-lg hover:bg-cyan-600 transition-colors"
          >
            + {cfg.newLabel}
          </button>
        </div>
      </div>

      {/* 칸반 보드 (필터 무시하고 전체 단계 표시) */}
      {view === "kanban" && (
        <Kanban complaints={filtered} category={category} onPatch={patch} onDelete={requestDelete} onOpenDetail={setDetailTarget} />
      )}

      {/* Table */}
      {view === "table" && (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-xs text-ink2">
            <thead>
              <tr className="border-b border-line text-faint text-left bg-input/60">
                <th className="px-3 py-2.5 font-medium w-10">No.</th>
                <th className="px-3 py-2.5 font-medium">고객사</th>
                <th className="px-3 py-2.5 font-medium">신청자</th>
                <th className="px-3 py-2.5 font-medium">이메일</th>
                <th className="px-3 py-2.5 font-medium">연락처</th>
                <th className="px-3 py-2.5 font-medium">접수자</th>
                <th className="px-3 py-2.5 font-medium">담당자</th>
                <th className="px-3 py-2.5 font-medium min-w-[160px]">제목</th>
                <th className="px-3 py-2.5 font-medium">우선순위</th>
                <th className="px-3 py-2.5 font-medium">접수일</th>
                <th className="px-3 py-2.5 font-medium">등록일</th>
                <th className="px-3 py-2.5 font-medium">진행 상태</th>
                <th className="px-3 py-2.5 font-medium">완료일</th>
                <th className="px-3 py-2.5 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={14} className="px-3 py-10 text-center text-faint">
                    {complaints.length === 0 ? `등록된 ${cfg.label} 항목이 없습니다.` : "검색 조건에 맞는 항목이 없습니다."}
                  </td>
                </tr>
              )}
              {filtered.map((c, i) => (
                <ComplaintRowItem
                  key={c.id}
                  complaint={c}
                  index={filtered.length - i}
                  statuses={cfg.statuses}
                  members={members}
                  membersLoading={membersLoading}
                  onPatch={patch}
                  onDelete={requestDelete}
                  onOpenDetail={setDetailTarget}
                  search={search}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <NewComplaintModal
          category={category}
          onClose={() => setShowModal(false)}
          onCreated={(c) => setComplaints((prev) => [c, ...prev])}
          members={members}
          membersLoading={membersLoading}
        />
      )}

      {detailTarget && (() => {
        const idx = filtered.findIndex((c) => c.id === detailTarget.id);
        return (
          <DetailModal
            complaint={detailTarget}
            onClose={() => setDetailTarget(null)}
            onPrev={() => { if (idx > 0) setDetailTarget(filtered[idx - 1]); }}
            onNext={() => { if (idx >= 0 && idx < filtered.length - 1) setDetailTarget(filtered[idx + 1]); }}
            hasPrev={idx > 0}
            hasNext={idx >= 0 && idx < filtered.length - 1}
          />
        );
      })()}

      {deleteTarget && (
        <DeleteConfirmModal
          complaint={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}

// ─── Highlight matched text ───────────────────────────────────────────────────

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query || !text) return <>{text || <span className="text-faint italic">-</span>}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-200 dark:bg-yellow-800/60 text-ink rounded-sm px-0.5">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

// ─── Table Row ────────────────────────────────────────────────────────────────

interface ComplaintRowItemProps {
  complaint: ComplaintRow;
  index: number;
  statuses: string[];
  members: AzureMember[];
  membersLoading: boolean;
  onPatch: (id: number, field: string, value: string) => void;
  onDelete: (id: number) => void;
  onOpenDetail: (c: ComplaintRow) => void;
  search: string;
}

function ComplaintRowItem({ complaint: c, index, statuses, members, membersLoading, onPatch, onDelete, onOpenDetail, search }: ComplaintRowItemProps) {
  const [hovering, setHovering] = useState(false);

  return (
    <tr
      className="border-b border-line/50 hover:bg-input/30 transition-colors group"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <td className="px-3 py-2 text-faint">{index}</td>

      {/* 고객사 */}
      <td className="px-3 py-2 font-medium text-ink">
        <EditableCell value={c.customer_name} onSave={(v) => onPatch(c.id, "customer_name", v)} />
      </td>

      {/* 신청자 */}
      <td className="px-3 py-2">
        <EditableCell value={c.applicant_name} onSave={(v) => onPatch(c.id, "applicant_name", v)} />
      </td>

      {/* 이메일 */}
      <td className="px-3 py-2">
        <EditableCell value={c.email} onSave={(v) => onPatch(c.id, "email", v)} />
      </td>

      {/* 연락처 */}
      <td className="px-3 py-2">
        <EditableCell value={c.phone} onSave={(v) => onPatch(c.id, "phone", v)} />
      </td>

      {/* 접수자 */}
      <td className="px-3 py-2">
        <EditableCell value={c.reporter} onSave={(v) => onPatch(c.id, "reporter", v)} type="member" members={members} membersLoading={membersLoading} />
      </td>

      {/* 담당자 */}
      <td className="px-3 py-2">
        <EditableCell value={c.assignee} onSave={(v) => onPatch(c.id, "assignee", v)} type="member" members={members} membersLoading={membersLoading} />
      </td>

      {/* 제목 (클릭 시 빠른 보기 팝업) */}
      <td className="px-3 py-2">
        <button
          type="button"
          onClick={() => onOpenDetail(c)}
          className="text-left cursor-pointer hover:text-cyan-400 transition-colors block truncate max-w-[200px]"
          title={c.title || "(제목 없음)"}
        >
          {c.title ? <Highlight text={c.title} query={search} /> : <span className="text-faint italic">(제목 없음)</span>}
        </button>
      </td>

      {/* 우선순위 */}
      <td className="px-3 py-2">
        <EditableCell value={c.priority} onSave={(v) => onPatch(c.id, "priority", v)} type="select" statuses={PRIORITIES} badge="priority" />
      </td>

      {/* 접수일 */}
      <td className="px-3 py-2">
        <EditableCell value={c.received_at} onSave={(v) => onPatch(c.id, "received_at", v)} type="date" />
      </td>

      {/* 등록일 */}
      <td className="px-3 py-2 text-faint">{c.created_at ? c.created_at.slice(0, 10) : "-"}</td>

      {/* 진행 상태 */}
      <td className="px-3 py-2">
        <EditableCell value={c.status} onSave={(v) => onPatch(c.id, "status", v)} type="select" statuses={statuses} />
      </td>

      {/* 완료일 */}
      <td className="px-3 py-2">
        <EditableCell value={c.resolved_at ?? ""} onSave={(v) => onPatch(c.id, "resolved_at", v)} type="date" />
      </td>

      {/* 삭제 */}
      <td className="px-2 py-2">
        <button
          onClick={() => onDelete(c.id)}
          className={`transition-opacity p-1 text-faint hover:text-red-400 rounded ${hovering ? "opacity-100" : "opacity-0"}`}
          title="삭제"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </td>
    </tr>
  );
}
