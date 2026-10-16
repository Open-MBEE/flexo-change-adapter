# Testing and verification

## Active TypeScript suite

From the repository root, with the Node version and locked dependencies described in [contributing](../CONTRIBUTING.md):

```bash
npm run check
npm test
npm run format:check
```

`npm test` discovers `tests-ts/*.test.ts`. The suite covers configuration and CLI behavior, atomic journal/state persistence, event/feed behavior, pinned RDF reads and SHACL validation, GitHub delivery/claims/recovery, and mocked GitLab/Jenkins transport. Fixtures exercise failures without real service credentials. Consult [current status](../docs/status.md) for recorded results and acceptance limits rather than inferring live compatibility from a passing suite.

## Revision and recovery scenarios

- Invalid revision fails SHACL; corrected revision passes.
- A branch movement during execution does not alter the tested commit.
- Pending, dispatched and running work reconcile after adapter restart.
- Repeated polls do not create new work for the same revision/rule/validator identity.
- An accepted dispatch whose response is lost does not cause duplicate validation.
- Authentication, fetch and runner failures remain execution errors, not SHACL violations.
- An uncertain generic CI submission retains its identity and is not automatically resent when correlation is absent.
- Configuration changes do not retarget previously retained action intents.

Use isolated fixtures and mocked transport for bounded failure scenarios. Live verification needs separately authorized destinations, credentials and model-data transfer; record the exact runtime/workflow identities and retained evidence. A successful generic GitLab/Jenkins job is not proof of SHACL conformance. Passing SHACL is distinct from human research-case validation.
