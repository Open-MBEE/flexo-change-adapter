# GitHub execution and recovery

The GitHub adapter validates immutable checker-specific inputs in a private execution repository. The source repository can be public; the execution repository must remain private because snapshots and reports are retained there. Install matching reviewed source, locked dependencies and workflow on its `main` branch. See [installation](installation.md#add-ci-actions).

## Input delivery

The private adapter fetches the exact Flexo revision through a named lock, verifies its before/after commit binding and ETag, and retains `model.ttl`, `rule.ttl` and `snapshot.json` together in its local spool. The snapshot metadata binds model bytes to the queued request. Existing captured input is reused after restart; it is never re-fetched from a moving branch.

The GitHub runner checks the configured repository is private, writes those three data files as Git objects, and creates `refs/tags/flexo-ci-input-WORK_ID`. GitHub's [Git object APIs](https://docs.github.com/en/rest/git) retain the record independently of Actions artifact expiration. This adapter only creates record references; it contains no update/delete operation. A repeated input publication must match the retained files exactly. An input bundle is limited to 4 MiB.

Persist the resulting input commit, bundle digest and runner identity in SQLite before dispatch. The workflow receives those identities, not the model graph or an arbitrary download URL in its trigger payload. It reads the pinned Git commit and verifies every blob's Git identity, model digest, rule digest and work identity. No Flexo credential or tailnet access is provided to GitHub.

## Text-engine bundles

Registered OpenSysML/Toolkit actions share the same input/claim/result reference protocol. Their input records contain `engine-request.json` and `model-bundle.json`; the latter retains original source bytes and verified producer/revision provenance. Each computation includes its own frozen binary/library/wrapper profile. Result records retain `report.json`, `report.txt` and `result.json`, with native output and explicit pass/fail/inconclusive outcomes. The worker and reconciler both validate the exact file set and native verdict. See [engine setup and evidence](validation-engines.md).

## Worker claim and reports

Use [workflow_dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event) against reviewed `main` and the fixed `.github/workflows/flexo-validate.yml`. The job checks the repository and branch; there is no pull-request, push, tag or deployment trigger. Input values are passed through environment variables and validated as digests; they are never inserted into shell code. Checkout and setup-node actions are pinned to source commits. The TypeScript workflow pins Node 24.16.0 and installs production dependencies with `npm ci --omit=dev`. The native tests exercise this protocol with controlled transport; verify your selected installation before relying on it. See [architecture](architecture.md).

Before checker execution, the worker commits a claim containing the exact input binding, work ID, workflow source SHA, run ID and run attempt, then attempts to create `refs/tags/flexo-ci-claim-WORK_ID`. Competing workers resolve the [reference creation](https://docs.github.com/en/rest/git/refs#create-a-reference) conflict to the existing owner. A worker that encounters an existing claim skips validation, including when the same workflow run is re-run. Concurrency reduces overlap but does not provide this durable claim.

The winner validates using the pinned source/dependency/runtime identity and retains the complete evidence as Git objects. A report commit supplies an immutable `report.txt` URL. A child result commit adds `result.json` referencing that report commit, and `refs/tags/flexo-ci-result-WORK_ID` retains the result. Records preserve model revision, input digest, rule version/digest, validator details, run/attempt/source identity and report digest/URL. Nonconforming validation exits 1 after publishing its failed report; conforming validation exits 0.

These are machine-generated Git data records, not accepted research declarations or human-signed source commits. They add three lightweight tags per validation work item. This is a bounded MVP storage tradeoff; repository backup, protection of the CI record tags and retention need an operations decision before wider use. Administrators or other repository writers can alter/delete records outside this adapter. No cryptographic independence from the repository administrator is claimed.

## Adapter restart and retry

The CI-neutral worker inspects the durable claim/result before dispatching or retrying. It binds local work to the claim owner, not merely to the trigger's returned run ID. It verifies the owner's [specific workflow run attempt](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run-attempt), its code SHA, event/path and conclusion. Completion requires retained input/report/result agreement and a completed Actions attempt. A newer retry attempt cannot replace the original evidence.

Persist delivery attempts before requesting GitHub. Transport failure leaves work `dispatching`; it does not return work to pending. If no claim is visible after successful inspection, the adapter may redeliver after at least 60 seconds, for at most three attempts. Such redelivery can create duplicate workflow jobs; the atomic claim must prevent duplicate checker execution. An inspection failure does not justify redelivery. Exhausted unclaimed work remains visible and requires operator investigation.

A claimed worker that terminates without a retained result becomes an `execution-error`, linked to its workflow attempt. Its claim is not deleted, and automatic re-validation is refused. This favors avoiding duplicate execution over automatic worker-crash recovery. There is no general exactly-once guarantee across a worker crash between claiming and publishing. The bounded live demonstration verified adapter restart and lost-dispatch-response recovery; see the linked evidence. Worker-crash re-execution remains outside that guarantee.

## Continuous operation

The configured `run` command uses the observation/journal runtime. Observation and delivery progress independently, with bounded groups per destination. The configured interval is a wait between polls, so network/login time adds to elapsed time. New observations commit transactionally with their selected intents. Source/state ownership and Linux advisory locks prevent conflicting writers. See [architecture](architecture.md).

Captured snapshots and SQLite data must live outside a container's writable layer. The delivery loop reuses old spooled inputs even if the current rule has changed. Old pending work without a captured snapshot requires its original rule/validator environment; it remains visible rather than silently adopting the new version. Already prepared GitHub work can reconcile while Flexo is unavailable. Long-lived GitHub token refresh and daemon deployment are not implemented.

The watcher needs scoped GitHub Contents write for data records and Actions write/read for dispatch/status. The reviewed workflow uses repository `GITHUB_TOKEN` with Contents write only; it has no infrastructure secret and cannot deploy the server. The historical 4 October 2026 review records approval for that bounded demonstration's permissions and model transfer. That approval is not authorization for new transfers or deployments. Existing GitHub access does not establish a provisioned production watcher credential.
