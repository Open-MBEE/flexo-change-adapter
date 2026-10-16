import * as fs from "node:fs";
import * as path from "node:path";
import { Branch, checkedId } from "./contracts.ts";

export class ConfigurationError extends Error {}

export type Credentials = {
  token_env: string;
  password_env: string;
  username_env: string;
};
export type FlexoSource = {
  type: "flexo";
  endpoint: string;
  organization: string;
  repository: string;
  branch: string;
  credentials: Credentials;
};
export type ValidationAction = {
  id: string;
  on: ("baseline" | "branch-change")[];
  task: { type: "shacl-validation"; rule: string; rule_version: string };
  target: {
    type: "github";
    owner: string;
    repository: string;
    workflow: "flexo-validate.yml";
    ref: "main";
    token_env: string;
  };
  allow_lock_creation: boolean;
};
export type TriggerAction = {
  id: string;
  on: ("baseline" | "branch-change")[];
  task: { type: "ci-trigger" };
  target:
    | {
        type: "gitlab";
        endpoint: string;
        project: string;
        ref: string;
        trigger_token_env: string;
        read_token_env: string;
      }
    | {
        type: "jenkins";
        endpoint: string;
        job: string;
        username_env: string;
        token_env: string;
      };
};
export type Action = ValidationAction | TriggerAction;
export type Configuration = {
  schema_version: 1;
  id: string;
  state_directory: string;
  database: string;
  source: FlexoSource;
  observation: { mode: "poll"; interval_seconds: number };
  feed?: { type: "json-feed"; path: string };
  actions: Action[];
};
// Explicit registration: configuration cannot load executable packages.
export const adapters = {
  sources: ["flexo"],
  observations: ["poll"],
  feeds: ["json-feed"],
  tasks: ["shacl-validation", "ci-trigger"],
  targets: ["github", "gitlab", "jenkins"],
} as const;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ConfigurationError("Expected configuration object");
  return value as Record<string, unknown>;
}
function keys(v: Record<string, unknown>, names: string[]) {
  if (Object.keys(v).some((k) => !names.includes(k)))
    throw new ConfigurationError("Unknown configuration field");
}
function string(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || /[\r\n\0]/.test(v))
    throw new ConfigurationError("Expected nonempty configuration string");
  return v;
}
function env(v: unknown, fallback: string) {
  const name = v === undefined ? fallback : string(v);
  if (!/^[A-Z][A-Z0-9_]*$/.test(name))
    throw new ConfigurationError(
      "Expected credential environment variable name",
    );
  return name;
}
export function branch(source: FlexoSource) {
  return new Branch(
    source.endpoint,
    source.organization,
    source.repository,
    source.branch,
  );
}
// Resolve existing symlinks, including when the final file does not yet exist.
export function canonicalPath(file: string): string {
  const full = path.resolve(file);
  if (fs.existsSync(full)) return fs.realpathSync(full);
  const parent = path.dirname(full);
  return parent === full
    ? full
    : path.join(canonicalPath(parent), path.basename(full));
}
export function parseConfiguration(
  value: unknown,
  directory: string,
  checkInputs = true,
  configurationFile?: string,
): Configuration {
  const v = object(value);
  keys(v, [
    "schema_version",
    "id",
    "state_directory",
    "database",
    "source",
    "observation",
    "feed",
    "actions",
  ]);
  if (v.schema_version !== 1)
    throw new ConfigurationError("Unsupported configuration version");
  const resolve = (p: unknown) =>
    canonicalPath(path.resolve(directory, string(p)));
  const state = resolve(v.state_directory),
    database =
      v.database === undefined
        ? path.join(state, "events.sqlite")
        : resolve(v.database);
  const s = object(v.source);
  keys(s, [
    "type",
    "endpoint",
    "organization",
    "repository",
    "branch",
    "credentials",
  ]);
  if (s.type !== "flexo")
    throw new ConfigurationError("Unavailable source adapter");
  const credentials = s.credentials === undefined ? {} : object(s.credentials);
  keys(credentials, ["token_env", "password_env", "username_env"]);
  const source: FlexoSource = {
    type: "flexo",
    endpoint: string(s.endpoint),
    organization: string(s.organization),
    repository: string(s.repository),
    branch: string(s.branch),
    credentials: {
      token_env: env(credentials.token_env, "FLEXO_TOKEN"),
      password_env: env(credentials.password_env, "FLEXO_PASSWORD"),
      username_env: env(credentials.username_env, "FLEXO_USERNAME"),
    },
  };
  branch(source);
  const observation = object(v.observation);
  keys(observation, ["mode", "interval_seconds"]);
  if (observation.mode !== "poll")
    throw new ConfigurationError("Unavailable observation mode");
  const interval = observation.interval_seconds ?? 45;
  if (
    typeof interval !== "number" ||
    !Number.isInteger(interval) ||
    interval < 30 ||
    interval > 60
  )
    throw new ConfigurationError("Polling interval must be 30–60 seconds");
  let feed: Configuration["feed"];
  if (v.feed !== undefined) {
    const f = object(v.feed);
    keys(f, ["type", "path"]);
    if (f.type !== "json-feed")
      throw new ConfigurationError("Unavailable feed adapter");
    feed = { type: "json-feed", path: resolve(f.path) };
  }
  if (v.actions !== undefined && !Array.isArray(v.actions))
    throw new ConfigurationError("Expected actions array");
  const actions = ((v.actions ?? []) as unknown[]).map((raw): Action => {
    const a = object(raw);
    keys(a, ["id", "on", "task", "target", "allow_lock_creation"]);
    if (
      !Array.isArray(a.on) ||
      !a.on.length ||
      a.on.some((k) => !["baseline", "branch-change"].includes(String(k))) ||
      new Set(a.on).size !== a.on.length
    )
      throw new ConfigurationError("Unsupported action event selection");
    const t = object(a.task);
    const target = object(a.target);
    if (t.type === "ci-trigger") {
      keys(t, ["type"]);
      if (a.allow_lock_creation !== undefined)
        throw new ConfigurationError("CI triggers do not create Flexo locks");
      const endpoint = new URL(string(target.endpoint));
      if (
        endpoint.protocol !== "https:" ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        /[\s]/.test(String(target.endpoint))
      )
        throw new ConfigurationError(
          "Expected credential-free HTTPS target endpoint",
        );
      const base = endpoint.toString().replace(/\/$/, "");
      const common = {
        id: checkedId(string(a.id)),
        on: a.on as TriggerAction["on"],
        task: { type: "ci-trigger" as const },
      };
      if (target.type === "gitlab") {
        keys(target, [
          "type",
          "endpoint",
          "project",
          "ref",
          "trigger_token_env",
          "read_token_env",
        ]);
        const project = string(target.project);
        if (project.split("/").some((p) => !p || p === "." || p === ".."))
          throw new ConfigurationError("Invalid GitLab project");
        return {
          ...common,
          target: {
            type: "gitlab",
            endpoint: base,
            project,
            ref: string(target.ref),
            trigger_token_env: env(
              target.trigger_token_env,
              "GITLAB_TRIGGER_TOKEN",
            ),
            read_token_env: env(target.read_token_env, "GITLAB_READ_TOKEN"),
          },
        };
      }
      if (target.type === "jenkins") {
        keys(target, ["type", "endpoint", "job", "username_env", "token_env"]);
        const job = string(target.job);
        for (const part of job.split("/")) checkedId(part);
        return {
          ...common,
          target: {
            type: "jenkins",
            endpoint: base,
            job,
            username_env: env(target.username_env, "JENKINS_USERNAME"),
            token_env: env(target.token_env, "JENKINS_TOKEN"),
          },
        };
      }
      throw new ConfigurationError("Unavailable CI trigger target");
    }
    keys(t, ["type", "rule", "rule_version"]);
    keys(target, [
      "type",
      "owner",
      "repository",
      "workflow",
      "ref",
      "token_env",
    ]);
    if (t.type !== "shacl-validation" || target.type !== "github")
      throw new ConfigurationError("Unavailable task/target pairing");
    if (
      (target.workflow ?? "flexo-validate.yml") !== "flexo-validate.yml" ||
      (target.ref ?? "main") !== "main"
    )
      throw new ConfigurationError(
        "Validation requires reviewed flexo-validate.yml on main",
      );
    const rule = resolve(t.rule);
    if (checkInputs) {
      if (!fs.statSync(rule).isFile())
        throw new ConfigurationError("Rule must be a readable file");
      fs.accessSync(rule, fs.constants.R_OK);
    }
    if (
      a.allow_lock_creation !== undefined &&
      typeof a.allow_lock_creation !== "boolean"
    )
      throw new ConfigurationError("Expected lock creation boolean");
    return {
      id: checkedId(string(a.id)),
      on: a.on as ValidationAction["on"],
      task: {
        type: "shacl-validation",
        rule,
        rule_version: string(t.rule_version),
      },
      target: {
        type: "github",
        owner: checkedId(string(target.owner)),
        repository: checkedId(string(target.repository)),
        workflow: "flexo-validate.yml",
        ref: "main",
        token_env: env(target.token_env, "GITHUB_TOKEN"),
      },
      allow_lock_creation: a.allow_lock_creation === true,
    };
  });
  if (new Set(actions.map((a) => a.id)).size !== actions.length)
    throw new ConfigurationError("Duplicate action ID");
  const files = [
    database,
    ...(feed ? [feed.path] : []),
    ...actions.flatMap((a) => ("rule" in a.task ? [a.task.rule] : [])),
  ];
  // Refuse data files that overlap SQLite sidecars, locks, or each other.
  const reserved = (p: string) => [
    p,
    p + "-wal",
    p + "-shm",
    p + ".watch.lock",
    p + ".tmp",
  ];
  const outputs = [database, ...(feed ? [feed.path] : [])].flatMap(reserved);
  const overlaps = (p: string, q: string) =>
    p === q || p.startsWith(q + path.sep) || q.startsWith(p + path.sep);
  const internal = ["ownership.json", ".owner.watch.lock", "targets"].map(
    (name) => path.join(state, name),
  );
  if (
    new Set(outputs).size !== outputs.length ||
    files.some((p, i) =>
      files.some(
        (q, j) =>
          i !== j && (p.startsWith(q + path.sep) || q.startsWith(p + path.sep)),
      ),
    ) ||
    actions.some((a) => "rule" in a.task && outputs.includes(a.task.rule)) ||
    files.includes(state) ||
    files.some((p) => internal.some((q) => overlaps(p, q))) ||
    (configurationFile !== undefined &&
      (reserved(configurationFile).some((p) =>
        outputs.some((q) => overlaps(p, q)),
      ) ||
        state === configurationFile ||
        state.startsWith(configurationFile + path.sep)))
  )
    throw new ConfigurationError("State, feed and rule paths conflict");
  return {
    schema_version: 1,
    id: checkedId(string(v.id)),
    state_directory: state,
    database,
    source,
    observation: { mode: "poll", interval_seconds: interval },
    ...(feed ? { feed } : {}),
    actions,
  };
}
export function loadConfiguration(file: string, checkInputs = true) {
  return parseConfiguration(
    JSON.parse(fs.readFileSync(file, "utf8")),
    path.dirname(path.resolve(file)),
    checkInputs,
    canonicalPath(path.resolve(file)),
  );
}
