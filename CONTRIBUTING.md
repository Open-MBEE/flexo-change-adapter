# Contributing

Focused bug reports, documentation improvements and pull requests are welcome. The project maintainers are Jason Han ([@HuiJun](https://github.com/HuiJun)) and Rohan ([@rororowyourboat](https://github.com/rororowyourboat)). Read the [current status](docs/status.md) before proposing work so implementation, local verification and live acceptance remain distinct.

For vulnerabilities, use the private route in [SECURITY.md](SECURITY.md).

## Branching and review

We use [Git Flow](docs/branching.md): `main` holds released code, `develop` integrates upcoming work, and short-lived `feature/*`, `release/*` and `hotfix/*` branches carry changes. Open ordinary contribution PRs against `develop`. Release and hotfix PRs target `main`, with their changes merged back into `develop` through PRs.

Jason and Rohan own all repository paths through [CODEOWNERS](.github/CODEOWNERS). Changes require approval from at least one maintainer other than the author. The [branch protection policy](docs/branching.md#branch-protection) defines the required GitHub settings for `main`.

## Set up locally

Use Node.js 24.16.0 and npm. From your checkout:

```bash
npm ci
npm run adapter -- --help
npm run adapter -- check --config examples/configuration/feed.json
```

The configuration check runs offline without credentials or creating state. Follow [installation](docs/installation.md) for platform prerequisites and [configuration](docs/configuration.md) when connecting a source or CI destination. Configured `run` commands, including `run --once`, require Linux `flock` for exclusive writer locking.

The active runtime is TypeScript.

## Find the relevant code

| Area                                   | Entry points                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| CLI and configuration                  | `src-ts/cli.ts`, `src-ts/configuration.ts`                                   |
| Source observations and durable events | `src-ts/sources.ts`, `src-ts/observer.ts`, `src-ts/journal.ts`               |
| Feed and action coordination           | `src-ts/feed.ts`, `src-ts/runtime.ts`, `src-ts/actions.ts`                   |
| GitHub validation                      | `src-ts/github-action.ts`, `src-ts/github-runner.ts`, `src-ts/github-job.ts` |
| Generic CI triggers                    | `src-ts/ci-trigger.ts`                                                       |
| Validation and snapshot input          | `src-ts/validation.ts`, `src-ts/flexo.ts`, `src-ts/rdf.ts`                   |
| Tests                                  | `tests-ts/`; [verification guide](tests/README.md)                           |

Keep polling, durable work and validation contracts independent of a CI provider. Read the [architecture](docs/architecture.md) before changing module boundaries, and [GitHub execution and recovery](docs/github-execution.md) before changing snapshot delivery, dispatch or reconciliation. Installed adapters are explicitly registered TypeScript modules.

## Make and verify a change

Keep changes focused and discuss production dependency additions with a maintainer before adding them. Use the existing npm lockfile. For source changes, run:

```bash
npm run check
npm test
npm run format:check
```

`npm run format` formats TypeScript source, tests and scripts. The format scripts do not include Markdown or GitHub templates. For documentation changes, verify the commands, relative links and examples you changed; report which checks actually ran.

Use isolated fixtures for failure scenarios. Tests that contact real Flexo or CI services, transfer model data or submit jobs need deliberately selected destinations and authorization from their owners. Local transport fixtures do not establish authenticated live compatibility.

Preserve exact model revision, rule and validator identities through recovery changes. Distinguish execution errors from SHACL violations and generic CI results from model conformance. Keep secrets, private models and infrastructure credentials out of pull requests and logs.

## Open an issue or pull request

For a bug, include a minimal sanitized reproduction, expected and observed behavior, runtime/source version, and relevant work or revision identities. Share synthetic fixtures where possible. Describe unavailable evidence explicitly.

For a pull request, explain the problem and resulting behavior, list checks actually run and any skipped checks, and update affected documentation. Preserve unrelated changes. Link the issue or design discussion when one exists.

Contributions are governed by the repository's [Apache 2.0 license](LICENSE). Preserve bundled [third-party asset notices](src-ts/assets/NOTICE.md).

## Dependencies

Dependencies are exact-pinned through the committed `package-lock.json`; install with `npm ci`, never `npm install`, and commit the lockfile with any change. Ask in the pull request before adding a production dependency: name what it does, its license and why the standard library or an existing dependency cannot do it. Dependabot opens weekly update pull requests for npm, GitHub Actions and the Docker base image; a maintainer reviews each one like any other change. Updates that fix a published vulnerability follow the deadlines in [SECURITY.md](SECURITY.md).
