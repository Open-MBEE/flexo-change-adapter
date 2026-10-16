set shell := ["bash", "-euo", "pipefail", "-c"]

# Show available commands.
default:
    @just --list

# Install locked dependencies with the machine's existing npm policy.
install:
    npm ci

# Run type checking, tests, and formatting checks.
check:
    npm run check
    npm test
    npm run format:check

# Build the runtime image without publishing it.
docker-build:
    docker compose -f compose.configured.yaml build adapter

# Check the JSON configuration mounted in the container, offline.
docker-config-check:
    docker compose -f compose.configured.yaml run --rm --no-deps adapter check --config /configuration/adapter.json

# Perform one configured observation and delivery round.
docker-once:
    docker compose -f compose.configured.yaml run --rm --no-deps adapter run --config /configuration/adapter.json --once

# Run configured observation and delivery in the foreground.
docker-run:
    docker compose -f compose.configured.yaml run --rm --no-deps adapter

# Stop the configured container, preserving its named state volume.
docker-down:
    docker compose -f compose.configured.yaml down

# Inspect retained container state without network access.
docker-status:
    docker compose -f compose.configured.yaml run --rm --no-deps adapter status --config /configuration/adapter.json

# Validate a versioned JSON configuration offline.
configured-check config:
    node src-ts/cli.ts check --config {{quote(config)}}

# Run one configured observation and delivery round.
configured-once config:
    node src-ts/cli.ts run --config {{quote(config)}} --once

# Run the configuration-driven observer and independent actions.
configured-run config:
    node src-ts/cli.ts run --config {{quote(config)}}

# Inspect retained events and action delivery progress, without network calls.
configured-status config:
    node src-ts/cli.ts status --config {{quote(config)}}

# Check the configuration-driven Compose file without printing credentials.
configured-compose-check:
    docker compose -f compose.configured.yaml config --quiet

# Start the dedicated local Jenkins integration-test service.
jenkins-local-up:
    node scripts/local-jenkins.ts up

# Inspect authenticated local Jenkins readiness without printing credentials.
jenkins-local-status:
    node scripts/local-jenkins.ts status

# Exercise the adapter CLI against real local Jenkins with controlled source metadata.
jenkins-local-test:
    node scripts/test-local-jenkins.ts

# Run one configured adapter round with the local Jenkins API token loaded in memory.
jenkins-local-once config:
    node scripts/local-jenkins.ts run {{quote(config)}}

# Stop the local Jenkins test service, retaining its named state volume.
jenkins-local-down:
    node scripts/local-jenkins.ts down
