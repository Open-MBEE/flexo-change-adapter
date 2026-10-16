import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("../src-ts/cli.ts", import.meta.url));
test("CLI help is local and bad arguments fail without exposing inputs", () => {
  for (const command of ["check", "run", "status", "snapshot", "validate"]) {
    const p = spawnSync(process.execPath, [cli, command, "--help"], {
      encoding: "utf8",
    });
    assert.equal(p.status, 0);
    assert.match(p.stdout, new RegExp("Usage: adapter " + command));
  }
  for (const args of [
    ["status", "--unexpected", "sensitive-value"],
    ["run", "--once", "false"],
    ["run", "--unexpected"],
  ]) {
    const p = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.equal(p.status, 2);
    assert.ok(!(p.stdout + p.stderr).includes("sensitive-value"));
  }
});

test("unknown commands and missing configuration fail locally", () => {
  for (const args of [["unknown-command"], ["status"], ["run"]]) {
    const p = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.equal(p.status, 2);
  }
});

test("help and offline JSON checking need neither RDF nor validation modules", () => {
  for (const args of [
    ["--help"],
    ["check", "--config", "examples/configuration/feed.json"],
    ["check", "--config", "examples/configuration/github-validation.json"],
  ]) {
    const p = spawnSync(
      process.execPath,
      ["--import", "./tests-ts/fixtures-load-guard.mjs", cli, ...args],
      {
        encoding: "utf8",
        env: { ...process.env, TEST_NO_RDF: "yes" },
      },
    );
    assert.equal(p.status, 0, p.stdout + p.stderr);
  }
});
