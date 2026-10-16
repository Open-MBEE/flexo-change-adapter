import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  branch,
  type Configuration,
  type FlexoSource,
  type ValidationAction,
} from "./configuration.ts";
import { canonicalJson, digest, ValidationRequest } from "./contracts.ts";
import {
  Journal,
  type ActionIntent,
  type FrozenValidationAction,
  type PreparedAction,
} from "./journal.ts";
import { validatorDigest } from "./validation.ts";
import { State } from "./state.ts";
import { GitHub } from "./github-api.ts";
import { GitHubRunner } from "./github-runner.ts";
import { connectFlexo, transport } from "./flexo.ts";
import { deliver } from "./service.ts";

export function freezeAction(a: ValidationAction): PreparedAction {
  const validator = validatorDigest();
  const rule = fs.readFileSync(a.task.rule);
  return {
    rule,
    action: {
      ...a,
      task: {
        type: "shacl-validation",
        rule_version: a.task.rule_version,
        rule_sha256: digest(rule),
        validator_sha256: validator,
      },
    },
  };
}
export function targetDirectory(
  configuration: Configuration,
  action: FrozenValidationAction,
) {
  return path.join(
    configuration.state_directory,
    "targets",
    digest(canonicalJson(action.target)),
  );
}
export async function advanceIntent(
  configuration: Configuration,
  journal: Journal,
  intent: ActionIntent,
) {
  const action = JSON.parse(intent.action_json) as FrozenValidationAction;
  const source = JSON.parse(intent.source_json) as FlexoSource;
  const request = new ValidationRequest(
    branch(source),
    intent.commit_uri,
    action.task.rule_version,
    action.task.rule_sha256,
    action.task.validator_sha256,
  );
  if (request.validator_sha256 !== validatorDigest())
    throw Error("Queued validator runtime unavailable");
  const rule = journal.rule(action.task.rule_sha256);
  const dir = targetDirectory(configuration, action);
  const state = new State(path.join(dir, "work.sqlite"));
  try {
    state.observe(request);
    const row = state.get(request.work_id);
    if (row.state !== "completed") {
      const runner = new GitHubRunner(
        new GitHub(
          action.target.owner,
          action.target.repository,
          process.env[action.target.token_env] ?? "",
        ),
      );
      const progress = await deliver(
        state,
        runner,
        (base) => connectFlexo(base, transport, source.credentials),
        request.work_id,
        rule,
        path.join(dir, "spool"),
        action.allow_lock_creation,
      );
      console.log(
        JSON.stringify({
          event: "action-advanced",
          action_intent_id: intent.id,
          progress,
        }),
      );
    }
    const updated = state.get(request.work_id);
    if (updated.state === "completed")
      journal.finish(intent.id, JSON.parse(updated.result_json));
    else journal.progressed(intent.id);
  } finally {
    state.close();
  }
}
export function deliveryStatus(
  configuration: Configuration,
  intent: ActionIntent,
) {
  const action = JSON.parse(intent.action_json) as FrozenValidationAction;
  const source = JSON.parse(intent.source_json) as FlexoSource;
  const request = new ValidationRequest(
    branch(source),
    intent.commit_uri,
    action.task.rule_version,
    action.task.rule_sha256,
    action.task.validator_sha256,
  );
  const file = path.join(targetDirectory(configuration, action), "work.sqlite");
  if (!fs.existsSync(file))
    return { state: "unprepared", attempts: 0, external_id: null };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (
      db
        .prepare("SELECT state,attempts,external_id FROM work WHERE work_id=?")
        .get(request.work_id) ?? {
        state: "unprepared",
        attempts: 0,
        external_id: null,
      }
    );
  } finally {
    db.close();
  }
}
