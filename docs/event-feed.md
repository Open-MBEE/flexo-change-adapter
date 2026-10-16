# Event-only branch observation

Use this mode to demonstrate that a change to a Flexo branch can produce a retained event for another application. It reuses the existing authenticated, repository-bound Flexo branch reader. It does not queue validation work, retrieve model graphs, create locks or dispatch GitHub Actions.

Copy [feed.json](../examples/configuration/feed.json) to an ignored local configuration and edit its Flexo source, state directory and feed path. Keep `actions: []`; no rule or CI credentials are required. All paths resolve relative to the JSON file.

```bash
npm run adapter -- check --config .local/adapter.json
# Load approved Flexo credentials in memory through your secret helper.
npm run adapter -- run --config .local/adapter.json --once
npm run adapter -- status --config .local/adapter.json
npm run adapter -- run --config .local/adapter.json
```

`run --once` performs one read and publication. Linux `flock` permits one writer per database/state/feed location, including single rounds. Keep database and feed paths distinct and use a dedicated output directory. State belongs to one source branch. Feed-only operation loads RDF parsing for branch metadata but does not load GitHub validation, the SHACL/SPARQL engine or graph canonicalization.

SQLite retains the full history. The JSON feed contains the newest 100 events, branch identity, latest commit, interval, checked-at/last-success times and `ok`/`error` status. Each event has a SHA-256 identity, monotonically increasing sequence, `baseline`/`branch-change` kind, previous/current commit URI and observation time. An unchanged head produces no new event; A → B → A produces two changes. The first read is a baseline, not proof of a change.

Publishing atomically replaces the feed after every poll. Downstream services should read it dynamically and mount its directory read-only, rather than bind-mounting the file inode. Failed reads preserve history and last successful read time while publishing an error status. A process interruption after recording an event is recovered by the next publication from SQLite; no new Flexo write or engine run occurs.

Polling samples observed heads and can miss intermediate commits. Event timestamps record when the adapter read the branch, not when Flexo committed it. Errors use fixed messages and never expose raw credential/transport data. Event observation does not establish model validation, accepted research findings or contributor attribution.
