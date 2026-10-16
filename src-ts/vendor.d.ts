declare module "shacl-engine" {
  export class Validator {
    constructor(dataset: any, options: any);
    validate(data: any): Promise<any>;
  }
}
declare module "shacl-engine/sparql.js" {
  export const validations: any;
  export const targetResolvers: any;
}

declare module "rdf-canonize" {
  export function canonize(
    input: string,
    options: {
      algorithm: "RDFC-1.0";
      inputFormat: "application/n-quads";
      maxWorkFactor: number;
      signal: AbortSignal;
    },
  ): Promise<string>;
}
