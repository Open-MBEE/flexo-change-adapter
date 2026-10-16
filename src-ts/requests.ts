import { ValidationRequest, checkResult } from "./contracts.ts";
import { EngineRequest, checkEngineResult } from "./engine-contracts.ts";
import type { RecordData } from "./workspace.ts";
export type WorkRequest = ValidationRequest | EngineRequest;
export const requestFromDict = (v: RecordData): WorkRequest =>
  v.schema_version === 2
    ? EngineRequest.fromDict(v)
    : ValidationRequest.fromDict(v);
export function checkWorkResult(request: WorkRequest, result: RecordData) {
  if (request instanceof EngineRequest) checkEngineResult(request, result);
  else checkResult(request, result);
}
