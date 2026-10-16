import { engineRuntimeDigest } from "./engine-contracts.ts";
import { validatorDigest } from "./validation.ts";
import {
  canonicalJson,
  digest,
  checkedDigest,
  ValidationRequest,
} from "./contracts.ts";
import type { SharedValidationTarget } from "./configuration.ts";
import { EngineRequest } from "./engine-contracts.ts";
import { engineInputBundle, runEngineRecord } from "./engine-record.ts";
import type { ModelBundle } from "./model-input.ts";
import { Snapshot } from "./flexo.ts";
import type { WorkRequest } from "./requests.ts";
import {
  inputBundle,
  bundleDigest,
  recordRequest,
  verifyInput,
  runValidationRecord,
  verifyResultRecord,
} from "./validation-records.ts";
import { FileEvidence, encodeFiles, decodeFiles } from "./file-evidence.ts";
import {
  NativeCI,
  destination,
  destinationScope,
  workerIdentity,
  workerUrl,
  workParameters,
  type NativeDestination,
  type NativeWorker,
} from "./native-ci.ts";
import { requireFields, type RecordData } from "./workspace.ts";
import { unavailable } from "./engine-execution.ts";
function readInput(
  store: FileEvidence,
  d: NativeDestination,
  id: string,
  input: string,
) {
  const record = store.read("input", id);
  requireFields(record!, [
    "schema_version",
    "destination",
    "work_id",
    "input_digest",
    "files",
  ]);
  if (
    record!.schema_version !== 1 ||
    record!.work_id !== id ||
    record!.input_digest !== input ||
    canonicalJson(record!.destination) !== canonicalJson(d)
  )
    throw Error("Shared input binding differs");
  const files = decodeFiles(record!.files),
    request = recordRequest(files);
  verifyInput(files, request);
  if (request.work_id !== id || bundleDigest(files) !== input)
    throw Error("Shared input digest differs");
  return { files, request };
}
function readClaim(
  store: FileEvidence,
  d: NativeDestination,
  id: string,
  input: string,
) {
  const claim = store.read("claim", id);
  if (!claim) return null;
  requireFields(claim, [
    "schema_version",
    "destination",
    "work_id",
    "input_digest",
    "worker",
    "external_id",
  ]);
  if (
    claim.schema_version !== 1 ||
    claim.work_id !== id ||
    claim.input_digest !== input ||
    canonicalJson(claim.destination) !== canonicalJson(d) ||
    claim.external_id !== workerIdentity(d, claim.worker)
  )
    throw Error("Shared worker claim differs");
  return claim;
}
function terminated(
  r: WorkRequest,
  input: ReturnType<typeof verifyInput>,
  d: NativeDestination,
  claim: RecordData,
) {
  const base = {
    work_id: r.work_id,
    commit_uri: r.commit_uri,
    validator_sha256: r.validator_sha256,
    input_sha256: input.input_sha256,
    report_sha256: null,
    report_url: workerUrl(d, claim.worker),
    external_id: claim.external_id,
    worker: claim.worker,
  };
  return r instanceof EngineRequest
    ? {
        ...base,
        schema_version: 2,
        profile: r.profile,
        report: unavailable("worker-terminated-without-result"),
        outcome: "inconclusive",
      }
    : {
        ...base,
        schema_version: 1,
        rule_version: r.rule_version,
        rule_sha256: r.rule_sha256,
        outcome: "execution-error",
        error_code: "worker-terminated-without-result",
      };
}
export class SharedValidationRunner {
  readonly api: NativeCI;
  readonly destination: NativeDestination;
  readonly store: FileEvidence;
  readonly identity: string;
  constructor(target: SharedValidationTarget) {
    this.api = new NativeCI(target);
    this.destination = destination(target);
    const scope = destinationScope(this.destination);
    this.store = new FileEvidence(target.evidence_directory, scope);
    this.identity = "shared-ci:" + scope;
  }
  binding(d: RecordData) {
    requireFields(d, ["runner", "input_digest"]);
    if (d.runner !== this.identity) throw Error("Foreign validation delivery");
    checkedDigest(d.input_digest);
  }
  async prepare(s: Snapshot, rule: Buffer) {
    return this.prepareFiles(inputBundle(s, rule), s.request.work_id);
  }
  async prepareEngine(r: EngineRequest, b: ModelBundle) {
    return this.prepareFiles(engineInputBundle(r, b), r.work_id);
  }
  async prepareFiles(files: Record<string, Buffer>, id: string) {
    const record = {
        schema_version: 1,
        destination: this.destination,
        work_id: id,
        input_digest: bundleDigest(files),
        files: encodeFiles(files),
      },
      retained = this.store.create("input", id, record);
    if (canonicalJson(retained.record) !== canonicalJson(record))
      throw Error("Cannot replace retained input");
    return { runner: this.identity, input_digest: record.input_digest };
  }
  readyToDispatch() {
    this.api.ready();
  }
  async dispatch(r: WorkRequest, d: RecordData) {
    this.binding(d);
    readInput(this.store, this.destination, r.work_id, d.input_digest);
    return this.api.dispatch(
      workParameters(r.work_id, d.input_digest, this.store.scope, r.commit_uri),
    );
  }
  async inspect(r: WorkRequest, d: RecordData) {
    this.binding(d);
    const claim = readClaim(
      this.store,
      this.destination,
      r.work_id,
      d.input_digest,
    );
    if (!claim) {
      if (this.store.read("result", r.work_id))
        throw Error("Shared result lacks claim");
      return null;
    }
    const input = readInput(
      this.store,
      this.destination,
      r.work_id,
      d.input_digest,
    );
    if (canonicalJson(input.request.toDict()) !== canonicalJson(r.toDict()))
      throw Error("Queued shared request differs");
    const native = await this.api.inspect(
      claim.worker,
      workParameters(r.work_id, d.input_digest, this.store.scope, r.commit_uri),
    );
    const observed: RecordData = {
        external_id: claim.external_id,
        running: native.running,
        result: null,
      },
      record = this.store.read("result", r.work_id);
    if (!record) {
      if (native.completed)
        observed.result = terminated(
          r,
          verifyInput(input.files, r),
          this.destination,
          claim,
        );
      return observed;
    }
    requireFields(record, [
      "schema_version",
      "claim_sha256",
      "work_id",
      "input_digest",
      "files",
    ]);
    if (
      record.schema_version !== 1 ||
      record.claim_sha256 !== digest(canonicalJson(claim)) ||
      record.work_id !== r.work_id ||
      record.input_digest !== d.input_digest
    )
      throw Error("Shared result claim binding differs");
    const result = verifyResultRecord(
      decodeFiles(record.files),
      input.files,
      r,
    );
    if (
      result.external_id !== claim.external_id ||
      canonicalJson(result.worker) !== canonicalJson(claim.worker) ||
      result.report_url !== workerUrl(this.destination, claim.worker)
    )
      throw Error("Shared result owner differs");
    if (!native.completed) return observed;
    if (native.success !== ["pass", "conforming"].includes(result.outcome))
      throw Error("Native conclusion differs from validation");
    observed.result = result;
    return observed;
  }
}
export async function executeSharedValidation(
  store: FileEvidence,
  id: string,
  input: string,
  worker: NativeWorker,
  engineWorker = runEngineRecord,
) {
  checkedDigest(id);
  checkedDigest(input);
  const record = store.read("input", id);
  if (!record) throw Error("Missing shared input");
  const d = record.destination as NativeDestination;
  if (destinationScope(d) !== store.scope) throw Error("Wrong evidence scope");
  const { files, request: r } = readInput(store, d, id, input),
    external = workerIdentity(d, worker);
  const claim = {
    schema_version: 1,
    destination: d,
    work_id: id,
    input_digest: input,
    worker,
    external_id: external,
  };
  const existing = readClaim(store, d, id, input);
  if (existing)
    return {
      event: "validation-skipped-existing-claim",
      work_id: id,
      owner: existing.external_id,
    };
  if (
    r.validator_sha256 !==
    (r instanceof EngineRequest ? engineRuntimeDigest() : validatorDigest())
  )
    throw Error("Queued validation runtime unavailable");
  const owner = store.create("claim", id, claim);
  if (!owner.created) {
    readClaim(store, d, id, input);
    return {
      event: "validation-skipped-existing-claim",
      work_id: id,
      owner: owner.record.external_id,
    };
  }
  const { result, evidence } = await runValidationRecord(
    files,
    r,
    external,
    engineWorker,
  );
  Object.assign(result, {
    worker,
    report_url: workerUrl(d, worker),
    limits: [],
  });
  const finalFiles = {
    ...evidence,
    "result.json": Buffer.from(canonicalJson(result)),
  };
  verifyResultRecord(finalFiles, files, r);
  const completed = {
      schema_version: 1,
      claim_sha256: digest(canonicalJson(claim)),
      work_id: id,
      input_digest: input,
      files: encodeFiles(finalFiles),
    },
    retained = store.create("result", id, completed);
  if (canonicalJson(retained.record) !== canonicalJson(completed))
    throw Error("Cannot replace retained result");
  return {
    event: "validation-completed",
    work_id: id,
    outcome: result.outcome,
    external_id: external,
    report_url: result.report_url,
  };
}
