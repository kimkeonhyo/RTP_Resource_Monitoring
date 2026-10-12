"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  getCategory, statusBadgeClass,
  PRIORITIES, PRIORITY_LABEL, PRIORITY_SLA, priorityBadgeClass,
} from "@/lib/complain-categories";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Complaint {
  id: number;
  customer_name: string;
  applicant_name: string;
  email: string;
  phone: string;
  job_title: string;
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
}

interface ComplaintFile {
  id: number;
  complaint_id: number;
  file_name: string;
  file_type: string;
  file_size: number | null;
  uploaded_at: string;
  section?: string;
}

interface AzureMember {
  subjectKind: string;
  displayName: string;
  mailAddress: string;
  descriptor: string;
}

// 텍스트 영역 필드 묶음 (페이지 단위 저장 대상)
interface TextDraft {
  title: string;
  phenomenon: string;
  action_method: string;
  action_result: string;
  response_status: string;
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
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${priorityBadgeClass(priority)}`}
      title={PRIORITY_SLA[priority as keyof typeof PRIORITY_SLA]}
    >
      {PRIORITY_LABEL[priority as keyof typeof PRIORITY_LABEL] ?? priority}
    </span>
  );
}

// ─── Editable Inline Field (소형 필드 — blur 시 즉시 저장) ────────────────────

interface EditableFieldProps {
  label: string;
  value: string;
  onSave: (val: string) => void;
  type?: "text" | "date" | "select" | "member";
  options?: string[];
  /** select 뱃지 스타일: 진행 상태(status) | 우선순위(priority) */
  badge?: "status" | "priority";
  members?: AzureMember[];
  membersLoading?: boolean;
}

function EditableField({ label, value, onSave, type = "text", options, badge = "status", members, membersLoading }: EditableFieldProps) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);

  useEffect(() => { setVal(value); }, [value]);
  useEffect(() => { if (editing && inputRef.current) inputRef.current.focus(); }, [editing]);

  const handleBlur = () => {
    setEditing(false);
    if (val !== value) onSave(val);
  };

  const inputCls = "px-2 py-1 bg-panel border border-gray-600 rounded text-xs text-ink focus:outline-none focus:border-cyan-600 w-full";

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-faint">{label}</span>
      {editing ? (
        type === "select" && options ? (
          <select
            ref={inputRef as React.RefObject<HTMLSelectElement>}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={handleBlur}
            className={inputCls}
          >
            {options.map((o) => (
              <option key={o} value={o}>
                {badge === "priority" ? PRIORITY_LABEL[o as keyof typeof PRIORITY_LABEL] ?? o : o}
              </option>
            ))}
          </select>
        ) : type === "member" ? (
          members && members.length > 0 ? (
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
          ) : (
            <input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              type="text"
              value={val}
              onChange={(e) => setVal(e.target.value)}
              onBlur={handleBlur}
              placeholder={membersLoading ? "로딩 중..." : ""}
              className={inputCls}
            />
          )
        ) : (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type={type}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={handleBlur}
            className={inputCls}
          />
        )
      ) : (
        <span
          onClick={() => setEditing(true)}
          className="text-sm text-ink cursor-pointer hover:text-cyan-300 transition-colors py-1"
        >
          {val ? (
            type === "select" ? (
              badge === "priority" ? <PriorityBadge priority={val} /> : <StatusBadge status={val} />
            ) : val
          ) : (
            <span className="text-faint italic text-xs">-</span>
          )}
        </span>
      )}
    </div>
  );
}

// ─── Simple Textarea (draft 상태는 부모가 관리) ────────────────────────────────

interface DraftTextareaProps {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  rows?: number;
}

function DraftTextarea({ value, onChange, placeholder, rows = 4 }: DraftTextareaProps) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      placeholder={placeholder}
      className="w-full bg-transparent border border-line2/40 hover:border-gray-600 focus:border-cyan-600 rounded-lg px-3 py-2 text-sm text-ink2 focus:outline-none resize-y min-h-[5rem] transition-colors"
    />
  );
}

// ─── Lightbox ─────────────────────────────────────────────────────────────────

interface LightboxProps {
  images: ComplaintFile[];
  complaintId: number;
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}

function Lightbox({ images, complaintId, index, onIndex, onClose }: LightboxProps) {
  const count = images.length;
  const prev = useCallback(() => onIndex((index - 1 + count) % count), [index, count, onIndex]);
  const next = useCallback(() => onIndex((index + 1) % count), [index, count, onIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    // 배경 스크롤 잠금
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [prev, next, onClose]);

  const cur = images[index];

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* 닫기 */}
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 text-white/70 hover:text-white p-2"
        title="닫기 (Esc)"
      >
        <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* 이전 */}
      {count > 1 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); prev(); }}
          className="absolute left-4 text-white/70 hover:text-white p-2"
          title="이전 (←)"
        >
          <svg className="w-9 h-9" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      )}

      {/* 이미지 */}
      <div className="max-w-[90vw] max-h-[90vh] flex flex-col items-center" onClick={(e) => e.stopPropagation()}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/complain/${complaintId}/files/${cur.id}`}
          alt={cur.file_name}
          className="max-w-[90vw] max-h-[82vh] object-contain rounded-lg shadow-2xl"
        />
        <div className="mt-3 text-center text-sm text-white/80">
          {cur.file_name}
          {count > 1 && <span className="ml-2 text-white/50">{index + 1} / {count}</span>}
        </div>
      </div>

      {/* 다음 */}
      {count > 1 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); next(); }}
          className="absolute right-4 text-white/70 hover:text-white p-2"
          title="다음 (→)"
        >
          <svg className="w-9 h-9" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}
    </div>
  );
}

// ─── File Grid ────────────────────────────────────────────────────────────────

interface FileGridProps {
  files: ComplaintFile[];
  complaintId: number;
  onDelete: (fileId: number) => void;
}

function FileGrid({ files, complaintId, onDelete }: FileGridProps) {
  const images = files.filter((f) => f.file_type.startsWith("image/"));
  const videos = files.filter((f) => f.file_type.startsWith("video/"));
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  if (files.length === 0) return null;

  return (
    <div className="space-y-3">
      {lightboxIdx !== null && (
        <Lightbox
          images={images}
          complaintId={complaintId}
          index={lightboxIdx}
          onIndex={setLightboxIdx}
          onClose={() => setLightboxIdx(null)}
        />
      )}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {images.map((f, i) => (
            <div key={f.id} className="relative group">
              <button
                type="button"
                onClick={() => setLightboxIdx(i)}
                className="block cursor-zoom-in"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/complain/${complaintId}/files/${f.id}`}
                  alt={f.file_name}
                  className="w-28 h-28 object-cover rounded-lg border border-line2 hover:border-cyan-600 transition-colors"
                />
              </button>
              <button
                onClick={() => onDelete(f.id)}
                className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 bg-red-900/80 text-red-300 rounded-full p-0.5 transition-opacity"
                title="삭제"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <p className="text-xs text-faint mt-1 truncate w-28">{f.file_name}</p>
            </div>
          ))}
        </div>
      )}
      {videos.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {videos.map((f) => (
            <div key={f.id} className="relative group">
              <video
                src={`/api/complain/${complaintId}/files/${f.id}`}
                controls
                className="w-48 rounded-lg border border-line2"
              />
              <button
                onClick={() => onDelete(f.id)}
                className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 bg-red-900/80 text-red-300 rounded-full p-0.5 transition-opacity"
                title="삭제"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <p className="text-xs text-faint mt-1 truncate w-48">{f.file_name}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ComplainDetail({ id }: { id: string }) {
  const router = useRouter();
  const [complaint, setComplaint] = useState<Complaint | null>(null);
  const [files, setFiles] = useState<ComplaintFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [members, setMembers] = useState<AzureMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadingAction, setUploadingAction] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const actionFileInputRef = useRef<HTMLInputElement | null>(null);

  // ── 페이지 단위 draft (텍스트 영역 필드) ─────────────────────────────────────
  const [draft, setDraft] = useState<TextDraft>({
    title: "", phenomenon: "", action_method: "", action_result: "", response_status: "",
  });
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveOk, setSaveOk] = useState(false);

  // ── 데이터 로드 ───────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/complain/${id}`);
      if (!res.ok) throw new Error("데이터 로드 실패");
      const data = await res.json() as { complaint: Complaint; files: ComplaintFile[] };
      setComplaint(data.complaint);
      setFiles(data.files);
    } catch (e) {
      setError(e instanceof Error ? e.message : "오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // complaint 로드되면 draft 초기화
  useEffect(() => {
    if (!complaint) return;
    setDraft({
      title:           complaint.title ?? "",
      phenomenon:      complaint.phenomenon ?? "",
      action_method:   complaint.action_method ?? "",
      action_result:   complaint.action_result ?? "",
      response_status: complaint.response_status ?? "",
    });
    setIsDirty(false);
  }, [complaint]);

  useEffect(() => {
    fetch("/api/azure/members")
      .then((r) => r.json())
      .then((data: { members: AzureMember[] }) => setMembers(data.members ?? []))
      .catch(() => setMembers([]))
      .finally(() => setMembersLoading(false));
  }, []);

  // ── draft 업데이트 헬퍼 ────────────────────────────────────────────────────────
  const updateDraft = (field: keyof TextDraft, value: string) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
    setIsDirty(true);
    setSaveOk(false);
  };

  // ── 소형 필드 즉시 PATCH (기본 정보 패널) ─────────────────────────────────────
  const patchField = useCallback(async (field: string, value: string) => {
    if (!complaint) return;
    try {
      const res = await fetch(`/api/complain/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) throw new Error("저장 실패");
      const data = await res.json() as { complaint: Complaint };
      setComplaint(data.complaint);
    } catch (e) {
      console.error("[complain-detail] patch error:", e);
      alert("저장 실패: " + (e instanceof Error ? e.message : String(e)));
    }
  }, [id, complaint]);

  // ── 페이지 단위 저장 ──────────────────────────────────────────────────────────
  const handleSaveAll = async () => {
    setSaving(true);
    setSaveOk(false);
    try {
      const res = await fetch(`/api/complain/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) throw new Error("저장 실패");
      const data = await res.json() as { complaint: Complaint };
      setComplaint(data.complaint);
      setIsDirty(false);
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 2500);
    } catch (e) {
      alert("저장 실패: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  };

  // ── 파일 업로드 / 삭제 ────────────────────────────────────────────────────────
  const handleFileUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
    section: "bug" | "action_result" = "bug"
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const setU = section === "action_result" ? setUploadingAction : setUploading;
    const ref  = section === "action_result" ? actionFileInputRef : fileInputRef;
    setU(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("section", section);
      const res = await fetch(`/api/complain/${id}/files`, { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? "업로드 실패");
      }
      const data = await res.json() as { file: ComplaintFile };
      setFiles((prev) => [...prev, data.file]);
    } catch (e) {
      alert(e instanceof Error ? e.message : "업로드 실패");
    } finally {
      setU(false);
      if (ref.current) ref.current.value = "";
    }
  };

  const handleDeleteFile = async (fileId: number) => {
    if (!confirm("파일을 삭제하시겠습니까?")) return;
    try {
      await fetch(`/api/complain/${id}/files/${fileId}`, { method: "DELETE" });
      setFiles((prev) => prev.filter((f) => f.id !== fileId));
    } catch (e) {
      console.error("[complain-detail] delete file error:", e);
    }
  };

  const handleDelete = async () => {
    if (!confirm("이 항목을 삭제하시겠습니까? 첨부 파일도 함께 삭제되며 되돌릴 수 없습니다.")) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/complain/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("삭제 실패");
      router.push("/complain");
    } catch (e) {
      console.error("[complain-detail] delete error:", e);
      alert("삭제에 실패했습니다.");
      setDeleting(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────

  if (loading) return <div className="p-6 text-xs text-faint">로딩 중...</div>;
  if (error || !complaint) return <div className="p-6 text-xs text-red-400">{error || "데이터를 찾을 수 없습니다."}</div>;

  const sectionCls = "bg-input/50 border border-line rounded-xl p-5 space-y-4";
  const labelCls   = "text-xs font-semibold text-muted uppercase tracking-wider";

  return (
    <div className="relative p-6 space-y-6 max-w-4xl">

      {/* ── 상단 sticky 저장 바 ─────────────────────────────────────────────── */}
      {(isDirty || saveOk) && (
        <div className="sticky top-2 z-20 flex items-center justify-between gap-3 bg-panel/95 border border-line2 rounded-xl px-4 py-2.5 shadow-lg backdrop-blur-sm">
          <span className="text-xs text-muted">
            {saveOk
              ? <span className="text-green-400 flex items-center gap-1.5">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  저장되었습니다
                </span>
              : "저장되지 않은 변경사항이 있습니다."}
          </span>
          {isDirty && (
            <button
              onClick={handleSaveAll}
              disabled={saving}
              className="px-4 py-1.5 text-xs font-semibold bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white rounded-lg transition-colors"
            >
              {saving ? "저장 중..." : "저장"}
            </button>
          )}
        </div>
      )}

      {/* 상단 바: 목록으로 + 삭제 */}
      <div className="flex items-center justify-between">
        <Link href="/complain" className="inline-flex items-center gap-1 text-xs text-faint hover:text-cyan-400 transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          목록으로
        </Link>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-400 border border-red-500/40 rounded-lg hover:bg-red-500/10 disabled:opacity-50 transition-colors"
          title="이 항목 삭제"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          {deleting ? "삭제 중..." : "삭제"}
        </button>
      </div>

      {/* ── 기본 정보 패널 (blur 즉시 저장) ───────────────────────────────────── */}
      <div className={sectionCls}>
        <h2 className={labelCls}>기본 정보</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
          <EditableField label="고객사"    value={complaint.customer_name} onSave={(v) => patchField("customer_name", v)} />
          <EditableField label="신청자"    value={complaint.applicant_name} onSave={(v) => patchField("applicant_name", v)} />
          <EditableField label="직책"      value={complaint.job_title}     onSave={(v) => patchField("job_title", v)} />
          <EditableField label="이메일"    value={complaint.email}         onSave={(v) => patchField("email", v)} />
          <EditableField label="연락처"    value={complaint.phone}         onSave={(v) => patchField("phone", v)} />
          <EditableField label="접수자"    value={complaint.reporter}      onSave={(v) => patchField("reporter", v)}      type="member" members={members} membersLoading={membersLoading} />
          <EditableField label="담당자"    value={complaint.assignee}      onSave={(v) => patchField("assignee", v)}      type="member" members={members} membersLoading={membersLoading} />
          <EditableField label="진행 상태" value={complaint.status}        onSave={(v) => patchField("status", v)}        type="select" options={getCategory(complaint.category).statuses} />
          <EditableField label="우선순위"  value={complaint.priority}      onSave={(v) => patchField("priority", v)}      type="select" options={PRIORITIES} badge="priority" />
          <EditableField label="접수일"    value={complaint.received_at}   onSave={(v) => patchField("received_at", v)}   type="date" />
          <EditableField label="개선 완료일" value={complaint.resolved_at ?? ""} onSave={(v) => patchField("resolved_at", v)} type="date" />
        </div>
      </div>

      {/* ── 고객 불만 상세 내용 ────────────────────────────────────────────────── */}
      <div className={sectionCls}>
        <h2 className={labelCls}>고객 불만 상세 내용</h2>

        <div>
          <p className="text-xs text-faint mb-1">불만 내용</p>
          <DraftTextarea
            value={draft.title}
            onChange={(v) => updateDraft("title", v)}
            placeholder="불만 내용을 입력하세요..."
            rows={6}
          />
        </div>

        <div>
          <p className="text-xs text-faint mb-1">현상</p>
          <DraftTextarea
            value={draft.phenomenon}
            onChange={(v) => updateDraft("phenomenon", v)}
            placeholder="발생 현상을 입력하세요..."
            rows={4}
          />
        </div>

        {/* 파일 업로드 */}
        <div>
          <p className="text-xs text-faint mb-2">버그 이미지 &amp; 영상</p>
          <FileGrid files={files.filter((f) => (f.section ?? "bug") === "bug")} complaintId={complaint.id} onDelete={handleDeleteFile} />
          <div className="mt-3">
            <label className="inline-flex items-center gap-2 px-3 py-1.5 text-xs bg-gray-700 text-ink2 rounded-lg hover:bg-gray-600 cursor-pointer transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              {uploading ? "업로드 중..." : "파일 업로드"}
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/x-msvideo"
                onChange={(e) => handleFileUpload(e, "bug")}
                disabled={uploading}
              />
            </label>
            <span className="ml-2 text-xs text-faint">jpg, png, gif, webp, mp4, mov, avi</span>
          </div>
        </div>
      </div>

      {/* ── 조치 내용 ──────────────────────────────────────────────────────────── */}
      <div className={sectionCls}>
        <h2 className={labelCls}>조치 내용</h2>

        <div>
          <p className="text-xs text-faint mb-1">대응현황</p>
          <DraftTextarea
            value={draft.response_status}
            onChange={(v) => updateDraft("response_status", v)}
            placeholder="현재 대응 진행 상황을 입력하세요..."
            rows={4}
          />
        </div>

        <div>
          <p className="text-xs text-faint mb-1">조치 방법</p>
          <DraftTextarea
            value={draft.action_method}
            onChange={(v) => updateDraft("action_method", v)}
            placeholder="조치 방법을 입력하세요..."
            rows={4}
          />
        </div>

        <div>
          <p className="text-xs text-faint mb-1">조치 결과</p>
          <DraftTextarea
            value={draft.action_result}
            onChange={(v) => updateDraft("action_result", v)}
            placeholder="조치 결과를 입력하세요..."
            rows={4}
          />
          {/* 조치 결과 첨부 파일 */}
          <div className="mt-3">
            <FileGrid
              files={files.filter((f) => f.section === "action_result")}
              complaintId={complaint.id}
              onDelete={handleDeleteFile}
            />
            <div className="mt-2">
              <label className="inline-flex items-center gap-2 px-3 py-1.5 text-xs bg-gray-700 text-ink2 rounded-lg hover:bg-gray-600 cursor-pointer transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                {uploadingAction ? "업로드 중..." : "이미지 / 영상 첨부"}
                <input
                  ref={actionFileInputRef}
                  type="file"
                  className="hidden"
                  accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/x-msvideo"
                  onChange={(e) => handleFileUpload(e, "action_result")}
                  disabled={uploadingAction}
                />
              </label>
              <span className="ml-2 text-xs text-faint">jpg, png, gif, webp, mp4, mov, avi</span>
            </div>
          </div>
        </div>
      </div>

      {/* 하단 메타 정보 */}
      <p className="text-xs text-faint">
        등록: {complaint.created_at?.slice(0, 16).replace("T", " ")} &nbsp;/&nbsp; 수정: {complaint.updated_at?.slice(0, 16).replace("T", " ")}
      </p>
    </div>
  );
}
