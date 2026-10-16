# Satellite mass-budget rule

This example targets a fixed demonstration Satellite element and checks one numeric `LiteralRational` initializer each for its directly owned `dryMass` and `maximumMass` attributes. It rejects missing or ambiguous declarations and requires `0 < dryMass <= maximumMass`.

The native tests construct synthetic RDF data: 350/500 passes, while 550/500, non-positive masses, missing targets/values and ambiguous declarations fail. The values must use the same agreed unit; this rule does not perform unit conversion.

The rule targets the demonstration element URI written in `rule.ttl`. Review and replace that target for your model, then pin the rule/version in configuration. It does not implement SysML expression evaluation, instance overrides, inherited values, aggregate component masses or full SysML conformance.
