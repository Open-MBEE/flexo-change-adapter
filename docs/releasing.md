# Versioning and releases

This project uses `v`-prefixed SemVer tags. The package and lockfile carry the same version without `v`. The initial release is `v0.1.0-alpha.1`; alpha means the interfaces remain experimental.

The convention follows [OpenSysML's versioning guidance](https://github.com/Open-MBEE/OpenSysML/blob/main/CONTRIBUTING.md#versioning) and its [prerelease spellings](https://github.com/Open-MBEE/OpenSysML/blob/main/docs/project/releasing.md). OpenSysML permits `-alpha.N`, `-beta.N` and `-rc.N`; [Flexo releases](https://github.com/Open-MBEE/flexo-mms-layer1-service/releases) also distinguish prereleases from stable releases. These are project conventions, not an organization-wide mandatory release policy.

Before 1.0, increment the minor version for incompatible configuration, CLI, feed or retained-state contracts. Compatible fixes and additions use patch releases. From 1.0, use conventional SemVer: major for breaking changes, minor for compatible features and patch for fixes. Describe concrete behavior in release notes.

## Release procedure

1. Update `package.json` and regenerate `package-lock.json` with npm. Keep the dependency graph unchanged unless separately reviewed.
2. Update the changelog and affected documentation. Run `npm run check`, `npm test` and `npm run format:check`; validate configuration examples, links and container behavior when affected.
3. Commit the reviewed change on `main` and require the CI workflow to pass.
4. Create and push an annotated tag matching the package version, such as `v0.1.0-alpha.1`. Never move an existing release tag.
5. Create the GitHub Release from that existing tag. Mark alpha/beta/rc releases as prerelease and do not mark them latest.

The current release consists of source archives supplied by GitHub. `private: true` in `package.json` prevents accidental npm publication; it does not set GitHub repository visibility. There is no registry, container or infrastructure publication in this procedure. Public source publication does not make the private model-validation target public.
