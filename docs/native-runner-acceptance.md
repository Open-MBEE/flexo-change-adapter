# Native validation runner acceptance

Verified on 16 October 2026 against Jenkins 2.580.1 on localhost and GitLab.com project `e4rohan/test-project`, using dedicated self-hosted workers and shared durable POSIX storage. The actual retained bindings are in [the acceptance index](native-runner-acceptance.json).

| Runner  | Checker       | Input/check               | Retained verdict | Native job                                                                           |
| ------- | ------------- | ------------------------- | ---------------- | ------------------------------------------------------------------------------------ |
| jenkins | opensysml     | Valid text                | pass             | [Jenkins #1](https://localhost:18443/job/adapter-validate/1/)                        |
| jenkins | sysml-toolkit | Valid text                | pass             | [Jenkins #2](https://localhost:18443/job/adapter-validate/2/)                        |
| jenkins | opensysml     | Malformed text            | fail             | [Jenkins #3](https://localhost:18443/job/adapter-validate/3/)                        |
| jenkins | sysml-toolkit | Malformed text            | fail             | [Jenkins #4](https://localhost:18443/job/adapter-validate/4/)                        |
| jenkins | shacl         | Deliberate rule violation | nonconforming    | [Jenkins #5](https://localhost:18443/job/adapter-validate/5/)                        |
| gitlab  | opensysml     | Valid text                | pass             | [GitLab job 17229589308](https://gitlab.com/e4rohan/test-project/-/jobs/17229589308) |
| gitlab  | sysml-toolkit | Valid text                | pass             | [GitLab job 17229600108](https://gitlab.com/e4rohan/test-project/-/jobs/17229600108) |
| gitlab  | opensysml     | Malformed text            | fail             | [GitLab job 17229604598](https://gitlab.com/e4rohan/test-project/-/jobs/17229604598) |
| gitlab  | sysml-toolkit | Malformed text            | fail             | [GitLab job 17229607521](https://gitlab.com/e4rohan/test-project/-/jobs/17229607521) |
| gitlab  | shacl         | Deliberate rule violation | nonconforming    | [GitLab job 17229610862](https://gitlab.com/e4rohan/test-project/-/jobs/17229610862) |

The valid input is the original multi-file SysML bundle bound to Flexo revision `739685fc-034c-4474-8ed4-d4a12d477e86`. The malformed bundle was authored and captured from the isolated local Flexo revision `a19f4b38-e25e-4897-8ce6-497b635752c1`. Both engines ran on the original bytes without conversion through the other engine. The source branch had already moved when jobs validated the older retained revision. SHACL used the captured RDF provenance index and an explicit synthetic target rule that deliberately fails; this is not a semantic RDF conversion or a SysML conformance claim.

The driver closed and reopened its SQLite state after dispatch, then recovered the exact claim owner and result through each platform's APIs. A later driver restart reused all five completed Jenkins computations without creating another Jenkins build. Native status, exact input variables, job/build identities, retained input/report digests and decoded checker verdicts all agreed. The temporary GitLab pipeline trigger was revoked afterward. The project-locked protected local runner and dedicated Jenkins agent remain running for development; no production watcher was deployed.

The approved GitLab pipeline commit is [`d2e62cf`](https://gitlab.com/e4rohan/test-project/-/commit/d2e62cf7de54963a93391bdfe5eae09688a207be). It preserves the generic metadata job and adds the reviewed `adapter-validate` job for triggered protected-main pipelines on the dedicated local runner. Model files and reports remain in local shared storage; no Flexo credential is given to CI.

## Setup failures resolved before acceptance

The first Jenkins agent launcher invoked a CLI parser that printed part of its generated local credential in a usage error. That agent was removed and replaced with a different agent identity and credential. The final launcher configures Remoting directly and receives its credential through a RAM-backed FIFO, avoiding both process arguments and the CLI usage printer.

The initial GitLab shell runner attempted an unnecessary user switch inside its capability-restricted container and failed before claiming work. Removing that switch fixed startup. The bounded driver initially timed out; retrying the original job then established the valid claim/result. The completed acceptance reused original work identities and records. These startup failures are not model failures and are not counted among the ten completed validation cases.

## Verification scope and retained data

The native regression suite passed 65 tests, including controlled lost-response recovery, duplicate claims, crashed workers, missing credentials, input/owner/report tampering, frozen configuration and generic CI compatibility. TypeScript and source formatting checks passed. Live acceptance above covers actual source capture, both real engines, syntax failures, SHACL failure and restart/result reuse on each native platform. It does not establish live fault injection for every regression scenario.

Full evidence is retained under ignored `.local/native-validation/evidence/`, with driver captures in `.local/native-validation/acceptance-CTp9Y8/` and the earlier incomplete setup attempt in `acceptance-r7U0ki/`. The shared index contains non-secret synthetic model revision identities and report fingerprints. Runner registration credentials are held only in container tmpfs; resolved project API credentials remain in memory. No 1Password item was created or edited.

These are tested local/self-hosted validation runners, not acceptance of arbitrary Jenkins/GitLab installations or hosted runners without shared storage. GitHub's updated common evidence code has regression coverage; a hosted GitHub run of this source revision was not repeated. Constraint execution, project gates and production deployment remain separate work.
