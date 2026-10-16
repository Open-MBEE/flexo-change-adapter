import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { now, type RecordData } from "./workspace.ts";
import {
  canonicalJson,
  checkedDigest,
  checkResult,
  ValidationRequest,
} from "./contracts.ts";
export class State {
  readonly db: DatabaseSync;
  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, { timeout: 10000 });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS work(work_id TEXT PRIMARY KEY,request_json TEXT NOT NULL,observed_at TEXT NOT NULL,updated_at TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','dispatching','submitted','running','completed')),attempts INTEGER NOT NULL DEFAULT 0,external_id TEXT,result_json TEXT);
 CREATE TABLE IF NOT EXISTS checkpoint(branch_uri TEXT PRIMARY KEY,commit_uri TEXT NOT NULL,observed_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS delivery(work_id TEXT PRIMARY KEY,binding_json TEXT NOT NULL,last_dispatch REAL NOT NULL DEFAULT 0);`);
  }
  close() {
    this.db.close();
  }
  transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = body();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  observe(r: ValidationRequest) {
    return this.transaction(() => {
      const time = now(),
        prior = this.db
          .prepare("SELECT request_json FROM work WHERE work_id=?")
          .get(r.work_id);
      if (prior)
        ValidationRequest.fromDict(JSON.parse(String(prior.request_json)));
      else
        this.db
          .prepare(
            "INSERT INTO work(work_id,request_json,observed_at,updated_at,state) VALUES(?,?,?,?,'pending')",
          )
          .run(r.work_id, canonicalJson(r.toDict()), time, time);
      this.db
        .prepare(
          "INSERT INTO checkpoint VALUES(?,?,?) ON CONFLICT(branch_uri) DO UPDATE SET commit_uri=excluded.commit_uri,observed_at=excluded.observed_at",
        )
        .run(r.source.uri, r.commit_uri, time);
      return !prior;
    });
  }
  list(): RecordData[] {
    return this.db
      .prepare("SELECT * FROM work ORDER BY observed_at,work_id")
      .all();
  }
  get(id: string): RecordData {
    checkedDigest(id);
    const r = this.db.prepare("SELECT * FROM work WHERE work_id=?").get(id);
    if (!r) throw Error("Unknown work identity");
    return r;
  }
  beginDispatch(id: string) {
    checkedDigest(id);
    return this.transaction(
      () =>
        this.db
          .prepare(
            "UPDATE work SET state='dispatching',attempts=attempts+1,updated_at=? WHERE work_id=? AND state='pending'",
          )
          .run(now(), id).changes === 1,
    );
  }
  bindDelivery(id: string, binding: RecordData) {
    const encoded = canonicalJson(binding);
    this.transaction(() => {
      this.get(id);
      const prior = this.db
        .prepare("SELECT binding_json FROM delivery WHERE work_id=?")
        .get(id);
      if (prior && prior.binding_json !== encoded)
        throw Error("Cannot replace delivery binding");
      if (!prior)
        this.db
          .prepare("INSERT INTO delivery(work_id,binding_json) VALUES(?,?)")
          .run(id, encoded);
    });
  }
  delivery(id: string) {
    this.get(id);
    const r = this.db
      .prepare("SELECT binding_json FROM delivery WHERE work_id=?")
      .get(id);
    if (!r) throw Error("Work has no prepared delivery");
    return JSON.parse(String(r.binding_json));
  }
  hasDelivery(id: string) {
    this.get(id);
    return !!this.db.prepare("SELECT 1 FROM delivery WHERE work_id=?").get(id);
  }
  claimDeliveryAttempt(
    id: string,
    time = Date.now() / 1000,
    minDelay = 60,
    maxAttempts = 3,
  ) {
    if (minDelay < 60 || maxAttempts < 1) throw Error("Invalid retry bounds");
    return this.transaction(() => {
      const r = this.get(id);
      this.delivery(id);
      const last = Number(
        this.db
          .prepare("SELECT last_dispatch FROM delivery WHERE work_id=?")
          .get(id)!.last_dispatch,
      );
      if (
        !["pending", "dispatching"].includes(r.state) ||
        r.attempts >= maxAttempts ||
        (r.attempts && time - last < minDelay)
      )
        return false;
      this.db
        .prepare(
          "UPDATE work SET state='dispatching',attempts=attempts+1,updated_at=? WHERE work_id=?",
        )
        .run(now(), id);
      this.db
        .prepare("UPDATE delivery SET last_dispatch=? WHERE work_id=?")
        .run(time, id);
      return true;
    });
  }
  attachRun(id: string, external: string, running = false) {
    if (typeof external !== "string" || !external.trim())
      throw Error("External identity required");
    this.transaction(() => {
      const r = this.get(id);
      if (
        !["dispatching", "submitted", "running"].includes(r.state) ||
        (r.external_id && r.external_id !== external) ||
        (r.state === "running" && !running)
      )
        throw Error("Invalid run reconciliation");
      this.db
        .prepare(
          "UPDATE work SET state=?,external_id=?,updated_at=? WHERE work_id=?",
        )
        .run(running ? "running" : "submitted", external, now(), id);
    });
  }
  complete(id: string, result: RecordData) {
    this.transaction(() => {
      const row = this.get(id),
        r = ValidationRequest.fromDict(JSON.parse(row.request_json));
      checkResult(r, result);
      const encoded = canonicalJson(result);
      if (row.state === "completed") {
        if (row.result_json !== encoded)
          throw Error("Completed result cannot be replaced");
        return;
      }
      if (
        !["submitted", "running"].includes(row.state) ||
        result.external_id !== row.external_id
      )
        throw Error("Result must bind reconciled run");
      this.db
        .prepare(
          "UPDATE work SET state='completed',result_json=?,updated_at=? WHERE work_id=?",
        )
        .run(encoded, now(), id);
    });
  }
}
