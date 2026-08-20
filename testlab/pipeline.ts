// Downstream consumer of the NPI detector — makes npi.ts a dependency, so
// editing npi.ts shows a real blast radius in ClaudeChart.
import { classify, type DataRecord } from "./npi.ts";

export function scan(records: DataRecord[]): number {
  return records.filter((r) => classify(r).isNpi).length;
}