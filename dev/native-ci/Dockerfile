FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS worker
WORKDIR /opt/flexo-worker
COPY package.json package-lock.json ./
RUN NPM_CONFIG_BEFORE="$(node -p 'new Date(Date.now() - 7 * 86400000).toISOString()')" npm ci --omit=dev
FROM gitlab/gitlab-runner:alpine-v19.5.0@sha256:b7dead3b57cd9e5e5d6aedc6c0736c43972af9a24aa19875c2802bc8afcd3978 AS runner
FROM docker:28.5.1-cli@sha256:9190b0613792e658a7783cf14b2d5ace5941bb68ede7276922ea36ee457d76ad AS dockercli
FROM jenkins/jenkins:2.580.1-jdk21@sha256:a660310e39ade10631f774bacd5219de767dfd08947ea5c32a739b5e5bb382c1
USER root
COPY --from=worker /usr/local/bin/node /usr/local/bin/node
COPY --from=worker /opt/flexo-worker/node_modules /opt/flexo-worker/node_modules
COPY --from=worker /opt/flexo-worker/package*.json /opt/flexo-worker/
COPY --from=runner /usr/bin/gitlab-runner /usr/local/bin/gitlab-runner
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY dev/native-ci/AgentLauncher.java /opt/AgentLauncher.java
RUN unzip -p /usr/share/jenkins/jenkins.war WEB-INF/lib/remoting-3386.v353e57a_1b_ea_0.jar > /opt/agent.jar
WORKDIR /work
ENTRYPOINT ["sleep", "infinity"]
