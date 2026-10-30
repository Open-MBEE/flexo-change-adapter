# Branching and maintainers

We use [Git Flow](https://nvie.com/posts/a-successful-git-branching-model/) with `main` as the release branch and `develop` as the integration branch. Jason Han ([@HuiJun](https://github.com/HuiJun)) and Rohan ([@rororowyourboat](https://github.com/rororowyourboat)) are the maintainers. They review contributions, coordinate releases and maintain repository settings.

## Branches and pull requests

| Branch                        | Start from                | Merge into                       | Purpose                                                 |
| ----------------------------- | ------------------------- | -------------------------------- | ------------------------------------------------------- |
| `main`                        | Existing release history  | —                                | Released code; tag releases here                        |
| `develop`                     | `main` when first created | Via a `release/*` branch         | Integrate work for the next release                     |
| `feature/<short-description>` | `develop`                 | `develop`                        | Features, ordinary fixes, documentation and maintenance |
| `release/<version>`           | `develop`                 | `main`, then back into `develop` | Stabilization, version updates and release notes        |
| `hotfix/<short-description>`  | `main`                    | `main`, then back into `develop` | Urgent fixes to released code                           |

Use versions without the tag prefix in release branch names, such as `release/0.1.0-alpha.2`; release tags include `v` as described in [releasing](releasing.md).

1. Create a feature branch from the latest `develop` and keep the change focused.
2. Open a PR against `develop`, describe the resulting behavior and report checks actually run. Follow the [contribution guide](../CONTRIBUTING.md).
3. Obtain approval from at least one maintainer other than the author and pass CI before merging.
4. For a release, branch from `develop`, limit changes to stabilization and release preparation, and merge into `main` through a reviewed PR. Tag the resulting `main` commit after CI passes.
5. Merge the released changes back into `develop` through a PR. Apply hotfixes to an active release branch as well, if one exists, so the next release retains the fix.
6. Delete short-lived branches after their changes reach all required destinations. Keep `main` and `develop`.

Use merge commits for release/hotfix merges and merges back into `develop` to preserve shared ancestry. Repository settings must allow merge commits. Git Flow does not require installing a Git extension; use ordinary Git branches and GitHub PRs. Do not use a local finish command that pushes directly to `main`.

## Branch protection

Protect `main` in GitHub with the following policy:

- Require a pull request before merging, with at least one approving review and required code owner approval.
- Dismiss stale approvals when new changes are pushed and require review conversations to be resolved.
- Require the `test` check from the `CI` workflow and require the branch to be up to date before merging.
- Apply the requirements to administrators as well; do not permit bypasses, force pushes or branch deletion.
- Leave linear history enforcement disabled so Git Flow merge commits are allowed.

Use the same protections on `develop` to keep integration changes reviewed and verified. Feature PRs target `develop`; release and hotfix PRs target `main`. Branch protection does not itself enforce these source-branch conventions, so maintainers check them during review. The ordinary CI workflow runs for PRs and pushes to `main` and `develop`. The private model-validation workflow remains manually dispatched from reviewed `main` code.

[CODEOWNERS](../.github/CODEOWNERS) assigns both maintainers to every path, including the ownership file itself. Both accounts need repository write access. Keep the file on both PR base branches, `main` and `develop`. One eligible maintainer's approval satisfies the code owner requirement; both approvals are not required. See GitHub's [code owner documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) and [branch protection documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

These are the required settings, not a claim that protection is already enabled. Repository files do not enable GitHub branch protection or grant write access. An administrator must configure and verify the settings separately. During adoption, create `develop` from the reviewed `main` commit containing this policy and CODEOWNERS, then configure protection for both branches.
