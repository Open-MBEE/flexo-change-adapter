# Engine implementation acceptance

Local verification on 16 October 2026 used the new `captureModelBundle`, registered engine profiles, `runEngineRecord` and evidence verifier against the existing isolated Flexo instance and pinned executable releases. It is separate from the earlier [manual CLI probes](engine-cli-verification-2026-10-16.md).

| Exact Flexo revision                   | OpenSysML 0.10.1 | Toolkit 0.10.2 |
| -------------------------------------- | ---------------- | -------------- |
| `739685fc-034c-4474-8ed4-d4a12d477e86` | pass             | pass           |
| `96025951-edff-42ec-a2c6-009fa36ed1ed` | pass             | pass           |

The implementation fetched each exact graph through a newly created named lock, checked the before/after commit and ETag, verified its original producer manifest/artifact hashes, and retained one shared text bundle. Reopening each bundle with source access deliberately unavailable returned the same retained contents. Both engines ran in the pinned, offline container and emitted clean syntax/semantic reports; the result verifier rechecked those native reports. Neither fixture has a mass-limit constraint, so changing mass from 350 to 550 does not imply different syntax/semantic verdicts.

The pinned provisioning script was also run into a fresh ignored directory. Archive hashes, binary hashes and the full Toolkit library inventory passed, and the pinned execution image was available. No global package installation or production dependency was added. This machine uses a rootless Docker Unix socket, passed explicitly through `DOCKER_HOST`.

Full local outputs and source bindings remain under ignored `.local/engine-input-spike/implementation-inputs/`, `implementation-runs/` and `implementation-acceptance.json`. The shared [manual CLI capture](engine-cli-captures-2026-10-16.json) retains the source fixture bytes, release identities and earlier negative probe outputs used by decoder regressions. Credentials were held in memory and excluded from evidence and engine containers.

Controlled GitHub transport tests exercise the complete configured action path, two engine actions sharing one capture, accepted-but-lost dispatch responses, restart after configuration removal and branch movement, retained results and claim deduplication. These are not hosted GitHub runs. Project gates, explicit constraint execution and live acceptance against a matching private GitHub execution repository remain outstanding. Existing GitLab/Jenkins adapters continue to send generic metadata only.

Validation completed with 55 passing native tests, TypeScript checking, formatting checks, offline checking of the two-engine example, 105 local documentation links, and four successful real worker runs.
