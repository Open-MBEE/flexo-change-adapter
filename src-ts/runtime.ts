import * as fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { branch, type Configuration } from "./configuration.ts";
import { canonicalJson } from "./contracts.ts";
import {
  Journal,
  type ActionIntent,
  type FrozenAction,
  type PreparedAction,
} from "./journal.ts";
import { sourceAdapter } from "./sources.ts";
import { observeSource } from "./observer.ts";
import { bindStateDirectory } from "./ownership.ts";
import { actionAdapter } from "./actions.ts";

async function freezeActions(
  configuration: Configuration,
): Promise<PreparedAction[]> {
  return Promise.all(
    configuration.actions.map(async (a) =>
      (await actionAdapter(a.task.type, a.target.type)).freeze(a),
    ),
  );
}

async function deliveries(
  configuration: Configuration,
  journal: Journal,
  signal?: AbortSignal,
  background?: {
    inFlight: Map<string, Promise<void>>;
    failed: () => void;
    next: number;
  },
) {
  const groups = new Map<string, ActionIntent[]>();
  for (const intent of journal.intents()) {
    if (intent.state === "completed") continue;
    const action = JSON.parse(intent.action_json) as FrozenAction;
    const key = canonicalJson(action.target);
    groups.set(key, [...(groups.get(key) ?? []), intent]);
  }
  const advanceGroup = async (group: ActionIntent[]) => {
    for (const intent of group) {
      if (signal?.aborted) return;
      try {
        const selected = JSON.parse(intent.action_json) as FrozenAction;
        await (
          await actionAdapter(selected.task.type, selected.target.type)
        ).advance(configuration, journal, intent);
      } catch {
        journal.failure(intent.id);
        console.log(
          JSON.stringify({
            event: "action-advance-failed",
            action_intent_id: intent.id,
          }),
        );
      }
    }
  };
  if (background) {
    const entries = [...groups.entries()],
      first = background.next;
    for (let offset = 0; offset < entries.length; offset++) {
      const index = (first + offset) % entries.length;
      const [key, group] = entries[index];
      if (background.inFlight.has(key)) continue;
      if (background.inFlight.size >= 4) {
        background.next = index;
        break;
      }
      background.next = (index + 1) % entries.length;
      const task = advanceGroup(group)
        .catch(background.failed)
        .finally(() => background.inFlight.delete(key));
      background.inFlight.set(key, task);
    }
    return;
  }
  const pending = [...groups.values()];
  await Promise.all(
    Array.from({ length: Math.min(4, pending.length) }, async () => {
      for (;;) {
        const group = pending.shift();
        if (!group) return;
        await advanceGroup(group);
      }
    }),
  );
}
export async function retainedStatus(configuration: Configuration) {
  if (!fs.existsSync(configuration.database))
    return { schema_version: 1, initialized: false, actions: [] };
  const journal = new Journal(
    configuration.database,
    branch(configuration.source),
    true,
  );
  try {
    return {
      initialized: true,
      ...journal.view(
        branch(configuration.source),
        configuration.observation.interval_seconds,
      ),
      inputs: journal.inputs(),
      actions: await Promise.all(
        journal.intents().map(async (i) => ({
          id: i.id,
          event_id: i.event_id,
          commit_uri: i.commit_uri,
          action: JSON.parse(i.action_json),
          state: i.state,
          error: i.error,
          result: i.result_json ? JSON.parse(i.result_json) : null,
          delivery: (
            await actionAdapter(
              (JSON.parse(i.action_json) as FrozenAction).task.type,
              (JSON.parse(i.action_json) as FrozenAction).target.type,
            )
          ).status(configuration, i, journal),
        })),
      ),
    };
  } finally {
    journal.close();
  }
}
export async function runConfiguration(
  configuration: Configuration,
  once: boolean,
) {
  bindStateDirectory(configuration);
  const journal = new Journal(
    configuration.database,
    branch(configuration.source),
  );
  const abort = new AbortController(),
    stop = () => abort.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let tasks: Promise<void>[] = [];
  const inFlight = new Map<string, Promise<void>>();
  let deliveryFailed = false;
  const background = {
    inFlight,
    next: 0,
    failed: () => {
      deliveryFailed = true;
      abort.abort();
    },
  };
  try {
    const actions = await freezeActions(configuration),
      source = sourceAdapter(configuration.source);
    const poll = () => observeSource(configuration, source, journal, actions);
    if (once) {
      const code = await poll();
      await deliveries(configuration, journal, abort.signal);
      return (
        code ||
        (journal.intents().some((i) => i.state === "pending" && i.error)
          ? 2
          : 0)
      );
    }
    const wait = async () => {
      try {
        await delay(
          configuration.observation.interval_seconds * 1000,
          undefined,
          { signal: abort.signal },
        );
      } catch {}
    };
    tasks = [
      (async () => {
        while (!abort.signal.aborted) {
          await poll();
          await wait();
        }
      })(),
      (async () => {
        while (!abort.signal.aborted) {
          await deliveries(configuration, journal, abort.signal, background);
          await wait();
        }
      })(),
    ];
    await Promise.all(tasks);
    return deliveryFailed ? 2 : 130;
  } finally {
    abort.abort();
    await Promise.allSettled(tasks);
    await Promise.allSettled([...inFlight.values()]);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    journal.close();
  }
}
