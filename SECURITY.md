# Security policy

The response times and the disclosure process below are the commitments reporters can hold us to. They are set to the bar this adapter will be held to as a tool that touches engineering models and CI credentials, not to its current alpha stage.

## Reporting a vulnerability

Report vulnerabilities **privately**, through GitHub's private vulnerability reporting: [Security → Report a vulnerability](https://github.com/Open-MBEE/flexo-change-adapter/security/advisories/new) on this repository. Do not open a public issue, pull request or discussion for anything you believe is a security problem, and do not include a working exploit in a public place before the advisory is published.

If that form is unavailable or you get no acknowledgement within the deadline below, e-mail a maintainer directly with `[flexo-change-adapter security]` in the subject: Rohan at <rohan@dynamicalsystemsgroup.com> or Jason Han at <jason.han@jpl.nasa.gov>. A report sent that way gets the same handling.

A report is most useful when it has:

- the affected source revision or release tag and the Node version;
- the component: source observation (`flexo.ts`, `observer.ts`), durable state (`journal.ts`, `state.ts`, the SQLite databases and spool), a CI target (GitHub, GitLab, Jenkins), a validation engine action, the CLI, the container image or a workflow;
- a minimal reproducer: the configuration, input graph or request that triggers the problem, with credentials, private model graphs and unrelated personal information removed;
- the impact as you understand it (what an attacker gains, and from where).

Reports are handled by the maintainers named in [`.github/CODEOWNERS`](.github/CODEOWNERS), **Jason Han ([@HuiJun](https://github.com/HuiJun))** and **Rohan ([@rororowyourboat](https://github.com/rororowyourboat))**. If a report has gone a week without an acknowledgement, reach either of them through an `@`-mention on any issue of this repository, saying only that a private report is waiting.

## What to expect

| Step | Deadline, from receipt |
| --- | --- |
| Acknowledgement | 3 business days |
| Triage: confirmed or not, severity (CVSS v3.1), affected versions | 7 calendar days |
| Fix released, **critical** severity | 14 calendar days |
| Fix released, **high** or **medium** severity | 60 calendar days |
| Fix released, **low** severity | next scheduled release |
| Advisory published | with the fix release |

Severity is scored with [CVSS v3.1](https://www.first.org/cvss/v3.1/specification-document) and may be revised during triage; the reporter is told the score and the reasoning. A fix that cannot meet its deadline is not hidden: the reporter is told why, given the new date, and the advisory says what to do in the meantime.

Fixes ship as a release (a patch release of the current line, or a hotfix cut from `main`, see [docs/releasing.md](docs/releasing.md)) and a [GitHub Security Advisory](https://github.com/Open-MBEE/flexo-change-adapter/security/advisories) that names the affected and fixed versions, the CVE (requested through GitHub), the reporter if they want credit, and any mitigation for operators who cannot update at once.

## Coordinated disclosure

We ask reporters to keep the report private until the advisory is published. We publish within **90 days** of receipt whether or not a fix is ready, unless the reporter and the project agree in writing to a longer embargo; a vulnerability already being exploited is published, with mitigations, as soon as there is something actionable to say. Reporters are credited in the advisory unless they ask not to be. There is no bug bounty.

## Automated and AI-assisted reports

Reports produced by scanners, fuzzers or AI assistants are welcome on the same terms as any other, with one requirement: the report must contain a reproducer that we can run against a current release or `main` and that demonstrates the claimed impact. A report that consists of a tool's unverified output, a theoretical pattern with no reproducer, or a reproducer that does not demonstrate the stated impact is closed as unverified without triage, and the reporter is told so within the acknowledgement deadline. Please say in the report when it was produced or assisted by a tool; it does not count against the report.

## Supported versions

| Version | Supported |
| --- | --- |
| The latest release on [Releases](https://github.com/Open-MBEE/flexo-change-adapter/releases) | Yes: fixes ship as a patch release of that line |
| Earlier releases | No: update to the latest release |
| `main` between releases | Fixed as soon as the fix merges; no advisory covers an unreleased commit |

Until 1.0.0, each release line is supported only until the next release. From 1.0.0 the previous minor release line is also supported for 90 days after its successor ships, so that a fix can be taken without a feature update.

## What counts as a vulnerability

In scope:

- reading, writing or disclosing a Flexo graph, a retained snapshot or a validation result that the configured credentials do not authorize, or beyond the exact revision the adapter observed;
- code execution, path traversal, file disclosure or unbounded resource use from a crafted graph, rule, configuration, CI response or engine output — the adapter must fail with a diagnostic, never execute or exhaust the host;
- weakening of the durable-state contract: a replayed, altered or forged event, claim, input bundle or result accepted as genuine, or state and spool files created with permissions wider than the process owner;
- the CI surfaces: dispatch to GitHub, GitLab and Jenkins, the private execution repository and its reviewed workflow, worker claims and result reconciliation;
- credentials or private model content in the repository, releases, container image, logs, retained records or issues;
- the supply chain: the lockfile, the container build, the release workflow and its SBOM and provenance.

Out of scope: Flexo MMS, the validation engines (OpenSysML, SysML Toolkit, the SHACL engine) and the CI platforms themselves (report to their maintainers), the contents of an operator's own models, and findings that require an already-compromised host, environment or CI account.

## Security design

The controls that protect the adapter and the data it handles — who can act, how state is protected, how input is checked, how execution is isolated — are described in [docs/security-design.md](docs/security-design.md). That document is updated with any change to those controls; a release whose controls differ from the document is a bug.

## Verifying what you run

Every release from `v0.2.0` onward ships the packed npm tarball, a checksum manifest `SHA256SUMS.txt`, an SPDX SBOM, and a GitHub artifact attestation (SLSA build provenance) for each asset. Verify with `gh attestation verify <asset> --repo Open-MBEE/flexo-change-adapter`; see [docs/releasing.md](docs/releasing.md). A release asset that does not verify is a vulnerability report in itself: send it through the channel above.

## Dependencies and static analysis

Dependabot alerts and CodeQL code-scanning results on this repository are watched by the maintainers and remediated on the deadlines in the table above (critical within 14 days, high and medium within 60). Dependency updates that fix a published vulnerability are released on the same schedule as a vulnerability in our own code.
