# CLI reference

The `little-durable-objects` CLI starts actors, runs TypeScript clients, and issues local credentials. For a complete example, see the [terminal chat tutorial](../../README.md#build-a-chat-room-in-your-terminal). For application code, see the [API reference](api.md).

This reference describes the CLI in this checkout. These commands are not included in the published npm package at version `0.1.24`; use a local checkout until a release includes them.

## Contents

- [Use a local checkout](#use-a-local-checkout)
- [Installation and runtime downloads](#installation-and-runtime-downloads)
- [Command summary](#command-summary)
- [`dev`](#dev)
- [`run`](#run)
- [`token`](#token)
- [`start`](#start)
- [Environment variables](#environment-variables)
- [Output and exit codes](#output-and-exit-codes)
- [Troubleshooting](#troubleshooting)

## Use a local checkout

Requires Node.js 20+, pnpm, and Rust 1.89+. From the repository root, install dependencies and build the SDK and local runtime:

```sh
pnpm install
pnpm --dir npm build
cargo build --locked
```

In a separate demo directory:

```sh
mkdir chat-example
cd chat-example
npm init -y
npm pkg set type=module
npm link /absolute/path/to/little-durable-objects/npm
mkdir src
```

Link the repository's `npm/` directory, which contains the package and CLI. The repository root is a private workspace, not the installable SDK. `npm link` creates a local package link; it does not publish anything.

Create the actor and client files from the [chat tutorial](../../README.md#build-a-chat-room-in-your-terminal), then start the server from the demo directory:

```sh
DURABLE_OBJECT_BINARY=/absolute/path/to/little-durable-objects/target/debug/little-durable-objects \
  npx --no-install little-durable-objects dev
```

The binary override is needed for `dev`: linking the JavaScript package alone does not select a locally built runtime. `--no-install` keeps `npx` from installing a package if the link is missing.

After the ready message, open two more terminals in the demo directory. Run one command per terminal:

```sh
npx --no-install little-durable-objects run src/chat.ts Alice
```

```sh
npx --no-install little-durable-objects run src/chat.ts Bob
```

`run` and `token` use the running server, so they do not need `DURABLE_OBJECT_BINARY`. Rebuild with `pnpm --dir npm build` after SDK or CLI changes, and with `cargo build --locked` after runtime changes. Restart `dev` after actor changes. The link continues to use the rebuilt package.

## Installation and runtime downloads

For a release that includes the CLI:

```sh
npm install little-durable-objects
npx little-durable-objects --help
```

The package includes the SDK, CLI, and TypeScript execution support. `dev` and `start` download a native runtime matching the installed package version when it is not already cached. Downloads are verified against the release's SHA-256 checksum. `run`, `token`, and help do not download a runtime.

Prebuilt platforms are macOS and Linux on ARM64 and x64. Linux requires glibc 2.35+ and OpenSSL 3, such as Ubuntu 22.04+. Use WSL 2 on Windows. Building from source requires the build tools listed above; a prebuilt release does not require Rust.

The default cache is `~/.cache/little-durable-objects/<version>/<platform>-<arch>/`. Override its root with `DURABLE_OBJECT_CACHE_DIR`, or bypass downloading with `DURABLE_OBJECT_BINARY`.

## Command summary

```text
little-durable-objects [options] [command]
```

| Command                            | Purpose                                                   |
| ---------------------------------- | --------------------------------------------------------- |
| `dev [options]`                    | Start a local server and register the project's actors.   |
| `run [options] <script> [args...]` | Run a client using a running local server's credentials.  |
| `token [options]`                  | Print a local session token.                              |
| `start`                            | Start the server using self-hosting environment settings. |

| Global option     | Behavior                                    |
| ----------------- | ------------------------------------------- |
| `-h`, `--help`    | Print help. Also available on each command. |
| `-V`, `--version` | Print the npm package version.              |

Invoking the npm CLI without a command prints help. Use `dev --help`, `run --help`, `token --help`, or `start --help` for command help. There is no separate `help` command in the npm CLI.

The native executable supports `dev`, `--help`, and `--version`; `run`, `token`, and `start` are npm CLI commands. Use the npm CLI for the commands in this reference.

## `dev`

```text
little-durable-objects dev [options]
```

Starts a server on IPv4 loopback, loads the actor entrypoint, and registers it in the `local` namespace. Keep the command running while using clients. Wait for:

```text
Local actors ready at http://127.0.0.1:7100
```

| Option                   | Default                             | Behavior                                                                                                                |
| ------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `--project <directory>`  | `.`                                 | Project containing the actor code and installed SDK.                                                                    |
| `--port <number>`        | `7100`                              | Integer from `0` through `65535`. `0` selects an available port.                                                        |
| `--entrypoint <file>`    | `src/durable-objects.ts`            | Actor file relative to the project. It must exist before startup.                                                       |
| `--data-dir <directory>` | `<project>/.little-durable-objects` | Persistent local state and connection settings. An explicit relative path is relative to the shell's working directory. |
| `--storage <backend>`    | `local`                             | `local` saves snapshots on disk; `gcs` saves snapshots in configured GCS buckets.                                       |
| `-h`, `--help`           | —                                   | Print command help.                                                                                                     |

```sh
npx little-durable-objects dev --project ./chat-example --port 7200
npx little-durable-objects dev --entrypoint src/actors.ts --data-dir ./chat-state
npx little-durable-objects dev --port 0
```

The printed origin includes the selected port. `run` and `token` read it automatically, including when `--port 0` is used.

### State and restarts

With `--storage local`, the state directory holds both local metadata and saved actor state. Keep the whole directory to preserve actors across restarts. Only one `dev` process can use a data directory at a time; separate projects can run with different data directories and ports.

Connection settings in the directory are refreshed at startup. Local credentials change when the server restarts, so rerun clients and regenerate any manually copied tokens. Stop with Ctrl-C. Code changes require restarting `dev`; there is no file watcher.

Local storage is intended for development. Deleting the directory or losing its machine loses the saved actors. A fresh data directory starts a fresh local environment.

### GCS snapshots

```sh
export DURABLE_OBJECT_STANDARD_BUCKETS='{"north-america-east":"my-actor-state-bucket"}'
export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
npx little-durable-objects dev --storage gcs --data-dir .gcs-demo
```

GCS mode uses Google Application Default Credentials and requires a nonempty region-to-bucket map. Bucket values are names without `gs://` or slashes. Local metadata still lives in the data directory; preserve it even when snapshots are in GCS.

Use a separate data directory when changing the storage backend or bucket map. Startup rejects a changed storage configuration for an existing directory. See [local execution with GCS](../guides/self-hosting.md#local-execution-with-gcs) for credentials and storage setup.

## `run`

```text
little-durable-objects run [options] <script> [args...]
```

Runs a TypeScript or JavaScript client in Node.js with credentials from a running `dev` server. The script path is relative to the current working directory. The CLI does not change directories or type-check the script.

| Argument or option       | Default                   | Behavior                                                                            |
| ------------------------ | ------------------------- | ----------------------------------------------------------------------------------- |
| `<script>`               | Required                  | Client file to execute.                                                             |
| `[args...]`              | None                      | Arguments passed to the client after its filename.                                  |
| `--data-dir <directory>` | `.little-durable-objects` | Directory belonging to the running local server, relative to the current directory. |
| `-h`, `--help`           | —                         | Print help when placed before the script.                                           |

Put CLI options **before** the script. Everything after the script belongs to the client, including flags named `--help` or `--data-dir`:

```sh
npx little-durable-objects run --data-dir ./chat-state src/chat.ts Alice
npx little-durable-objects run src/client.ts --room lobby --verbose
```

In the first example, `process.argv[2]` is `Alice`. In the second, the client's arguments start with `--room`.

`run` sets `DURABLE_OBJECT_TOKEN`, `DURABLE_OBJECT_NAMESPACE_ID`, and `DURABLE_OBJECT_CONTROL_PLANE_URL` for the child process. It removes inherited `DURABLE_OBJECT_API_KEY` and `DURABLE_OBJECT_SOCKET_GATEWAY_URL` from that process. Other environment variables are inherited. A token is requested for each invocation; it is not refreshed while the script runs.

Pass the same data directory used by `dev`. When running from a different directory, use an absolute `--data-dir` path. Hosted clients should use the [SDK environment variables](api.md#client-configuration) instead of this local command.

## `token`

```text
little-durable-objects token [options]
```

Requests a local session token and prints only the token plus a newline to standard output. The local server must be running.

| Option                   | Default                   | Behavior                                         |
| ------------------------ | ------------------------- | ------------------------------------------------ |
| `--data-dir <directory>` | `.little-durable-objects` | Directory belonging to the running local server. |
| `-h`, `--help`           | —                         | Print command help.                              |

```sh
TOKEN="$(npx little-durable-objects token --data-dir ./chat-state)"
```

The CLI requests a deadline one hour in the future. Token issuance adds up to 30 seconds of grace, subject to the server's lifetime cap. Use the token promptly and regenerate it after a local server restart. It permits application access throughout the `local` namespace; it is not an admin credential or a room-specific credential.

For a manual connection:

```sh
npx --yes wscat \
  -c ws://127.0.0.1:7100/v1/namespaces/local/actors/ChatRoom/lobby/websocket \
  -H "Authorization: Bearer $TOKEN" \
  -x '{"type":"initialize","metadata":{}}' \
  -w -1
```

Use the server's actual port. The [WebSocket reference](api.md#direct-websocket-connections) describes initialization and message formats.

## `start`

```text
little-durable-objects start
```

Starts the packaged server with self-hosting settings from the environment. It takes no positional arguments or command-specific options beyond `-h`/`--help`.

`start` does not initialize a local project, register a deployment, or supply development credentials. Configure the database, storage, authentication, and cloud provider first, then register actor code through the [deployment API](api.md#deployments). See the [self-hosting guide](../guides/self-hosting.md) for the full setup.

```sh
npx little-durable-objects start
```

The npm CLI defaults `DURABLE_OBJECT_PROCESS_ROLE` to `control_plane` for server commands. Leave it unset for this use.

## Environment variables

### CLI and local development

| Variable                          | Default                           | Use                                                                                                            |
| --------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `DURABLE_OBJECT_BINARY`           | Downloaded runtime                | Path to an existing native executable for `dev` or `start`; relative paths resolve from the current directory. |
| `DURABLE_OBJECT_CACHE_DIR`        | `~/.cache/little-durable-objects` | Runtime download cache root. Ignored when a binary override is set.                                            |
| `DURABLE_OBJECT_STANDARD_BUCKETS` | Required for GCS                  | JSON object mapping region names to bucket names.                                                              |
| `GOOGLE_APPLICATION_CREDENTIALS`  | Google ADC discovery              | Service-account credentials file when using GCS. An attached Google identity can also supply ADC.              |
| `RUST_LOG`                        | `info`                            | Runtime log filter, for example `warn` or `debug`.                                                             |

Plain `dev --storage local` needs no cloud credentials, bucket, database URL, or signing key. Local actor processes inherit ordinary application environment variables from the server process.

### Self-hosted server

These configure `start`. Required values must be nonempty.

| Variable                                | Default or requirement         | Meaning                                                                                                          |
| --------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `DURABLE_OBJECT_POSTGRES_URL`           | Required                       | PostgreSQL connection URL.                                                                                       |
| `DURABLE_OBJECT_STANDARD_BUCKETS`       | Required                       | Nonempty JSON region-to-bucket map. Region names contain 1–64 lowercase ASCII letters, digits, `.`, `_`, or `-`. |
| `DURABLE_OBJECT_API_KEY`                | Required                       | Admin bearer credential; no surrounding whitespace. Also authenticates outgoing WebSocket callbacks.             |
| `DURABLE_OBJECT_JWT_SIGNING_KEY`        | Required                       | Base64-encoded Ed25519 private key in PKCS#8 format.                                                             |
| `DURABLE_OBJECT_SANDBOX_PROVIDER`       | Required: `modal`              | Cloud execution provider.                                                                                        |
| `MODAL_TOKEN_ID`                        | Required                       | Modal token ID, without surrounding whitespace.                                                                  |
| `MODAL_TOKEN_SECRET`                    | Required                       | Modal token secret, without surrounding whitespace.                                                              |
| `DURABLE_OBJECT_CONTROL_PLANE_URL`      | Required                       | Reachable HTTP(S) server origin.                                                                                 |
| `DURABLE_OBJECT_CONTROL_PLANE_BIND`     | `127.0.0.1:7100`               | Listening IP address and port.                                                                                   |
| `DURABLE_OBJECT_JWT_KEY_ID`             | `primary`                      | Signing key identifier.                                                                                          |
| `DURABLE_OBJECT_JWT_ISSUER`             | `durable-object-control-plane` | Token issuer.                                                                                                    |
| `DURABLE_OBJECT_AUTHORITY_JWT_AUDIENCE` | `durable-object-authority`     | Audience for server authentication.                                                                              |
| `DURABLE_OBJECT_INVOKE_JWT_AUDIENCE`    | `durable-object-invoke`        | Audience for actor calls.                                                                                        |
| `DURABLE_OBJECT_JWT_MAX_TTL_SECONDS`    | `86400`                        | Positive maximum token lifetime; session tokens are additionally capped at 24 hours.                             |
| `DURABLE_OBJECT_ACTOR_IDLE_TIMEOUT_MS`  | `60000`                        | Idle time before an actor may hibernate. Valid range: 1–86400000.                                                |
| `DURABLE_OBJECT_HOST_IDLE_TIMEOUT_MS`   | `300000`                       | Idle time before an unused cloud host may stop. Valid range: 1–86400000.                                         |
| `DURABLE_OBJECT_SANDBOX_COMMAND`        | Bundled provider executable    | Override the cloud provider executable when supplying a custom runtime distribution.                             |
| `DURABLE_OBJECT_SOCKET_AUTH_URL`        | Disabled                       | HTTP(S) callback for authorizing external WebSocket connections.                                                 |
| `DURABLE_OBJECT_SOCKET_EVENT_URL`       | Disabled                       | HTTP(S) callback receiving successfully handled incoming WebSocket messages.                                     |

The callback contracts are in the [API reference](api.md#websocket-callbacks). Client configuration is separate: see [SDK environment variables](api.md#client-configuration).

## Output and exit codes

`dev` writes the ready origin, state directory, and runtime logs. `run` inherits standard input, output, and error, so interactive clients work normally. `token` writes its credential to stdout and errors to stderr. Help and version commands exit successfully.

The CLI reports setup and argument errors with a nonzero exit code, normally `1`. `run`, `dev`, and `start` forward the child process's numeric exit code. If the child exits by SIGINT, the CLI reports `130`; another terminating signal maps to `1`. Ctrl-C requests shutdown; it does not erase actor state.

## Troubleshooting

| Symptom                                     | Action                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| CLI is missing after linking                | Link the repository's `npm/` directory and run `pnpm --dir npm build` in the repository.             |
| Linked CLI tries to download a release      | Set `DURABLE_OBJECT_BINARY` on the `dev` or `start` command.                                         |
| Runtime download returns an HTTP error      | Confirm that the installed package version has matching native release assets, or use a local build. |
| Runtime checksum mismatch                   | Retry the download; do not use the rejected archive.                                                 |
| `No local runtime found`                    | Start `dev` and pass its data directory to `run` or `token`.                                         |
| `Cannot reach the local runtime`            | Restart `dev`, wait for the ready message, then rerun the client.                                    |
| Actor file is missing                       | Create the entrypoint before starting `dev`, or set `--entrypoint`.                                  |
| Port is unavailable                         | Set a different `--port`, or use `--port 0`.                                                         |
| Another runtime is using the data directory | Stop that runtime or choose a separate directory.                                                    |
| Storage configuration changed               | Use a separate `--data-dir` for the new backend or bucket map.                                       |
| Actor code changes do not appear            | Restart `dev`; rebuild the SDK as well if SDK code changed.                                          |
| Token stops working after a restart         | Run `token` again or restart the client through `run`.                                               |
| A client flag is interpreted by the CLI     | Place client flags after the script filename.                                                        |
