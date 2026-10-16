import { branch, type FlexoSource } from "./configuration.ts";
import { connectFlexo, transport } from "./flexo.ts";

export interface Source {
  readonly capabilities: { poll: true; exact_snapshot: boolean };
  readHead(): Promise<string>;
}
const sources = {
  flexo: (configuration: FlexoSource): Source => ({
    capabilities: { poll: true, exact_snapshot: true },
    async readHead() {
      return (
        await connectFlexo(
          configuration.endpoint,
          transport,
          configuration.credentials,
        )
      ).head(branch(configuration));
    },
  }),
};
export function sourceAdapter(configuration: FlexoSource): Source {
  return sources[configuration.type](configuration);
}
