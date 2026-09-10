# Local development

Run the [chat tutorial](../../README.md#browser-chat-demo) from a source checkout without installing a published package or deploying a server. The SDK and runtime come from the same checkout.

## Build the SDK and runtime

Requires Node.js 20+, pnpm, and Rust 1.89+. From the repository root, install dependencies and build the SDK and local runtime:

```sh
pnpm install
pnpm --dir sdk build
cargo build --locked
```

## Link the package

In a separate demo directory:

```sh
mkdir chat-example
cd chat-example
npm init -y
npm pkg set type=module
npm link /absolute/path/to/little-actors/sdk
mkdir src
```

Link the repository's `sdk/` directory, which contains the package and CLI. The repository root is a private workspace, not the installable SDK. `npm link` creates a local package link; it does not publish anything.

## Connect the browser demo

Create the backend actor and web application code from the [chat tutorial](../../README.md#browser-chat-demo), then start the server from the demo directory:

```sh
DURABLE_OBJECT_BINARY=/absolute/path/to/little-actors/target/debug/little-actors \
  npx --no-install lac dev
```

The binary override is needed for `dev`: linking the JavaScript package alone does not select a locally built runtime. `--no-install` keeps `npx` from installing a package if the link is missing.

After the ready message, generate the client and proxy into their projects:

```sh
npx --no-install lac generate src/durable-objects.ts --out-dir src/generated/actors
npx --no-install lac generate src/durable-objects.ts --out-dir ../web/src/generated/actors
```

Configure the application proxy using the backend URL and API key from `.little-actors/runtime.json`. Add the authenticated proxy route and browser UI from the [main-page demo](../../README.md#browser-chat-demo), then start the web app with its normal development server. Open two signed-in browser sessions to try chat.

The frontend never imports the actor implementation. Generated SDK requests go to your proxy for credentials, and socket messages go directly to the actor gateway. `generate` and `token` do not need `DURABLE_OBJECT_BINARY`.

## Rebuild after changes

Rebuild with `pnpm --dir sdk build` after SDK or CLI changes, and with `cargo build --locked` after runtime changes. Restart `dev` after actor changes. The link continues to use the rebuilt package.

## Troubleshooting

If the CLI is missing, check that you linked the repository's `sdk/` directory and ran `pnpm --dir sdk build`. If it tries to download a release, set `DURABLE_OBJECT_BINARY` on the `dev` command to the executable you built.

For server startup, storage, and client connection issues, see the [CLI troubleshooting guide](../reference/cli.md#troubleshooting).
