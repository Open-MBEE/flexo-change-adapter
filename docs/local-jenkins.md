# Local Jenkins adapter test

For full SHACL, OpenSysML and Toolkit validation, use the separate [dedicated worker setup](gitlab-jenkins-validation.md) and [live acceptance record](native-runner-acceptance.md). The smoke job below verifies generic metadata transport.

This is a dedicated local integration-test service, using Jenkins 2.580.1 with the official image pinned by digest. It runs one core Freestyle job, `adapter-smoke`, without additional plugins. The job checks the four adapter metadata parameters, waits briefly so queued/running states can be inspected, and completes. A synthetic revision ending `/commits/adapter-fail` deliberately fails. It does not deploy services or fetch model content.

## Start and inspect

Docker Compose, Node 24.16.0 and the existing installed adapter dependencies are required.

```bash
node scripts/local-jenkins.ts up
node scripts/local-jenkins.ts status
node scripts/test-local-jenkins.ts
```

Open <https://localhost:18443/job/adapter-smoke/>. The browser will warn about the self-signed local certificate. The adapter helper trusts that specific public certificate through `NODE_EXTRA_CA_CERTS`; TLS verification stays enabled. No system trust store is changed.

The port is bound to `127.0.0.1` only. Anonymous users can read this local test UI; triggering jobs requires authentication. There is no signup or interactive administrator login needed for the supplied test. The generated `adapter-local` account exists only in this service. It is not an organizational Jenkins credential.

The image is declared in [compose.jenkins-local.yaml](../compose.jenkins-local.yaml). `up` may download that pinned Docker image. The existing research VPS and other Docker projects are not part of this setup.

## Use your own adapter configuration

Select a Jenkins action with this target:

```json
{
  "type": "jenkins",
  "endpoint": "https://localhost:18443",
  "job": "adapter-smoke",
  "username_env": "JENKINS_USERNAME",
  "token_env": "JENKINS_TOKEN"
}
```

Then run one observation/reconciliation round:

```bash
node scripts/local-jenkins.ts run /absolute/path/to/adapter.json
npm run adapter -- status --config /absolute/path/to/adapter.json
```

Load real Flexo credentials through the existing approved environment helper before using a real source. The local Jenkins helper reads its generated API token directly from the container and passes it to the adapter in memory. It never prints the token, puts it in command arguments, or saves it in host configuration. Existing 1Password items are not created or edited. No Flexo credential is given to Jenkins.

The certificate private key, keystore password and API-token bootstrap file are kept on container tmpfs. Only the public certificate is copied to ignored `.local/jenkins-local/certificate.pem`. On service restart the certificate and API token rotate, and the helper refreshes its values. Job configuration/build history remain in the named `flexo-jenkins-local_jenkins-home` volume.

## Verification and stopping

`test-local-jenkins.ts` runs the public adapter CLI against **real local Jenkins** and controlled Flexo metadata. It checks native success/failure, exact delivery/revision parameters, missing-job rejection, lost-response reconciliation after process restart, and no extra build on unchanged observations. It retains non-secret evidence under `.local/jenkins-local/check-*/`. This is CI transport verification, not SHACL or SysML conformance.

```bash
node scripts/local-jenkins.ts down
```

Stopping removes this project's container/network and retains its named state volume. No automatic restart policy is installed. Do not use this test service as a production Jenkins deployment.

The setup follows Jenkins' official [Docker installation](https://www.jenkins.io/doc/book/installing/docker/), [HTTPS startup parameters](https://www.jenkins.io/doc/book/installing/initial-settings/), [initialization hooks](https://www.jenkins.io/doc/book/managing/groovy-hook-scripts/), and [API token interface](https://javadoc.jenkins.io/jenkins/security/ApiTokenProperty.html).
