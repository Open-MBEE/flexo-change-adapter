# Configuration example notes

Use the [examples guide](../README.md) for the three end-to-end recipes. These
JSON files are templates, not working service credentials or a deployment.

| File                     | Replace before running                                                          | Credential environment variables                                                                  |
| ------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `feed.json`              | Flexo endpoint and source identifiers; writable state/feed paths                | `FLEXO_TOKEN`, or `FLEXO_PASSWORD` and explicit `FLEXO_USERNAME`                                  |
| `github-validation.json` | Flexo source, private GitHub destination, reviewed rule/version and local paths | Flexo variables and `GITHUB_TOKEN`                                                                |
| `gitlab-jenkins.json`    | Flexo source, GitLab endpoint/project/ref, Jenkins endpoint/job and local paths | Flexo variables, `GITLAB_TRIGGER_TOKEN`, `GITLAB_READ_TOKEN`, `JENKINS_USERNAME`, `JENKINS_TOKEN` |

All relative paths resolve against the JSON file's directory. For example,
`github-validation.json` uses `../named-part-v1/rule.ttl` from this directory.
Copying it to `.local/adapter.json` requires changing that path to
`../examples/named-part-v1/rule.ttl` and reviewing the state/feed paths too.
For a configuration saved under `.local/`, `state_directory: "./my-model"` and
feed path `"./my-model/output/activity.json"` keep its outputs together.

Use distinct state and output locations for separate sources. Changing a source
in an existing state directory is refused; it is not a way to reset or migrate
history. Changing an action affects future events; retained work keeps its
original destination, rule and credential variable names.

Never put secret values in JSON. Credential fields contain environment variable
names, and Compose must explicitly pass any custom names into the container.
Offline `check` does not resolve secrets, contact services or initialize state.
Review [configuration and recovery](../../docs/configuration.md) before running.
