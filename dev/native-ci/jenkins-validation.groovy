import jenkins.model.Jenkins
import hudson.model.*
import hudson.slaves.*
import hudson.tasks.Shell
import groovy.json.JsonOutput

def instance=Jenkins.get()
def old=instance.getNode('flexo-validation-local')
if(old!=null)instance.removeNode(old)
def name='flexo-validation-local-v2'
def agent=instance.getNode(name)
if(agent==null){
  agent=new DumbSlave(name,'/work',new JNLPLauncher())
  agent.setNumExecutors(1)
  agent.setMode(Node.Mode.EXCLUSIVE)
  agent.setLabelString('flexo-validation-local')
  instance.addNode(agent)
}
def job=instance.getItem('adapter-validate')
if(job==null)job=instance.createProject(FreeStyleProject.class,'adapter-validate')
job.setDescription('Reviewed local validation worker. Claims exact immutable input and retains reports in shared durable storage. No Flexo or GitLab credentials.')
job.setAssignedLabel(instance.getLabel('flexo-validation-local'))
job.setQuietPeriod(0)
job.setConcurrentBuild(true)
job.removeProperty(ParametersDefinitionProperty.class)
job.addProperty(new ParametersDefinitionProperty([
 new StringParameterDefinition('ADAPTER_WORK_ID','','Validation computation SHA-256'),
 new StringParameterDefinition('ADAPTER_INPUT_DIGEST','','Retained input bundle SHA-256'),
 new StringParameterDefinition('ADAPTER_STORE_SCOPE','','Reviewed destination scope SHA-256'),
 new StringParameterDefinition('ADAPTER_SOURCE_REVISION','','Exact Flexo commit URI')
]))
job.getBuildersList().clear()
job.getBuildersList().add(new Shell('''#!/bin/sh
set -eu
cd /opt/flexo-worker
exec node src-ts/ci-validation-job.ts
'''))
job.save()
instance.save()
// Returned only to the local setup process; do not log or retain this response.
println(JsonOutput.toJson([secret:agent.toComputer().getJnlpMac()]))
