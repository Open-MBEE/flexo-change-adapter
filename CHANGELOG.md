# Changelog

## 0.1.0-alpha.1 — 2026-10-16

Initial alpha release.

- Versioned JSON configuration selects a Flexo repository/branch, SQLite state, an optional JSON feed and independent downstream actions.
- GitHub Actions validates pinned model/rule snapshots with SHACL, durable worker claims and retained results/reports in a private execution repository.
- GitLab and Jenkins trigger reviewed jobs with exact source/event metadata and reconcile native outcomes.
- State persists across restart; transactions retain events, frozen action intents and checkpoints together. Uncertain generic submissions are reconciled without automatic redelivery.
- Adapter and validation modules load only when needed. Local Jenkins setup, synthetic examples and regression tests are included.

This is a source release, not an npm publication or a production deployment. Configuration, CLI and storage contracts may change before 1.0. Generic CI success does not establish model conformance.
