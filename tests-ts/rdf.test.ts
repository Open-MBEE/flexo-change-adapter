import { test } from "node:test";
import assert from "node:assert/strict";
import { graphEqual, parse } from "../src-ts/rdf.ts";
test("RDFC-1.0 ignores blank-node labels and triple order", async () => {
  const a = parse('_:a <urn:edge> _:b. _:b <urn:label> "value".');
  const b = parse('_:y <urn:label> "value". _:x <urn:edge> _:y.');
  assert.equal(await graphEqual(a, b), true);
  assert.equal(
    await graphEqual(a, parse('_:y <urn:label> "other". _:x <urn:edge> _:y.')),
    false,
  );
});
test("Graph equality preserves literal datatypes and named-node identity", async () => {
  assert.equal(
    await graphEqual(
      parse('<urn:a> <urn:p> "1".'),
      parse("<urn:a> <urn:p> 1."),
    ),
    false,
  );
  assert.equal(
    await graphEqual(
      parse("<urn:a> <urn:p> <urn:b>."),
      parse("<urn:c> <urn:p> <urn:b>."),
    ),
    false,
  );
  assert.equal(await graphEqual(parse(""), parse("")), true);
});
