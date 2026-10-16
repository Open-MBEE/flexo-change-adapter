import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  branch,
  type Configuration,
  type EngineAction,
  type FlexoSource,
} from "./configuration.ts";
import { canonicalJson, digest } from "./contracts.ts";
import {
  EngineRequest,
  engineProfile,
  engineRuntimeDigest,
} from "./engine-contracts.ts";
import {
  type ActionIntent,
  type FrozenEngineAction,
  type PreparedAction,
  Journal,
} from "./journal.ts";
import { retainedModelBundle, captureModelBundle } from "./model-input.ts";
import { connectFlexo } from "./flexo.ts";
import { State } from "./state.ts";
import { GitHub } from "./github-api.ts";
import { GitHubRunner } from "./github-runner.ts";
import { advance } from "./service.ts";
export function freezeEngineAction(a: EngineAction): PreparedAction {
  return {
    action: {
      ...a,
      task: {
        type: "engine-validation",
        profile: engineProfile(a.task.engine),
        input: a.task.input,
        validator_sha256: engineRuntimeDigest(),
      },
    },
  };
}
function directory(c: Configuration, a: FrozenEngineAction) {
  return path.join(
    c.state_directory,
    "targets",
    digest(canonicalJson(a.target)),
  );
}
export async function advanceEngineIntent(
  c: Configuration,
  j: Journal,
  intent: ActionIntent,
) {
  const action = JSON.parse(intent.action_json) as FrozenEngineAction,
    source = JSON.parse(intent.source_json) as FlexoSource,
    b = branch(source);
  const state = new State(path.join(directory(c, action), "work.sqlite"));
  try {
    // Reconcile already prepared work without contacting Flexo or requiring a new wrapper version.
    const prior = state.list().find((row) => {
      const r = JSON.parse(row.request_json);
      return (
        r.schema_version === 2 &&
        r.commit_uri === intent.commit_uri &&
        r.validator_sha256 === action.task.validator_sha256 &&
        canonicalJson(r.profile) === canonicalJson(action.task.profile) &&
        canonicalJson(r.source) === canonicalJson(b.toDict())
      );
    });
    const runner = () =>
      new GitHubRunner(
        new GitHub(
          action.target.owner,
          action.target.repository,
          process.env[action.target.token_env] ?? "",
        ),
      );
    let request: EngineRequest;
    if (prior) {
      request = EngineRequest.fromDict(JSON.parse(prior.request_json));
    } else {
      if (engineRuntimeDigest() !== action.task.validator_sha256)
        throw Error("Queued engine wrapper unavailable");
      const key = digest(
        canonicalJson({
          source: b.toDict(),
          commit: intent.commit_uri,
          provider: "flexo-text-manifest-v1",
        }),
      );
      const existing = j.inputs().find((i) => i.id === key);
      if (existing?.status !== "ready")
        j.inputPreparation(key, intent.commit_uri, "pending");
      let bundle;
      try {
        bundle = await retainedModelBundle(
          path.join(c.state_directory, "inputs"),
          b,
          intent.commit_uri,
          async () =>
            captureModelBundle(
              await connectFlexo(
                source.endpoint,
                undefined,
                source.credentials,
              ),
              b,
              intent.commit_uri,
              action.allow_lock_creation,
            ),
        );
        j.inputPreparation(
          key,
          intent.commit_uri,
          "ready",
          digest(canonicalJson(bundle)),
        );
      } catch (e) {
        if (existing?.status !== "ready")
          j.inputPreparation(key, intent.commit_uri, "error");
        throw e;
      }
      request = new EngineRequest(
        b,
        intent.commit_uri,
        digest(canonicalJson(bundle)),
        action.task.profile,
        action.task.validator_sha256,
      );
      state.observe(request);
    }
    let row = state.get(request.work_id);
    if (row.state !== "completed") {
      const remote = runner();
      if (!state.hasDelivery(request.work_id)) {
        const bundle = await retainedModelBundle(
          path.join(c.state_directory, "inputs"),
          b,
          intent.commit_uri,
          async () => {
            throw Error("Missing retained input");
          },
        );
        state.bindDelivery(
          request.work_id,
          await remote.prepareEngine(request, bundle),
        );
      }
      await advance(state, remote, request.work_id);
      row = state.get(request.work_id);
    }
    if (row.state === "completed")
      j.finish(intent.id, JSON.parse(row.result_json));
    else j.progressed(intent.id);
  } finally {
    state.close();
  }
}
export function engineDeliveryStatus(c: Configuration, intent: ActionIntent) {
  const a = JSON.parse(intent.action_json) as FrozenEngineAction,
    file = path.join(directory(c, a), "work.sqlite");
  if (!fs.existsSync(file))
    return { state: "unprepared", attempts: 0, external_id: null };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT state,attempts,external_id,request_json FROM work")
      .all()
      .find((row) => {
        const r = JSON.parse(String(row.request_json));
        return (
          r.schema_version === 2 &&
          r.commit_uri === intent.commit_uri &&
          r.validator_sha256 === a.task.validator_sha256 &&
          canonicalJson(r.profile) === canonicalJson(a.task.profile)
        );
      });
    return row
      ? {
          state: row.state,
          attempts: row.attempts,
          external_id: row.external_id,
        }
      : { state: "unprepared", attempts: 0, external_id: null };
  } finally {
    db.close();
  }
}
