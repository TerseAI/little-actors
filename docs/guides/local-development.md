# Local development

Use this guide when changing the SDK, CLI, or runtime. To use the published package, start with the [chat tutorial](../../README.md#build-a-chat-room-in-your-terminal).

The steps below run the same tutorial with the SDK and runtime built from one source checkout.

## Build the SDK and runtime

Requires Node.js 20+, pnpm, and Rust 1.89+. From the repository root, install dependencies and build the SDK and local runtime:

```sh
pnpm install
pnpm --dir npm build
cargo build --locked
```

## Link the package

In a separate demo directory:

```sh
mkdir chat-example
cd chat-example
npm init -y
npm pkg set type=module
npm link /absolute/path/to/little-actors/npm
mkdir src
```

Link the repository's `npm/` directory, which contains the package and CLI. The repository root is a private workspace, not the installable SDK. `npm link` creates a local package link; it does not publish anything.

## Run the chat tutorial

Create the actor and client files from the [chat tutorial](../../README.md#build-a-chat-room-in-your-terminal), then start the server from the demo directory:

```sh
LAC_BINARY=/absolute/path/to/little-actors/target/debug/lac \
  npx --no-install lac dev
```

The binary override is needed for `dev`: linking the JavaScript package alone does not select a locally built runtime. `--no-install` keeps `npx` from installing a package if the link is missing.

After the ready message, open two more terminals in the demo directory. Run one command per terminal:

```sh
npx --no-install lac run src/chat.ts Alice
```

```sh
npx --no-install lac run src/chat.ts Bob
```

`run` and `token` use the running server, so they do not need `LAC_BINARY`.

## Rebuild after changes

Rebuild with `pnpm --dir npm build` after SDK or CLI changes, and with `cargo build --locked` after runtime changes. Restart `dev` after actor changes. The link continues to use the rebuilt package.
