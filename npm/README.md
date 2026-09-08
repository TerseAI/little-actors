# little-actors

Named actors with serial method calls and saved state. Requires Node.js 20+.

```sh
npm install little-actors
```

Start with the [terminal chat tutorial](https://github.com/TerseAI/little-actors#build-a-chat-room-in-your-terminal): two listeners, live messages, and history that survives restarts. It includes complete files and expected output.

## Local CLI

Export actors from `src/actors.ts`. In your project directory:

```sh
npx lac dev
```

The CLI downloads and caches the runtime automatically. No Rust installation or runtime path is needed.

Wait for `Local actors ready at http://127.0.0.1:7100`. In another terminal:

```sh
npx lac run src/chat.ts Alice
```

Run a second listener in a third terminal:

```sh
npx lac run src/chat.ts Bob
```

Once both clients have joined, type a message and press Enter. Both receive it. Reconnect either client to see the saved conversation. The CLI supplies credentials and stores SQLite metadata and snapshots in `.little-actors/`. State survives restarts; losing that directory loses the actors. Restart `dev` after actor code changes.

`dev --help` lists options. `token` prints a one-hour local credential for tools such as `wscat`.

## Hosted clients

Set these before the first actor call:

```sh
export LAC_TOKEN='<session-token>'
export LAC_NAMESPACE_ID='my-project'
export LAC_CONTROL_PLANE_URL='https://objects.example.com'
```

Use a session token issued by your trusted backend. Terse supplies these variables to workflows. The SDK connects to the named actor and calls its methods.

See [self-hosting](https://github.com/TerseAI/little-actors/blob/main/docs/guides/self-hosting.md) for deployment and credentials. Runtime distributions bundle the Go provider.

## WebSocket API

The gateway keeps connections while actors hibernate. Each accepted connection receives `{"type":"state","state":{...}}` automatically.

| API                                  | Behavior                                             |
| ------------------------------------ | ---------------------------------------------------- |
| `Actor.get(id).connect(metadata)`    | Opens a connection with JSON-serializable metadata.  |
| `onMessage(socket, message)`         | Handles incoming messages on the actor.              |
| `onDisconnect(socket)`               | Handles a closed connection.                         |
| `this.broadcast(message)`            | Sends to connected clients.                          |
| `socket.send(message)`               | Sends to one client.                                 |
| `socket.metadata`                    | Reads or replaces JSON metadata for a connection.    |
| `socket.setTags(...tags)`            | Tags a connection for filtered broadcasts.           |
| `socket.close()` / `socket.reject()` | Closes a connection / rejects it during `onConnect`. |

`this.connections` lists connections during an invocation. From application code, `Actor.get(id).broadcast(message)` sends transient output without invoking the actor or saving state.

Inside an actor, use `this.broadcast(message, { exclude: socket })` to skip one connection, or pass an array to exclude several. Add `tags` to reach connections matching all listed tags. Without either option, broadcasts reach every open connection, including the sender.

WebSockets use the control-plane URL unless `LAC_SOCKET_GATEWAY_URL` is set.

## Reference

- [CLI reference](https://github.com/TerseAI/little-actors/blob/main/docs/reference/cli.md): commands, options, and environment variables.
- [TypeScript API reference](https://github.com/TerseAI/little-actors/blob/main/docs/reference/api.md): actors, methods, connections, types, and errors.
- [HTTP and WebSocket reference](https://github.com/TerseAI/little-actors/blob/main/docs/reference/http.md): deployments, tokens, connections, and callbacks.
- [Local development](https://github.com/TerseAI/little-actors/blob/main/docs/guides/local-development.md): build and link a source checkout.

## License

MIT © 2026 Terse
