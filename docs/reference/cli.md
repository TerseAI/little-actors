# Command Line Interface

The `little-actors` command starts actors and runs TypeScript clients. It is installed with the Node.js package. For a complete example, see the [chat tutorial](../../README.md#build-a-chat-room-in-your-terminal).

This reference describes npm version `0.1.27` and later. Follow [local development](../guides/local-development.md) to build and link a source checkout.

- [Find your actors](#find-your-actors)
- [Run the development server](#run-the-development-server)
- [Run a client](#run-a-client)
- [Start a hosted server](#start-a-hosted-server)
- [Environment variables](#environment-variables)
- [Runtime installation](#runtime-installation)
- [Issue a local token](#issue-a-local-token)
- [Help and version](#help-and-version)
- [Output and exit codes](#output-and-exit-codes)
- [Troubleshooting](#troubleshooting)

## Find your actors

The development server looks for `src/durable-objects.ts` in the current directory. The file must exist before startup and export named actor classes. See [actor definitions](api.md#actor) for class and export requirements.

Select a different project or actor file with `--project` and `--entrypoint`:

```sh
npx little-actors dev --project ./chat-example --entrypoint src/actors.ts
```

The entrypoint resolves relative to the project. In this example, the server loads `chat-example/src/actors.ts`. The project must have the SDK installed or linked.

## Run the development server

```sh
npx little-actors dev
```

Starts a server on IPv4 loopback, loads the actor entrypoint, and registers your actors. Keep it running while using clients. Wait for the ready message before connecting:

```text
Local actors ready at http://127.0.0.1:7100
```

Local mode needs no cloud credentials, database URL, bucket, or signing key. SQLite metadata and snapshots are saved in `.little-actors/` by default.

### dev options

```text
little-actors dev [options]
```

- `--project <directory>` — Project containing the actor code and installed SDK. Defaults to `.`.
- `--entrypoint <file>` — Actor file relative to the project. Defaults to `src/durable-objects.ts`.
- `--port <number>` — Loopback port, an integer from `0` through `65535`. Defaults to `7100`; `0` selects an available port.
- `--data-dir <directory>` — Persistent state and connection settings. Defaults to `<project>/.little-actors`. An explicit relative path resolves from the shell's working directory.
- `--storage <backend>` — Snapshot storage, either `local` (default) or `gcs`. Local metadata stays in the data directory for both backends.
- `-h`, `--help` — Print command help.

### Choose a port

```sh
npx little-actors dev --port 7200
```

Use `--port 0` to select an available port. The ready message prints the selected origin; `run` and `token` read it automatically from the data directory.

### Keep state across restarts

```sh
npx little-actors dev --data-dir ./chat-state
```

Keep the entire data directory to preserve actors across restarts. Only one `dev` process can use it at a time. Separate projects can run with different data directories and ports.

Stop with Ctrl-C. Actor code changes require restarting `dev`; there is no file watcher. Connection settings and local credentials are refreshed at startup, so rerun clients and regenerate manually copied tokens after restarting.

Local storage is intended for development. Deleting the directory or losing its machine loses the saved actors. A fresh directory starts a fresh local environment.

### Save snapshots in GCS

```sh
export DURABLE_OBJECT_STANDARD_BUCKETS='{"north-america-east":"my-actor-state-bucket"}'
export GOOGLE_APPLICATION_CREDENTIALS='/absolute/path/to/service-account.json'
npx little-actors dev --storage gcs --data-dir .gcs-demo
```

GCS mode uses Google Application Default Credentials and a nonempty region-to-bucket map. Bucket values are names without `gs://` or slashes. Local metadata still lives in the data directory and must be preserved.

Changing the storage backend or bucket map requires a separate data directory; startup rejects a changed configuration for an existing directory. See [local execution with GCS](../guides/self-hosting.md#local-execution-with-gcs) for storage and credential setup.

## Run a client

```sh
npx little-actors run src/chat.ts Alice
```

Runs a TypeScript or JavaScript client in Node.js using credentials from the running development server. The script path is relative to the current working directory. The CLI does not change directories or type-check the script.

### run arguments and options

```text
little-actors run [options] <script> [args...]
```

- `<script>` — Required client file to execute.
- `[args...]` — Arguments passed to the client after its filename. Defaults to no arguments.
- `--data-dir <directory>` — Directory belonging to the running local server. Defaults to `.little-actors`, relative to the current directory.
- `-h`, `--help` — Print command help when placed before the script.

Put CLI options **before** the script. Everything after its filename belongs to the client, including `--help` and `--data-dir`:

```sh
npx little-actors run --data-dir ./chat-state src/chat.ts Alice
npx little-actors run src/client.ts --room lobby --verbose
```

In the first example, `process.argv[2]` is `Alice`. In the second, the client's arguments start with `--room`.

### Connect to the right server

Use the same data directory as `dev`. When launching from another directory, pass an absolute `--data-dir` path. `run` reads the local API key and server URL without issuing a session token.

The child process receives `DURABLE_OBJECT_API_KEY` and `DURABLE_OBJECT_CONTROL_PLANE_URL`. Inherited `DURABLE_OBJECT_TOKEN`, `DURABLE_OBJECT_NAMESPACE_ID`, and `DURABLE_OBJECT_SOCKET_GATEWAY_URL` are removed; other environment variables are inherited. Standard input, output, and error are inherited, so interactive clients work normally. Use `run` for trusted development scripts.

For hosted clients, configure the [SDK environment](api.md#client-configuration) and launch the script directly instead of using the local `run` command.

## Start a hosted server

```sh
npx little-actors start
```

Starts the packaged server using self-hosting settings from the environment. It takes no positional arguments or command-specific options beyond `-h` / `--help`.

Configure the database, storage, authentication, and cloud provider using the [self-hosting guide](../guides/self-hosting.md). Every server setting and default is listed under [server configuration](../guides/self-hosting.md#server-configuration). The npm CLI defaults `DURABLE_OBJECT_PROCESS_ROLE` to `control_plane`; leave it unset for this use.

`start` does not initialize a local project, register actor code, or supply development credentials. Register code separately using the [deployment API](http.md#deployments).

## Environment variables

Local actor processes inherit ordinary application environment variables from the development server process. Hosted server settings are listed in [server configuration](../guides/self-hosting.md#server-configuration); SDK client settings are in [client configuration](api.md#client-configuration).

### DURABLE_OBJECT_BINARY

**Default:** Downloaded runtime.

Path to an existing native executable used by `dev` and `start`. Relative paths resolve from the current working directory. This bypasses runtime downloads; see [local development](../guides/local-development.md) for building from source.

### DURABLE_OBJECT_CACHE_DIR

**Default:** `~/.cache/little-actors`.

Root directory for downloaded runtimes. Ignored when `DURABLE_OBJECT_BINARY` is set.

### DURABLE_OBJECT_STANDARD_BUCKETS

**Required for `--storage gcs`.** JSON object mapping storage regions to bucket names. It is not needed for `--storage local`. See [GCS snapshots](#save-snapshots-in-gcs).

### GOOGLE_APPLICATION_CREDENTIALS

**Default:** Google Application Default Credentials discovery.

Service-account credentials file for GCS. An attached Google identity can also supply credentials.

### RUST_LOG

**Default:** `info`.

Runtime log filter, for example `warn` or `debug`.

## Runtime installation

For a release that includes the CLI:

```sh
npm install little-actors
npx little-actors --help
```

The package includes the SDK, CLI, and TypeScript execution support. `dev` and `start` download a native runtime matching the installed package version if it is not cached. Downloads are verified against the release's SHA-256 checksum; `run`, `token`, and help do not download a runtime.

Prebuilt platforms are macOS and Linux on ARM64 and x64. Linux requires glibc 2.35+ and OpenSSL 3, such as Ubuntu 22.04+. Windows users can run the Linux distribution in WSL 2.

A prebuilt runtime does not require Rust. For source builds, see [local development](../guides/local-development.md#build-the-sdk-and-runtime).

The default cache path is `~/.cache/little-actors/<version>/<platform>-<arch>/`. Override its root with `DURABLE_OBJECT_CACHE_DIR`, or select an existing executable with `DURABLE_OBJECT_BINARY`.

## Issue a local token

```sh
npx little-actors token
```

Requests a session token from the running local server. Standard output contains only the token followed by a newline. Errors go to standard error.

### token options

```text
little-actors token [options]
```

- `--data-dir <directory>` — Directory belonging to the running local server. Defaults to `.little-actors`, relative to the current directory.
- `-h`, `--help` — Print command help.

The requested deadline is one hour in the future. Token issuance adds up to 30 seconds of grace, subject to the server's lifetime cap. Regenerate the token after a server restart.

The token permits application access throughout the `local` namespace. It is neither an admin credential nor restricted to one room. See [session tokens](http.md#session-tokens) for scope and expiration rules.

### Connect with a WebSocket tool

```sh
TOKEN="$(npx little-actors token)"
npx --yes wscat \
    -c ws://127.0.0.1:7100/v1/namespaces/local/actors/ChatRoom/lobby/websocket \
    -H "Authorization: Bearer $TOKEN" \
    -x '{"type":"initialize","metadata":{}}' \
    -w -1
```

Use the server's actual port, and pass `--data-dir` to `token` if the server uses a custom directory. The [WebSocket reference](http.md#direct-websocket-connections) describes initialization and message formats.

## Help and version

```sh
npx little-actors --help
npx little-actors dev --help
npx little-actors --version
```

- `-h`, `--help` — Print help. Available on the root command and each subcommand.
- `-V`, `--version` — Print the npm package version. Available on the root command.

Invoking the npm CLI without a command prints help. There is no separate `help` command. For `run`, place `--help` before the script filename to see CLI help.

The commands on this page use the npm CLI. The native executable supports `dev`, `--help`, and `--version`; `run`, `token`, and `start` are npm CLI commands.

## Output and exit codes

`dev` writes the ready origin, state directory, and runtime logs. `run` inherits standard input, output, and error. `token` writes its credential to stdout and errors to stderr; help and version commands exit successfully.

Setup and argument errors return a nonzero exit code, normally `1`. `run`, `dev`, and `start` forward the child process's numeric exit code. A child terminated by SIGINT maps to `130`; another terminating signal maps to `1`.

Ctrl-C requests shutdown. It does not erase actor state.

## Troubleshooting

### No local runtime found

Start `dev` and use its data directory for `run` or `token`. With a custom directory or a different working directory, pass `--data-dir` explicitly.

### Cannot reach the local runtime

Restart `dev`, wait for the ready message, and rerun the client. Tokens copied before the restart must be regenerated.

### Actor file is missing or changes do not appear

Create the entrypoint before starting `dev`, or select it with `--entrypoint`. Restart `dev` after actor code changes. Rebuild the SDK if you changed its source in a linked checkout.

### Port or data directory is in use

Choose another `--port`, or use `--port 0`. Stop the runtime using the data directory or choose a separate directory.

### Storage configuration changed

Use a separate `--data-dir` for a different backend or bucket map. Existing actors are not migrated by changing these settings.

### Runtime download fails

Confirm that the installed package version has matching native release assets, or use a [local build](../guides/local-development.md). For a checksum mismatch, retry the download; the rejected archive is not usable.

### Client flags are interpreted by the CLI

Place client flags after the script filename. CLI flags belong before it.

For linking or source-build issues, see [local development troubleshooting](../guides/local-development.md#troubleshooting).
