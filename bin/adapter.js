#!/usr/bin/env node
import { Effect } from "effect";
import { main } from "../src-ts/cli.ts";
const result = await Effect.runPromise(
  Effect.either(
    Effect.tryPromise({
      try: () => main(),
      catch: () => new Error("Adapter failed"),
    }),
  ),
);
if (result._tag === "Left") {
  console.log(
    JSON.stringify({ outcome: "execution-error", error_type: "AdapterError" }),
  );
  process.exitCode = 2;
} else process.exitCode = result.right;
