// Exercise the public CLI while making validation dependencies unavailable.
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      /(?:validation|github-action|github-runner|github-api)\.ts$/.test(
        specifier,
      ) ||
      specifier === "shacl-engine" ||
      specifier.startsWith("shacl-engine/") ||
      specifier === "rdf-canonize" ||
      (process.env.TEST_NO_RDF && specifier === "n3")
    ) {
      throw Error("Unexpected validation dependency in lightweight operation");
    }
    return nextResolve(specifier, context);
  },
});
