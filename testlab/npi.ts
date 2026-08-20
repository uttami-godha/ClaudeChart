// NPI (Non-Public Information) detector.
// Flags records that contain personal / non-public information.
// Sample data is fully synthetic and intentionally NON-sensitive: emails,
// phones, and names only — never real SSNs, card numbers, or account numbers.

import { mask } from "./mask.ts";

export interface DataRecord {
  id: number;
  [field: string]: unknown;
}

const SAMPLES: DataRecord[] = [
  { id: 1, email: "jane.doe@example.com", note: "prefers email contact" },
  { id: 2, city: "Austin", plan: "Enterprise" },
  { id: 3, name: "John Q. Public", ticket: "T-4471" },
];

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE = /\b\d{3}[-.\s]?\d{3,4}\b/;
const SSN_FORMAT = /\b\d{3}-\d{2}-\d{4}\b/;
const SENSITIVE_FIELDS = new Set(["ssn", "dob", "account", "accountNumber"]);

// Return a reason string for each field that looks like non-public info.
function detect(rec: DataRecord): string[] {
  const reasons: string[] = [];
  for (const [field, value] of Object.entries(rec)) {
    if (SENSITIVE_FIELDS.has(field)) reasons.push(`sensitive field "${field}"`);
    if (typeof value !== "string") continue;
    if (EMAIL.test(value)) reasons.push(`email (${mask(value)}) in "${field}"`);
    if (PHONE.test(value)) reasons.push(`phone (${mask(value)}) in "${field}"`);
    if (SSN_FORMAT.test(value)) reasons.push(`ssn-format value in "${field}"`);
  }
  return reasons;
}

export function classify(rec: DataRecord): {
  id: number;
  isNpi: boolean;
  severity: "none" | "low" | "high";
  reasons: string[];
} {
  const reasons = detect(rec);
  const severity = reasons.some((r) => r.startsWith("sensitive") || r.includes("ssn"))
    ? "high"
    : reasons.length > 0
      ? "low"
      : "none";
  return { id: rec.id, isNpi: reasons.length > 0, severity, reasons };
}

for (const rec of SAMPLES) {
  const r = classify(rec);
  console.log(`${r.id} NPI=${r.isNpi} ${r.reasons.join(", ")}`);
}