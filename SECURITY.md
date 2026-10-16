# Security

## Report a vulnerability privately

Contact maintainer [rororowyourboat](https://github.com/rororowyourboat) directly at [rohan@dynamicalsystemsgroup.com](mailto:rohan@dynamicalsystemsgroup.com). Please use this private route for suspected credential exposure, unauthorized model access or other vulnerabilities.

Include the affected source revision and Node version, the relevant configuration or component, reproduction steps and the potential impact. Sanitize examples and logs: do not send working credentials, private model graphs or unrelated personal information. Describe sensitive evidence first so the maintainer can arrange an appropriate way to receive it.

The project has not published a supported-version matrix or response-time commitment. See [current status](docs/status.md) for implementation and verification limits.

## Data and trust boundaries

- The adapter reads a configured Flexo source and retains events, action intents and validation state locally. Protect the SQLite databases, spool, configuration and backups according to the model's sensitivity.
- GitHub validation sends verified model and rule snapshots to the configured private GitHub repository. Private input, worker-claim and result Git records are retained separately from expiring workflow artifacts. Review [execution and retention limits](docs/github-execution.md) before transferring data.
- Generic GitLab and Jenkins triggers send event and exact revision metadata. Their destination jobs are responsible for any model retrieval and validation they perform.
- Credentials are loaded through environment variables rather than stored in JSON configuration or retained action records. Review the [configuration guide](docs/configuration.md) for the variable names and destination requirements. Restrict access to the adapter process and its environment.
- CI workflows and destinations must be reviewed independently of source observation. Keep infrastructure credentials separate from arbitrary pull-request execution; running the adapter does not authorize deployment or make private Flexo services public.

Use an existing commit-pinned Flexo lock unless creation has been explicitly authorized. The configured GitHub action also requires `allow_lock_creation: true` before it can create one. Review destination permissions, retained data and recovery behavior before operating a continuous watcher.
