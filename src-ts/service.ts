import { requestFromDict, type WorkRequest } from "./requests.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { State } from "./state.ts";
import {
  ValidationRequest,
  DeliveryError,
  canonicalJson,
  digest,
} from "./contracts.ts";
import { Flexo, Snapshot } from "./flexo.ts";
import type { RecordData } from "./workspace.ts";
export interface Runner {
  readyToDispatch?(): void;
  inspect(r: WorkRequest, d: RecordData): Promise<RecordData | null>;
  dispatch(r: WorkRequest, d: RecordData): Promise<string | null>;
}
export async function advance(
  state: State,
  runner: Runner,
  id: string,
  time?: number,
) {
  const row = state.get(id);
  if (row.state === "completed")
    return { event: "work-already-completed", work_id: id };
  const request = requestFromDict(JSON.parse(row.request_json)),
    binding = state.delivery(id),
    observed = await runner.inspect(request, binding);
  if (observed) {
    if (row.state === "pending") state.beginDispatch(id);
    state.attachRun(
      id,
      observed.external_id,
      observed.running || row.state === "running",
    );
    if (observed.result !== null) state.complete(id, observed.result);
    return {
      event: "work-reconciled",
      work_id: id,
      state: state.get(id).state,
      external_id: observed.external_id,
    };
  }
  if (["submitted", "running"].includes(row.state))
    throw Error("Runner lost reconciled work identity");
  runner.readyToDispatch?.();
  if (!state.claimDeliveryAttempt(id, time))
    return {
      event: "delivery-waiting-or-retries-exhausted",
      work_id: id,
      attempts: state.get(id).attempts,
    };
  try {
    const hint = await runner.dispatch(request, binding);
    return {
      event: "delivery-accepted",
      work_id: id,
      run_hint: hint,
      state: "dispatching",
      attempts: state.get(id).attempts,
    };
  } catch (e) {
    if (!(e instanceof DeliveryError)) throw e;
    return {
      event: "delivery-uncertain",
      work_id: id,
      state: "dispatching",
      attempts: state.get(id).attempts,
    };
  }
}
export async function deliver(
  state: State,
  runner: Runner & { prepare(s: Snapshot, r: Buffer): Promise<RecordData> },
  connect: (base: string) => Promise<Flexo>,
  id: string,
  rule: Buffer,
  spool: string,
  allowCreate = false,
) {
  const row = state.get(id);
  if (row.state === "completed")
    return { event: "work-already-completed", work_id: id };
  const r = ValidationRequest.fromDict(JSON.parse(row.request_json));
  if (!state.hasDelivery(id)) {
    const dir = path.join(spool, id);
    let snapshot: Snapshot, retainedRule: Buffer;
    if (fs.existsSync(dir)) {
      const files = Object.fromEntries(
        ["model.ttl", "snapshot.json", "rule.ttl"].map((n) => [
          n,
          fs.readFileSync(path.join(dir, n)),
        ]),
      );
      snapshot = Snapshot.fromFiles(files);
      retainedRule = files["rule.ttl"];
      if (
        !equal(snapshot.request.toDict(), r.toDict()) ||
        digest(retainedRule) !== r.rule_sha256
      )
        throw Error("Spool input differs");
    } else {
      if (digest(rule) !== r.rule_sha256)
        throw Error("Current rule differs from queued work");
      snapshot = await (
        await connect(r.source.base_url)
      ).snapshot(r, undefined, allowCreate);
      retainedRule = rule;
      fs.mkdirSync(spool, { recursive: true });
      const tmp = fs.mkdtempSync(path.join(spool, ".input-"));
      try {
        for (const [n, b] of Object.entries({
          "model.ttl": snapshot.model,
          "rule.ttl": rule,
          "snapshot.json": Buffer.from(canonicalJson(snapshot.metadata())),
        })) {
          const fd = fs.openSync(path.join(tmp, n), "wx");
          try {
            fs.writeFileSync(fd, b);
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
        }
        const fd = fs.openSync(tmp, "r");
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fs.renameSync(tmp, dir);
        const parent = fs.openSync(spool, "r");
        fs.fsyncSync(parent);
        fs.closeSync(parent);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
    state.bindDelivery(id, await runner.prepare(snapshot, retainedRule));
  }
  return advance(state, runner, id);
}
