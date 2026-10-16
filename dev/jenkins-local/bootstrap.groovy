import jenkins.model.Jenkins
import jenkins.model.JenkinsLocationConfiguration
import jenkins.install.InstallState
import jenkins.security.ApiTokenProperty
import hudson.security.HudsonPrivateSecurityRealm
import hudson.security.FullControlOnceLoggedInAuthorizationStrategy
import hudson.model.FreeStyleProject
import hudson.model.ParametersDefinitionProperty
import hudson.model.StringParameterDefinition
import hudson.tasks.Shell
import java.nio.file.Files
import java.nio.file.Paths
import java.nio.file.attribute.PosixFilePermissions
import java.security.SecureRandom

// Disposable local CI account, generated here; never a shared infrastructure credential.
def instance = Jenkins.get()
def realm = new HudsonPrivateSecurityRealm(false)
byte[] bytes = new byte[32]
new SecureRandom().nextBytes(bytes)
def user = realm.createAccount('adapter-local', Base64.encoder.encodeToString(bytes))
instance.setSecurityRealm(realm)
def authorization = new FullControlOnceLoggedInAuthorizationStrategy()
authorization.setAllowAnonymousRead(true)
instance.setAuthorizationStrategy(authorization)
instance.setNumExecutors(1)
instance.setSystemMessage('Local adapter integration test. Anonymous read-only UI; builds require authentication. No production credentials or deployments.')
JenkinsLocationConfiguration.get().setUrl('https://localhost:18443/')
JenkinsLocationConfiguration.get().save()
def tokens = user.getProperty(ApiTokenProperty.class)
if (tokens == null) {
    tokens = new ApiTokenProperty()
    user.addProperty(tokens)
}
tokens.revokeAllTokens()
def token = tokens.generateNewToken('local-adapter-test')
user.save()
def tokenPath = Paths.get('/run/local-jenkins/api-token')
Files.writeString(tokenPath, token.plainValue)
Files.setPosixFilePermissions(tokenPath, PosixFilePermissions.fromString('rw-------'))

def job = instance.getItem('adapter-smoke')
if (job == null) job = instance.createProject(FreeStyleProject.class, 'adapter-smoke')
job.setDescription('Checks the four adapter metadata fields. A synthetic revision ending /adapter-fail deliberately fails. Does not fetch models or deploy anything.')
job.setQuietPeriod(0)
job.setConcurrentBuild(false)
job.removeProperty(ParametersDefinitionProperty.class)
job.addProperty(new ParametersDefinitionProperty([
    new StringParameterDefinition('ADAPTER_DELIVERY_ID', '', 'Durable adapter delivery identity'),
    new StringParameterDefinition('ADAPTER_EVENT_ID', '', 'Observed event identity'),
    new StringParameterDefinition('ADAPTER_SOURCE_REVISION', '', 'Exact model commit URI'),
    new StringParameterDefinition('ADAPTER_SOURCE_BRANCH', '', 'Observed branch URI')
]))
job.getBuildersList().clear()
job.getBuildersList().add(new Shell('''#!/bin/sh
set -eu
: "${ADAPTER_DELIVERY_ID:?}" "${ADAPTER_EVENT_ID:?}" "${ADAPTER_SOURCE_REVISION:?}" "${ADAPTER_SOURCE_BRANCH:?}"
printf 'delivery=%s\nevent=%s\nrevision=%s\nbranch=%s\n' "$ADAPTER_DELIVERY_ID" "$ADAPTER_EVENT_ID" "$ADAPTER_SOURCE_REVISION" "$ADAPTER_SOURCE_BRANCH"
sleep 15
case "$ADAPTER_SOURCE_REVISION" in
  */commits/adapter-fail) echo 'Deliberate integration-test failure'; exit 1 ;;
esac
echo 'Metadata check passed'
'''))
job.save()
instance.setInstallState(InstallState.INITIAL_SETUP_COMPLETED)
instance.save()
println('Local adapter job and API account ready; credential retained only in runtime tmpfs.')
