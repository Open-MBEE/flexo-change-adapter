import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("feed-only JSON configuration retains a baseline and branch change across restarts without validation or remote writes", () => {
  const root = mkdtempSync(join(tmpdir(), "flexo-events-"));
  const branch = "https://flexo.test/orgs/research/repos/ledger/branches/main";
  const commit = (id: string) =>
    "https://flexo.test/orgs/research/repos/ledger/commits/" + id;
  const preload = join(root, "transport.mjs");
  writeFileSync(
    preload,
    `globalThis.fetch = async (url, init) => {
    if (url !== ${JSON.stringify(branch)} || init?.method !== 'GET') throw Error('Unexpected remote operation');
    if (process.env.TEST_FAILURE === 'yes') return new Response('unavailable', {status:503});
    return new Response('<${branch}> <https://mms.openmbee.org/rdf/ontology/commit> <' + process.env.TEST_COMMIT + '> .', {status:200});
  };`,
  );
  const feed = join(root, "activity.json");
  const configuration = join(root, "adapter.json");
  writeFileSync(
    configuration,
    JSON.stringify({
      schema_version: 1,
      id: "feed",
      state_directory: "state",
      source: {
        type: "flexo",
        endpoint: "https://flexo.test",
        organization: "research",
        repository: "ledger",
        branch: "main",
      },
      observation: { mode: "poll", interval_seconds: 30 },
      feed: { type: "json-feed", path: feed },
      actions: [],
    }),
  );
  const poll = (id: string, failed = false) => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "./tests-ts/fixtures-load-guard.mjs",
        "--import",
        preload,
        "src-ts/cli.ts",
        "run",
        "--config",
        configuration,
        "--once",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FLEXO_TOKEN: "synthetic-token",
          TEST_COMMIT: commit(id),
          TEST_FAILURE: failed ? "yes" : "no",
        },
      },
    );
    assert.equal(result.status, failed ? 2 : 0, result.stderr + result.stdout);
    return JSON.parse(readFileSync(feed, "utf8"));
  };
  try {
    const baseline = poll("a");
    assert.equal(baseline.events.length, 1);
    assert.equal(baseline.events[0].kind, "baseline");
    assert.equal(baseline.events[0].previous_commit_uri, null);
    const changed = poll("b");
    assert.equal(changed.events.length, 2);
    assert.equal(changed.events[0].kind, "branch-change");
    assert.equal(changed.events[0].previous_commit_uri, commit("a"));
    assert.equal(changed.events[0].commit_uri, commit("b"));
    assert.equal(changed.events[0].branch_uri, branch);
    assert.equal(changed.events[0].sequence, 2);
    assert.match(changed.events[0].id, /^[a-f0-9]{64}$/);
    assert.deepEqual(poll("b").events, changed.events);
    const failed = poll("c", true);
    assert.equal(failed.status, "error");
    assert.deepEqual(failed.events, changed.events);
    assert.ok(failed.last_success_at);
    assert.equal(poll("a").events.length, 3);
    assert.ok(!readFileSync(feed, "utf8").includes("synthetic-token"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
