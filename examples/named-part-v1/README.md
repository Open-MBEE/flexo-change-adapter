# Named-part integration fixtures, v1

This synthetic RDF model and SHACL rule require the fixed demonstration part to
have exactly one non-empty string name. Explicit targeting makes a missing part
fail rather than pass because no instances were found.

`invalid.ttl` lacks the name; `corrected.ttl` adds it. The expected SHACL outcomes
are nonconformance and conformance, respectively. These are integration fixtures,
not a general SysML conformance rule or human-validated research case. Their file
digests are pinned when a validation request is prepared.

The [GitHub configuration example](../configuration/github-validation.json) uses
this rule. Its source must contain the targeted demonstration element; use a
reviewed model-specific rule for other data. See the
[examples guide](../README.md#2-validate-with-github-actions) for setup and the
[project status](../../docs/status.md) for verification limits. A second example provides a
[satellite mass-budget rule](../satellite-mass-budget-v1/README.md).
