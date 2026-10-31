# Versioning and releases

This project uses `v`-prefixed SemVer tags. The package and lockfile carry the same version without `v`. The initial release is `v0.1.0-alpha.1`; alpha means the interfaces remain experimental.

The convention follows [OpenSysML's versioning guidance](https://github.com/Open-MBEE/OpenSysML/blob/main/CONTRIBUTING.md#versioning) and its [prerelease spellings](https://github.com/Open-MBEE/OpenSysML/blob/main/docs/project/releasing.md). OpenSysML permits `-alpha.N`, `-beta.N` and `-rc.N`; [Flexo releases](https://github.com/Open-MBEE/flexo-mms-layer1-service/releases) also distinguish prereleases from stable releases. These are project conventions, not an organization-wide mandatory release policy.

Before 1.0, increment the minor version for incompatible configuration, CLI, feed or retained-state contracts. Compatible fixes and additions use patch releases. From 1.0, use conventional SemVer: major for breaking changes, minor for compatible features and patch for fixes. Describe concrete behavior in release notes.

## Release procedure

Follow [Git Flow](branching.md). Jason and Rohan coordinate releases; release and hotfix changes reach `main` through reviewed pull requests under the branch protection policy.

1. Create `release/<version>` from `develop`, or `hotfix/<short-description>` from `main` for an urgent released-code fix. Update `package.json` and regenerate `package-lock.json` with npm. Keep the dependency graph unchanged unless separately reviewed.
2. Update the changelog and affected documentation. Run `npm run check`, `npm test` and `npm run format:check`; validate configuration examples, links and container behavior when affected.
3. Open a PR into `main`, obtain approval from a maintainer other than the author and pass required CI. Merge with a merge commit and require CI on the resulting `main` commit to pass.
4. Create and push an annotated tag matching the package version, such as `v0.1.0-alpha.1`. Never move an existing release tag.
5. Pushing the tag runs the [release workflow](../.github/workflows/release.yml), which checks that the tagged commit is on `main` and that the tag matches `package.json`, runs the gate, and publishes the GitHub Release with the packed tarball, an SPDX SBOM (`npm sbom`), `SHA256SUMS.txt` and a GitHub artifact attestation for every asset. A tag with a prerelease suffix is marked prerelease and not latest. Do not create the release by hand.
6. Merge the released changes back into `develop` through a reviewed PR, preserving merge ancestry. For a hotfix, also include the fix in any active release branch. Delete the short-lived branch once all required merges are complete.

Releases before `v0.2.0` consist only of source archives supplied by GitHub. `private: true` in `package.json` prevents accidental npm publication; it does not set GitHub repository visibility. There is no registry, container or infrastructure publication in this procedure. Public source publication does not make the private model-validation target public.

## Verifying a release

Every asset is attested by GitHub Actions (SLSA build provenance). Verify an asset with the GitHub CLI, which checks the signature and that the build ran from this repository's release workflow:

```bash
gh attestation verify openmbee-flexo-change-adapter-<version>.tgz --repo Open-MBEE/flexo-change-adapter
sha256sum -c SHA256SUMS.txt
```

Enable **Immutable releases** in the repository settings (Settings → General → Releases) so published assets and tags cannot be changed; the registry's release-integrity check reads that flag.
