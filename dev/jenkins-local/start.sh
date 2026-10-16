#!/usr/bin/env bash
set -euo pipefail
umask 077
# TLS keys and bootstrap tokens live only in this container's tmpfs.
export LOCAL_TLS_PASSWORD
LOCAL_TLS_PASSWORD="$(head -c 32 /dev/urandom | base64)"
keytool -genkeypair -alias localhost -keyalg RSA -keysize 2048 \
  -validity 7 -storetype PKCS12 -keystore /run/local-jenkins/https.p12 \
  -storepass:env LOCAL_TLS_PASSWORD -keypass:env LOCAL_TLS_PASSWORD \
  -dname 'CN=localhost, OU=Adapter local test, O=DSG, C=IN' \
  -ext 'SAN=dns:localhost,dns:jenkins,ip:127.0.0.1' >/dev/null 2>&1
keytool -exportcert -rfc -alias localhost \
  -keystore /run/local-jenkins/https.p12 -storepass:env LOCAL_TLS_PASSWORD \
  -file /run/local-jenkins/certificate.pem >/dev/null 2>&1
export JAVA_OPTS='-Xms256m -Xmx1024m -Djenkins.install.runSetupWizard=false -Dhudson.DNSMultiCast.disabled=true'
# Keep the keystore password out of process arguments and Docker configuration.
printf '%s\n' "--httpPort=-1 --httpsPort=8443 --httpsKeyStore=/run/local-jenkins/https.p12 --httpsKeyStorePassword=${LOCAL_TLS_PASSWORD}" |
  /usr/local/bin/jenkins.sh --paramsFromStdIn
