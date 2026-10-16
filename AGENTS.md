# Flexo Change Adapter

The runtime is TypeScript with npm and the committed package-lock.json. Read docs/architecture.md before changing modules, docs/configuration.md before changing configuration/state contracts, and docs/github-execution.md before changing snapshots, dispatch or recovery.

Keep source observation, durable state and validation contracts independent of CI targets. Configuration selects reviewed registered adapters. Preserve exact revision, rule, destination and validator identities through restart/recovery. Generic CI outcomes are distinct from SHACL results.

Keep changes focused and ask before adding production dependencies. Preserve unrelated changes and use explicit paths when staging. Commit and publish only with authorization. Keep README setup and docs/status.md accurate; distinguish local tests, authenticated platform checks and deployment.

For runtime changes run npm run check, npm test and npm run format:check. Verify changed documentation links/examples; report checks actually performed. Keep secrets and private models out of source, logs and issues. GitHub validation requires a private execution repository and reviewed manual workflow on main; never run arbitrary pull-request code with infrastructure credentials.
