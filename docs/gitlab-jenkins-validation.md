# Verified validation on GitLab and Jenkins

`shacl-validation` and `engine-validation` actions can target GitLab or Jenkins using shared durable storage. Generic `ci-trigger` actions remain available when a project only needs revision metadata and native CI status. GitHub is not required for these runners.

## Inputs, claims and results

The watcher prepares exactly the same revision-bound SHACL snapshot or original SysML text bundle used by the GitHub path. `validation-records.ts` owns checker execution and evidence verification for all three CI targets. Native execution uses `SharedValidationRunner`, `NativeCI` and `FileEvidence`.

Configure `target.evidence_directory` as a persistent shared POSIX directory. Watcher and workers need access to the same files, with compatible user permissions. The worker's mount path can differ; set `FLEXO_EVIDENCE_DIRECTORY` to its path. Do not use an expiring workspace, CI cache or ordinary job artifacts as the only copy.

Records are partitioned by a digest of the reviewed CI destination, then by work identity:

```text
EVIDENCE_DIRECTORY/DESTINATION_SHA256/
  input/WORK_ID.json
  claim/WORK_ID.json
  result/WORK_ID.json
```

The input holds the exact file inventory and bytes, request and bundle digest. A worker verifies its destination and supplied identities before executing. Claims and completed results use create-only atomic hard links, with file and directory `fsync`. Abandoned temporary files are not claims. This requires a filesystem with reliable POSIX atomic-link and durability behavior; object-store mounts are not assumed compatible. Records are bounded and cannot be replaced by this implementation.

Before a worker claims work, delivery can be retried after at least 60 seconds, up to three attempts. A claim remains authoritative across lost dispatch responses and retries.

Only the claim winner runs the checker. Duplicates, including job retries, return the existing owner and skip execution. Each engine has a separate computation identity and claim. A claimed worker that terminates without a result becomes an execution error/inconclusive result when its native job finishes, and is not automatically run again.

Reconciliation reads retained evidence, checks unchanged input bytes, decodes the native engine/SHACL report again and verifies its verdict. It also inspects the exact GitLab job or Jenkins build, matching model/work parameters and completion status. CI success alone is insufficient. Results retain their native job URL, while the complete reports remain in the shared directory independently of CI log/artifact retention.

## Configuration

Use [gitlab-jenkins-validation.json](../examples/configuration/gitlab-jenkins-validation.json). Each action selects a checker independently of its target. Text actions select `engine: opensysml` or `sysml-toolkit` with `profile: syntax-semantic-v1`; two actions select both. A SHACL action instead supplies its rule and rule version.

A Jenkins validation target adds shared storage to the usual endpoint/job/credential-variable selection:

```json
{
  "type": "jenkins",
  "endpoint": "https://jenkins.example",
  "job": "adapter-validate",
  "username_env": "JENKINS_USERNAME",
  "token_env": "JENKINS_TOKEN",
  "evidence_directory": "./retained-validation"
}
```

A GitLab validation target uses the trigger and read credential variable names:

```json
{
  "type": "gitlab",
  "endpoint": "https://gitlab.com",
  "project": "GROUP/PROJECT",
  "ref": "main",
  "trigger_token_env": "GITLAB_TRIGGER_TOKEN",
  "read_token_env": "GITLAB_READ_TOKEN",
  "evidence_directory": "./retained-validation"
}
```

Relative paths resolve from the configuration file. Evidence storage cannot overlap the watcher state, configuration, feed or rule inputs. Current configuration changes apply to future observations; queued actions keep their original destination, store path and checker profile. Credentials stay in the approved environment workflow, not retained records.

## Reviewed worker job

Provision matching source, locked production dependencies, Node 24.16.0, Docker and the pinned engine profiles on each self-hosted worker. The watcher requires neither engine binaries nor Docker. The shared worker entrypoint is:

```sh
node src-ts/ci-validation-job.ts
```

Set non-secret `FLEXO_EVIDENCE_DIRECTORY` and, for text checks, `FLEXO_ENGINE_DIRECTORY`. Provision engines using [install-engines.ts](../scripts/install-engines.ts). `FLEXO_INSTALL_ENGINES=1` enables reviewed provisioning inside text jobs; otherwise missing binaries/libraries yield a non-passing installation result. The source/runtime identity must match queued work.

Jobs accept these four string parameters/variables:

- `ADAPTER_WORK_ID`
- `ADAPTER_INPUT_DIGEST`
- `ADAPTER_STORE_SCOPE`
- `ADAPTER_SOURCE_REVISION`

Do not interpolate them into shell source. The entrypoint checks them against the retained bundle. Native CI identity comes from the job environment and is checked again through platform APIs during reconciliation. No Flexo credential is supplied to a worker. Engine processes run in bounded, offline containers with clean environments, excluding platform tokens.

GitLab's reviewed job is named `adapter-validate`; it accepts only trigger pipelines on the selected branch. The example [pipeline](../examples/gitlab/verified-validation.yml) targets the `flexo-validation-local` runner tag and disables checkout because the trusted worker source is preinstalled. Use a dedicated project-locked, protected runner and protected branch. The watcher needs trigger permission plus read access to pipeline variables and exact job metadata. Retrying a GitLab job creates a new job identity; it cannot replace the original claim owner.

For Jenkins, install a reviewed job that invokes the entrypoint on a dedicated agent with the four parameters. `JOB_NAME`, `BUILD_NUMBER` and `JENKINS_URL` bind the claim to the configured job/build; the API supplies queue identity and verified parameters. The supplied [local job setup](../dev/native-ci/jenkins-validation.groovy) preserves the separate generic smoke job. No extra Jenkins plugins are required.

For Docker-outside-Docker workers, engine paths and temporary input paths must exist at the same absolute host/container paths visible to the Docker daemon. The local helper mirrors these paths and passes the local Unix socket explicitly. Workers need permission to launch engine containers; this setup is for dedicated, reviewed jobs.

## Local workers

The optional [development worker image](../dev/native-ci/Dockerfile) pins Node, Jenkins/Remoting, GitLab Runner and Docker CLI images. It installs only the existing locked production dependencies. It is separate from the lightweight watcher image.

```sh
node scripts/local-jenkins.ts up
node scripts/install-engines.ts --directory .local/native-validation/engines
docker build -f dev/native-ci/Dockerfile -t flexo-native-ci:local .
# Load the approved project API token through the existing environment helper.
node scripts/local-native-ci.ts up --engines .local/native-validation/engines
node scripts/local-native-ci.ts status
```

The helper is scoped to the existing local Jenkins service and `e4rohan/test-project`. It creates a dedicated Jenkins agent/job and a project-locked protected GitLab runner. It does not commit pipeline files. Installing the reviewed GitLab pipeline is a separate approved commit. The helper passes the generated Jenkins agent credential through a RAM-backed FIFO and stores the generated GitLab runner credential only on container tmpfs. It creates no 1Password items and never writes resolved project tokens to host files.

Stopping workers removes their containers and revokes the helper-created GitLab runner registration, retaining evidence and native build history:

```sh
node scripts/local-native-ci.ts down
```

`down` needs the approved GitLab API credential to revoke registration. The Jenkins controller has its own `local-jenkins.ts down` lifecycle. Restarting workers does not authorize re-executing previously claimed crashed work.

## Verification

See [native runner acceptance](native-runner-acceptance.md) for actual installation-specific results. Regression tests cover both targets/checker kinds, input/owner tampering, lost responses, restart recovery, crashed workers and credential failures. Hosted GitLab runners without shared storage are outside this provider's scope.

Platform references: [GitLab jobs API](https://docs.gitlab.com/api/jobs/), [pipelines API](https://docs.gitlab.com/api/pipelines/), [runner creation](https://docs.gitlab.com/tutorials/automate_runner_creation/) and [Jenkins remote API](https://www.jenkins.io/doc/book/using/remote-access-api/).
