import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

export interface PromptRecord {
  id: string;
  title: string;        // 파일명 (e.g. text_features.json)
  version: string;      // e.g. v1.1.1.1
  f1Score?: number;     // 0~1
  appliedOnSite: boolean;
  appliedAt?: string;   // ISO date
  tuner: string;        // 튜닝자
  purpose: string;      // 업데이트 목적
  inUse: boolean;       // 사용중
  fileName: string;     // 저장된 파일명
  createdAt: string;
}

function dir(customerId: string) {
  const d = path.join(process.cwd(), "data", "prompts", customerId);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function indexFile(customerId: string) {
  return path.join(dir(customerId), "index.json");
}

export function filesDir(customerId: string) {
  const d = path.join(dir(customerId), "files");
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

export function getPrompts(customerId: string): PromptRecord[] {
  const f = indexFile(customerId);
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, "utf-8"));
}

export function addPrompt(customerId: string, data: Omit<PromptRecord, "id" | "createdAt">): PromptRecord {
  const records = getPrompts(customerId);
  const record: PromptRecord = { ...data, id: randomUUID(), createdAt: new Date().toISOString() };
  records.push(record);
  fs.writeFileSync(indexFile(customerId), JSON.stringify(records, null, 2));
  return record;
}

export function updatePrompt(customerId: string, id: string, data: Partial<PromptRecord>): PromptRecord | null {
  const records = getPrompts(customerId);
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  records[idx] = { ...records[idx], ...data };
  fs.writeFileSync(indexFile(customerId), JSON.stringify(records, null, 2));
  return records[idx];
}

export function deletePrompt(customerId: string, id: string): boolean {
  const records = getPrompts(customerId);
  const record = records.find((r) => r.id === id);
  if (!record) return false;
  const filtered = records.filter((r) => r.id !== id);
  // 파일도 삭제
  const filePath = path.join(filesDir(customerId), record.fileName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  fs.writeFileSync(indexFile(customerId), JSON.stringify(filtered, null, 2));
  return true;
}
