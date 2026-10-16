import type { EngineProfile } from "./engine-contracts.ts";
import type { EngineAction } from "./configuration.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Branch, canonicalJson, digest } from "./contracts.ts";
import {
  ConfigurationError,
  type FlexoSource,
  type ValidationAction,
  type TriggerAction,
} from "./configuration.ts";

export type FrozenValidationAction = Omit<ValidationAction, "task"> & {
  task: {
    type: "shacl-validation";
    rule_version: string;
    rule_sha256: string;
    validator_sha256: string;
  };
};
export type FrozenEngineAction = Omit<EngineAction, "task"> & {
  task: {
    type: "engine-validation";
    profile: EngineProfile;
    validator_sha256: string;
    input: "flexo-text-manifest-v1";
  };
};
export type FrozenAction =
  FrozenValidationAction | FrozenEngineAction | TriggerAction;
export type PreparedAction = { action: FrozenAction; rule?: Buffer };
export type BranchEvent = {
  sequence: number;
  id: string;
  kind: "baseline" | "branch-change";
  branch_uri: string;
  previous_commit_uri: string | null;
  commit_uri: string;
  observed_at: string;
};
export type ActionIntent = {
  id: string;
  event_id: string;
  action_json: string;
  source_json: string;
  commit_uri: string;
  state: "pending" | "completed";
  error: string | null;
  result_json: string | null;
};
export class Journal {
  readonly db: DatabaseSync;
  constructor(file: string, source: Branch, readOnly = false) {
    if (!readOnly) fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, { readOnly, timeout: 10000 });
    try {
      const version = this.db.prepare("PRAGMA user_version").get()!
        .user_version;
      const populated = this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
        )
        .get();
      if (version !== 2 && (version !== 0 || readOnly || populated))
        throw Error("Unsupported journal schema");
      if (version === 2) {
        const tables = new Set(
          this.db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all()
            .map((r) => r.name),
        );
        if (
          [
            "event_source",
            "event_poll",
            "branch_events",
            "action_rules",
            "action_intents",
            "journal_health",
            "ci_deliveries",
            "input_preparations",
          ].some((n) => !tables.has(n))
        )
          throw Error("Unsupported journal schema");
        const owner = this.db
          .prepare("SELECT branch_uri FROM event_source")
          .get();
        if (owner?.branch_uri !== source.uri)
          throw new ConfigurationError(
            "Event state belongs to another branch; select a separate state directory",
          );
      }
      if (!readOnly) {
        this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
        if (version === 0)
          this.transaction(() => {
            this.db
              .exec(`CREATE TABLE event_source(branch_uri TEXT PRIMARY KEY);
            CREATE TABLE event_poll(id INTEGER PRIMARY KEY CHECK(id=1), last_success_at TEXT NOT NULL);
            CREATE TABLE branch_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, branch_uri TEXT NOT NULL, previous_commit_uri TEXT, commit_uri TEXT NOT NULL, observed_at TEXT NOT NULL);
            CREATE TABLE input_preparations(id TEXT PRIMARY KEY,commit_uri TEXT NOT NULL,status TEXT NOT NULL,input_sha256 TEXT,error TEXT);
            CREATE TABLE action_rules(sha256 TEXT PRIMARY KEY, bytes BLOB NOT NULL);
            CREATE TABLE action_intents(id TEXT PRIMARY KEY, event_id TEXT NOT NULL, action_json TEXT NOT NULL, source_json TEXT NOT NULL, commit_uri TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','completed')), error TEXT, result_json TEXT);
            CREATE TABLE journal_health(id INTEGER PRIMARY KEY CHECK(id=1), checked_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('ok','error')));
            CREATE TABLE ci_deliveries(id TEXT PRIMARY KEY, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, external_json TEXT, started_at TEXT NOT NULL);
            PRAGMA user_version=2;`);
            this.db
              .prepare("INSERT INTO event_source VALUES(?)")
              .run(source.uri);
          });
      }
      const configured = this.db
        .prepare("SELECT branch_uri FROM event_source")
        .get();
      if (!configured || configured.branch_uri !== source.uri)
        throw new ConfigurationError(
          "Event state belongs to another branch; select a separate state directory",
        );
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  latest(): BranchEvent | undefined {
    return this.db
      .prepare("SELECT * FROM branch_events ORDER BY sequence DESC LIMIT 1")
      .get() as BranchEvent | undefined;
  }
  observe(
    source: FlexoSource,
    branch: Branch,
    commit: string,
    actions: PreparedAction[],
    observedAt = new Date().toISOString(),
  ) {
    branch.checkCommit(commit);
    return this.transaction(() => {
      const prior = this.latest();
      let event: BranchEvent | undefined;
      if (prior?.commit_uri !== commit) {
        const data = {
          sequence: Number(prior?.sequence ?? 0) + 1,
          kind: prior ? ("branch-change" as const) : ("baseline" as const),
          branch_uri: branch.uri,
          previous_commit_uri: prior?.commit_uri ?? null,
          commit_uri: commit,
          observed_at: observedAt,
        };
        // Event identity binds these fields in this fixed key order.
        event = { ...data, id: digest(JSON.stringify(data)) };
        this.db
          .prepare(
            "INSERT INTO branch_events(sequence,id,kind,branch_uri,previous_commit_uri,commit_uri,observed_at) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            event.sequence,
            event.id,
            event.kind,
            branch.uri,
            event.previous_commit_uri,
            commit,
            observedAt,
          );
        for (const { action, rule } of actions) {
          if (!action.on.includes(event.kind)) continue;
          if (
            "rule_sha256" in action.task &&
            (!rule || digest(rule) !== action.task.rule_sha256)
          )
            throw Error("Frozen rule differs");
          if ("rule_sha256" in action.task && rule)
            this.db
              .prepare("INSERT OR IGNORE INTO action_rules VALUES(?,?)")
              .run(action.task.rule_sha256, rule);
          const json = canonicalJson(action),
            id = digest(
              canonicalJson({
                event_id: event.id,
                action_id: action.id,
                configuration_sha256: digest(json),
              }),
            );
          this.db
            .prepare(
              "INSERT INTO action_intents(id,event_id,action_json,source_json,commit_uri,state) VALUES(?,?,?,?,?,'pending')",
            )
            .run(id, event.id, json, canonicalJson(source), commit);
        }
      }
      this.db
        .prepare(
          "INSERT INTO event_poll VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_success_at=excluded.last_success_at",
        )
        .run(observedAt);
      this.health("ok", observedAt);
      return event;
    });
  }
  health(status: "ok" | "error", checkedAt = new Date().toISOString()) {
    this.db
      .prepare(
        "INSERT INTO journal_health VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at,status=excluded.status",
      )
      .run(checkedAt, status);
  }
  view(branch: Branch, interval: number) {
    const health = this.db
      .prepare("SELECT * FROM journal_health WHERE id=1")
      .get();
    const lastSuccess =
      this.db.prepare("SELECT last_success_at FROM event_poll WHERE id=1").get()
        ?.last_success_at ?? null;
    return {
      schema_version: 1,
      source: "flexo-change-adapter",
      branch_uri: branch.uri,
      status: health?.status ?? (lastSuccess ? "ok" : "unknown"),
      interval_seconds: interval,
      checked_at: health?.checked_at ?? lastSuccess,
      last_success_at: lastSuccess,
      latest_commit_uri: this.latest()?.commit_uri ?? null,
      ...(health?.status === "error"
        ? {
            error:
              "Unable to read Flexo branch; retained observations are unchanged.",
          }
        : {}),
      events: this.db
        .prepare("SELECT * FROM branch_events ORDER BY sequence DESC LIMIT 100")
        .all(),
    };
  }
  intents(): ActionIntent[] {
    return this.db
      .prepare("SELECT * FROM action_intents ORDER BY rowid")
      .all() as ActionIntent[];
  }
  inputPreparation(
    id: string,
    commit: string,
    status: "pending" | "ready" | "error",
    sha: string | null = null,
  ) {
    const prior = this.db
      .prepare("SELECT * FROM input_preparations WHERE id=?")
      .get(id);
    if (prior?.status === "ready") {
      if (
        status !== "ready" ||
        prior.input_sha256 !== sha ||
        prior.commit_uri !== commit
      )
        throw Error("Prepared input cannot be replaced");
      return;
    }
    this.db
      .prepare(
        "INSERT INTO input_preparations VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,input_sha256=excluded.input_sha256,error=excluded.error",
      )
      .run(
        id,
        commit,
        status,
        sha,
        status === "error"
          ? "Unable to prepare verified revision-bound text input"
          : null,
      );
  }
  inputs() {
    return this.db
      .prepare("SELECT * FROM input_preparations ORDER BY rowid")
      .all();
  }
  rule(sha: string) {
    const row = this.db
      .prepare("SELECT bytes FROM action_rules WHERE sha256=?")
      .get(sha);
    if (!row) throw Error("Missing retained rule");
    const bytes = Buffer.from(row.bytes as Uint8Array);
    if (digest(bytes) !== sha) throw Error("Retained rule digest differs");
    return bytes;
  }
  finish(id: string, result: unknown) {
    this.db
      .prepare(
        "UPDATE action_intents SET state='completed',error=NULL,result_json=? WHERE id=? AND state='pending'",
      )
      .run(canonicalJson(result), id);
  }
  failure(id: string) {
    this.db
      .prepare(
        "UPDATE action_intents SET error='Action could not advance; inspect credentials, pinned runtime and destination access.' WHERE id=? AND state='pending'",
      )
      .run(id);
  }
  progressed(id: string) {
    this.db
      .prepare(
        "UPDATE action_intents SET error=NULL WHERE id=? AND state='pending'",
      )
      .run(id);
  }
}
