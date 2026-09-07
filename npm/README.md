# little-durable-objects

Named actors with serial method calls and saved state. Requires Node.js 20+.

```sh
npm install little-durable-objects
```

Start with the [terminal chat tutorial](https://github.com/TerseAI/little-durable-objects#build-a-chat-room-in-your-terminal): two listeners, live messages, and history that survives restarts. It includes complete files and expected output.

## Local CLI

Export actors from `src/durable-objects.ts`. In your project directory:

```sh
npx little-durable-objects dev
```

Wait for `Local actors ready at http://127.0.0.1:7100`. In another terminal:

```sh
npx little-durable-objects run src/chat.ts Alice
```

Run a second listener in a third terminal:

```sh
npx little-durable-objects run src/chat.ts Bob
```

Once both clients have joined, type a message and press Enter. Both receive it. Reconnect either client to see the saved conversation. The CLI supplies credentials and stores SQLite metadata and snapshots in `.little-durable-objects/`. State survives restarts; losing that directory loses the actors. Restart `dev` after actor code changes.

`dev --help` lists options. `token` prints a one-hour local credential for tools such as `wscat`.

These CLI commands are unreleased and unavailable in npm version `0.1.24`.

## Hosted clients

Set these before the first actor call:

```sh
export DURABLE_OBJECT_TOKEN='<session-token>'
export DURABLE_OBJECT_NAMESPACE_ID='my-project'
export DURABLE_OBJECT_CONTROL_PLANE_URL='https://objects.example.com'
```

Use a session token issued by your trusted backend. Terse supplies these variables to workflows. The SDK connects to the named actor and calls its methods.

See [self-hosting](https://github.com/TerseAI/little-durable-objects/blob/main/docs/guides/self-hosting.md) for deployment and credentials. Runtime distributions bundle the Go provider.

## WebSocket API

The gateway keeps connections while actors hibernate. Each accepted connection receives `{"type":"state","state":{...}}` automatically.

| API                                  | Behavior                                             |
| ------------------------------------ | ---------------------------------------------------- |
| `Actor.get(id).connect(metadata)`    | Opens a connection with JSON-serializable metadata.  |
| `onMessage(socket, message)`         | Handles incoming messages on the actor.              |
| `onDisconnect(socket)`               | Handles a closed connection.                         |
| `this.broadcast(message)`            | Sends to connected clients.                          |
| `socket.send(message)`               | Sends to one client.                                 |
| `socket.setTags(...tags)`            | Tags a connection for filtered broadcasts.           |
| `socket.close()` / `socket.reject()` | Closes a connection / rejects it during `onConnect`. |

`this.connections` lists connections during an invocation. From application code, `Actor.get(id).broadcast(message)` sends transient output without invoking the actor or saving state.

WebSockets use the control-plane URL unless `DURABLE_OBJECT_SOCKET_GATEWAY_URL` is set.

## Reference

See the complete [CLI reference](https://github.com/TerseAI/little-durable-objects/blob/main/docs/reference/cli.md) and [API reference](https://github.com/TerseAI/little-durable-objects/blob/main/docs/reference/api.md).

## License

MIT © 2026 Terse
