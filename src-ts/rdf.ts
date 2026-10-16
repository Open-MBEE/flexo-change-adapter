import { DataFactory, Parser, Store, Writer } from "n3";
import type { Term, Quad } from "@rdfjs/types";
import * as fs from "node:fs";
export const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  RDFS = "http://www.w3.org/2000/01/rdf-schema#",
  SH = "http://www.w3.org/ns/shacl#",
  XSD = "http://www.w3.org/2001/XMLSchema#";
export const named = DataFactory.namedNode,
  literal = DataFactory.literal;
export function parse(raw: Uint8Array | string, baseIRI?: string) {
  return new Store(
    new Parser({ format: "text/turtle", baseIRI }).parse(
      typeof raw === "string"
        ? raw
        : new TextDecoder("utf-8", { fatal: true }).decode(raw),
    ),
  );
}
export const objects = (g: Store, s: Term | string, p: string) =>
  g.getObjects(typeof s === "string" ? named(s) : s, named(p), null);
export const subjects = (g: Store, p: string, o: Term | string, lit = false) =>
  g.getSubjects(
    named(p),
    typeof o === "string" ? (lit ? literal(o) : named(o)) : o,
    null,
  );
export const value = (g: Store, s: Term | string, p: string) =>
  objects(g, s, p)[0]?.value ?? "";
export function add(
  g: Store,
  s: string,
  p: string,
  o: string | boolean,
  asLiteral = false,
  datatype?: string,
) {
  g.addQuad(
    named(s),
    named(p),
    typeof o === "boolean"
      ? literal(String(o), named(XSD + "boolean"))
      : asLiteral
        ? literal(o, datatype ? named(datatype) : undefined)
        : named(o),
  );
}
export async function serialize(g: Store, format = "N-Triples") {
  return new Promise<Buffer>((resolve, reject) => {
    const w = new Writer({ format });
    w.addQuads(g.getQuads(null, null, null, null));
    w.end((e, text) =>
      e
        ? reject(e)
        : resolve(
            Buffer.from(
              format === "N-Triples"
                ? text.split("\n").filter(Boolean).sort().join("\n") + "\n"
                : text,
            ),
          ),
    );
  });
}
export function rdfsClosure(data: Store, ontology = new Store()) {
  const g = new Store([...data, ...ontology]);
  let changed = true;
  while (changed) {
    const before = g.size;
    for (const q of [...g]) {
      if (q.predicate.value === RDF + "type")
        for (const sup of objects(g, q.object, RDFS + "subClassOf"))
          if (sup.termType !== "Literal")
            g.addQuad(q.subject, named(RDF + "type"), sup as any);
      for (const sup of objects(g, q.predicate, RDFS + "subPropertyOf"))
        if (sup.termType === "NamedNode") g.addQuad(q.subject, sup, q.object);
      for (const c of objects(g, q.predicate, RDFS + "domain"))
        if (c.termType !== "Literal")
          g.addQuad(q.subject, named(RDF + "type"), c as any);
      for (const c of objects(g, q.predicate, RDFS + "range"))
        if (q.object.termType !== "Literal" && c.termType !== "Literal")
          g.addQuad(q.object as any, named(RDF + "type"), c as any);
      for (const relation of [RDFS + "subClassOf", RDFS + "subPropertyOf"])
        if (q.predicate.value === relation)
          for (const sup of objects(g, q.object, relation))
            if (sup.termType !== "Literal")
              g.addQuad(q.subject, q.predicate, sup as any);
    }
    changed = g.size !== before;
  }
  return g;
}
function checkOffline(shapes: Store) {
  for (const q of shapes) {
    if (q.predicate.value === "http://www.w3.org/2002/07/owl#imports")
      throw Error("External shape imports are disabled");
    if (
      [SH + "select", SH + "ask"].includes(q.predicate.value) &&
      /\b(?:SERVICE|FROM)\b/i.test(q.object.value)
    )
      throw Error("Network SPARQL constructs are disabled");
    if ([SH + "js", SH + "rule", SH + "values"].includes(q.predicate.value))
      throw Error("Unsupported SHACL extension");
  }
}
const factory = {
  ...DataFactory,
  dataset: (quads?: Iterable<Quad>) => new Store(quads ? [...quads] : []),
};
export async function validateGraph(
  data: Store,
  shapes: Store,
  {
    meta = false,
    ontology,
    inference = false,
  }: { meta?: boolean; ontology?: Store; inference?: boolean } = {},
) {
  checkOffline(shapes);
  const [{ Validator }, { validations, targetResolvers }] = await Promise.all([
    import("shacl-engine"),
    import("shacl-engine/sparql.js"),
  ]);
  if (meta) {
    const metaShapes = parse(
      fs.readFileSync(new URL("./assets/shacl-shacl.ttl", import.meta.url)),
    );
    const result = await new Validator(metaShapes, {
      factory,
      validations,
      targetResolvers,
    }).validate({ dataset: shapes });
    if (!result.conforms)
      throw Error("SHACL shapes do not conform to meta-SHACL");
  }
  const report = await new Validator(shapes, {
    factory,
    validations,
    targetResolvers,
  }).validate({ dataset: inference ? rdfsClosure(data, ontology) : data });
  const graph = new Store([...report.dataset]);
  const bytes = await serialize(graph);
  return {
    conforms: report.conforms as boolean,
    graph,
    bytes,
    report: bytes.toString("utf8"),
  };
}
export async function graphEqual(a: Store, b: Store): Promise<boolean> {
  if (a.size !== b.size) return false;
  if (
    ![...a, ...b].some((q) =>
      [q.subject, q.object, q.graph].some((t) => t.termType === "BlankNode"),
    )
  )
    return [...a].every((q) => b.has(q));
  const { canonize } = await import("rdf-canonize");
  const canonical = async (graph: Store) =>
    canonize((await serialize(graph, "N-Quads")).toString("utf8"), {
      algorithm: "RDFC-1.0",
      inputFormat: "application/n-quads",
      maxWorkFactor: 1,
      signal: AbortSignal.timeout(10000),
    });
  return (await canonical(a)) === (await canonical(b));
}
