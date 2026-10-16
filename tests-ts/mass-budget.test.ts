import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import {
  parse,
  validateGraph,
  named,
  literal,
  RDF,
  XSD,
} from "../src-ts/rdf.ts";
const SYSML = "https://www.omg.org/spec/SysML#",
  EX = "urn:test:mass:",
  ROOT = "urn:sysmlv2:element:28fbc57e-7c1d-4b94-9446-1b2dc89b1373";
const rule = parse(
  fs.readFileSync(
    new URL("../examples/satellite-mass-budget-v1/rule.ttl", import.meta.url),
  ),
);
function fixture(dry = "350.0", max = "500.0") {
  return parse(
    `@prefix s:<${SYSML}>. @prefix x:<${XSD}>. <${ROOT}> a s:PartDefinition . ${[
      ["dryMass", dry],
      ["maximumMass", max],
    ]
      .map(
        ([name, n]) =>
          `<${EX + name}> a s:AttributeUsage; s:owner <${ROOT}>; s:declaredName "${name}"; s:ownedRelationship <${EX + name}-feature>. <${EX + name}-feature> a s:FeatureValue; s:ownedRelatedElement <${EX + name}-value>. <${EX + name}-value> a s:LiteralRational; s:value "${n}"^^x:double .`,
      )
      .join("\n")}`,
  );
}
for (const [dry, max, expected] of [
  ["350.0", "500.0", true],
  ["550.0", "500.0", false],
  ["500.0", "500.0", true],
  ["0.0", "500.0", false],
  ["-1.0", "500.0", false],
  ["350.0", "-1.0", false],
] as const)
  test(`SPARQL mass budget ${dry}/${max}`, async () =>
    assert.equal(
      (await validateGraph(fixture(dry, max), rule, { meta: true })).conforms,
      expected,
    ));
const mutations = [
  [
    "deleted-target",
    (g: any) => g.removeQuads(g.getQuads(named(ROOT), null, null, null)),
  ],
  [
    "missing-owner",
    (g: any) =>
      g.removeQuads(
        g.getQuads(named(EX + "dryMass"), named(SYSML + "owner"), null, null),
      ),
  ],
  [
    "missing-value",
    (g: any) =>
      g.removeQuads(
        g.getQuads(
          named(EX + "dryMass-value"),
          named(SYSML + "value"),
          null,
          null,
        ),
      ),
  ],
  [
    "text-value",
    (g: any) => {
      g.removeQuads(
        g.getQuads(
          named(EX + "dryMass-value"),
          named(SYSML + "value"),
          null,
          null,
        ),
      );
      g.addQuad(
        named(EX + "dryMass-value"),
        named(SYSML + "value"),
        literal("unknown"),
      );
    },
  ],
  [
    "duplicate-value",
    (g: any) =>
      g.addQuad(
        named(EX + "dryMass-value"),
        named(SYSML + "value"),
        literal("700.0", named(XSD + "double")),
      ),
  ],
  [
    "duplicate-attribute",
    (g: any) => {
      g.addQuad(named(EX + "other"), named(SYSML + "owner"), named(ROOT));
      g.addQuad(
        named(EX + "other"),
        named(SYSML + "declaredName"),
        literal("dryMass"),
      );
    },
  ],
  [
    "duplicate-initializer",
    (g: any) => {
      g.addQuad(
        named(EX + "dryMass"),
        named(SYSML + "ownedRelationship"),
        named(EX + "otherFeature"),
      );
      g.addQuad(
        named(EX + "otherFeature"),
        named(RDF + "type"),
        named(SYSML + "FeatureValue"),
      );
    },
  ],
] as const;
for (const [name, mutate] of mutations)
  test("SPARQL refuses " + name, async () => {
    const g = fixture();
    mutate(g);
    assert.equal(
      (await validateGraph(g, rule, { meta: true })).conforms,
      false,
    );
  });
test("malformed shapes fail meta-validation", async () => {
  await assert.rejects(
    validateGraph(
      fixture(),
      parse(
        '@prefix sh:<http://www.w3.org/ns/shacl#>. <urn:s> a sh:NodeShape; sh:targetNode <urn:n>; sh:property [sh:path <urn:p>;sh:minCount "many"].',
      ),
      { meta: true },
    ),
  );
});
test("external imports and query network access are refused", async () => {
  for (const raw of [
    "<urn:s> <http://www.w3.org/2002/07/owl#imports> <https://example.com/shapes>.",
    '@prefix sh:<http://www.w3.org/ns/shacl#>. <urn:s> a sh:NodeShape;sh:sparql [sh:select "SELECT $this WHERE { SERVICE <https://example.com/> {?s ?p ?o} }"] .',
  ])
    await assert.rejects(validateGraph(fixture(), parse(raw)));
});
