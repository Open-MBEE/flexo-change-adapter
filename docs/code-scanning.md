# Code scanning

The [CodeQL workflow](../.github/workflows/codeql.yml) provides an explicit advanced setup for pull requests into `develop` and `main`, including Dependabot PRs. It also scans pushes to those branches, runs weekly on the default branch and supports manual dispatch. GitHub's default setup previously left Dependabot PRs with neutral checks reporting missing configurations; a successful ordinary CI job did not establish that code scanning ran.

## Scope and permissions

The workflow analyzes GitHub Actions, JavaScript/TypeScript and Java, preserving the language coverage of the previous default setup. Java covers the development worker's [agent launcher](../dev/native-ci/AgentLauncher.java). Every language uses `build-mode: none`; scanning does not install npm dependencies, execute project build scripts or run the application. Queries use CodeQL's default suite.

Actions are pinned to full commit SHAs and tracked by Dependabot. The job receives repository contents read access and security events write access to upload findings, using the built-in GitHub Actions token. Checkout does not persist Git credentials. No infrastructure credentials, private models or validation jobs are involved. The workflow uses `pull_request`, including for Dependabot; it does not use `pull_request_target`.

## Switch from default setup

GitHub rejects advanced CodeQL uploads while default setup is enabled. Adding the workflow file alone does not complete the migration. A repository administrator coordinates the switch:

1. Prepare the workflow PR against `develop` and validate its syntax, immutable action pins, permissions and triggers.
2. When the workflow is ready to run, open repository **Settings → Advanced Security → CodeQL analysis**, choose **Switch to advanced**, and disable default setup. The equivalent API operation sets `state` to `not-configured` on the repository's `code-scanning/default-setup` endpoint.
3. Run or rerun the workflow on the PR. Verify that all three `Analyze (...)` jobs complete and upload results. A neutral `CodeQL` summary or a passing `test` job is insufficient evidence.
4. Obtain the required independent maintainer approval and merge the PR into `develop`. Confirm that its push creates successful baseline analyses for all three languages. The advanced workflow does not cover later protected-branch changes until its PR is merged; coordinate the cutover and review accordingly.
5. Update the approved dependency PR branches from `develop` so they include the workflow, then verify their own PR analyses before merging them one at a time. Carry the workflow to `main` through the release process and verify that branch's baseline as well.

Do not bypass branch protection during this migration. If the advanced setup cannot be made operational, restore the previous default setup until the workflow is corrected; default and advanced CodeQL uploads cannot run together.

See GitHub's [advanced setup instructions](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/configure-code-scanning/configuring-advanced-setup-for-code-scanning) and [workflow permissions](https://github.com/github/codeql-action#workflow-permissions).

## Verify coverage

In **Actions → CodeQL**, inspect the run for the exact PR head or resulting branch commit. Confirm successful analysis and upload for `actions`, `javascript-typescript` and `java-kotlin`. In **Security → Code scanning**, inspect the corresponding configurations and findings. A successful upload confirms that scanning ran; it does not mean there are no findings.

Branch protection separately requires the `test` job from ordinary CI and code owner approval. Requiring CodeQL checks or blocking merges on finding severity is a separate repository policy decision. Keep [branch protection](branching.md#branch-protection) and code scanning configuration distinct from the private [model-validation workflow](github-execution.md).
