import type {
  Action,
  Configuration,
  TriggerAction,
  ValidationAction,
} from "./configuration.ts";
import type { ActionIntent, Journal, PreparedAction } from "./journal.ts";
type ActionAdapter = {
  freeze(action: Action): PreparedAction;
  advance(
    configuration: Configuration,
    journal: Journal,
    intent: ActionIntent,
  ): Promise<void>;
  status(
    configuration: Configuration,
    intent: ActionIntent,
    journal: Journal,
  ): unknown;
  recovery: { reconcile_before_retry: boolean; durable_worker_claim: boolean };
};
// Explicit registration keeps module loading tied to the selected task/target.
const actions: Record<string, () => Promise<ActionAdapter>> = {
  "shacl-validation:github": async () => {
    const { freezeAction, advanceIntent, deliveryStatus } =
      await import("./github-action.ts");
    return {
      freeze: (a) => freezeAction(a as ValidationAction),
      advance: advanceIntent,
      status: deliveryStatus,
      recovery: { reconcile_before_retry: true, durable_worker_claim: true },
    };
  },
  "engine-validation:github": async () => {
    const { freezeEngineAction, advanceEngineIntent, engineDeliveryStatus } =
      await import("./engine-action.ts");
    return {
      freeze: (a) =>
        freezeEngineAction(a as import("./configuration.ts").EngineAction),
      advance: advanceEngineIntent,
      status: engineDeliveryStatus,
      recovery: { reconcile_before_retry: true, durable_worker_claim: true },
    };
  },
  "ci-trigger:gitlab": trigger,
  "ci-trigger:jenkins": trigger,
};
async function trigger(): Promise<ActionAdapter> {
  const { freezeTrigger, advanceTrigger, triggerStatus } =
    await import("./ci-trigger.ts");
  return {
    freeze: (a) => freezeTrigger(a as TriggerAction),
    advance: advanceTrigger,
    status: triggerStatus,
    recovery: { reconcile_before_retry: true, durable_worker_claim: false },
  };
}
export async function actionAdapter(task: string, target: string) {
  const key = `${task}:${target}`;
  if (!Object.hasOwn(actions, key))
    throw Error("Unavailable task/target pairing");
  return actions[key]();
}
