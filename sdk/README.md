# little-actors

Named actors with serial method calls and saved state. Requires Node.js 20+.

```sh
npm install little-actors
```

Start with the [terminal chat tutorial](https://github.com/TerseAI/little-actors#build-a-chat-room-in-your-terminal): two listeners, live messages, and history that survives restarts. It includes complete files and expected output.

## Local CLI

Export actors from `src/durable-objects.ts`. In your project directory:

```sh
npx little-actors dev
```

Wait for `Local actors ready at http://127.0.0.1:7100`. In another terminal:

```sh
npx little-actors run src/chat.ts Alice
```

Run a second listener in a third terminal:

```sh
npx little-actors run src/chat.ts Bob
```

Once both clients have joined, type a message and press Enter. Both receive it. Reconnect either client to see the saved conversation. The CLI supplies credentials and stores SQLite metadata and snapshots in `.little-actors/`. State survives restarts; losing that directory loses the actors. Restart `dev` after actor code changes.

`dev --help` lists options.

These examples use version `0.1.27` or later.

## Hosted clients

Set these before the first actor call:

```sh
export DURABLE_OBJECT_API_KEY='<your-api-key>'
export DURABLE_OBJECT_CONTROL_PLANE_URL='https://objects.example.com'
```

Keep the API key on your backend, where you check user permissions. The SDK connects to the named actor and calls its methods. Mobile and browser apps use [WebSockets authorized by your backend](https://github.com/TerseAI/little-actors/blob/main/docs/guides/self-hosting.md#websocket-configuration).

See [self-hosting](https://github.com/TerseAI/little-actors/blob/main/docs/guides/self-hosting.md) for deployment and credentials. Runtime distributions bundle the Go provider.

## WebSocket API

The gateway keeps connections while actors hibernate. Each accepted connection receives `{"type":"state","state":{...}}` automatically.

Send JSON values directly with `socket.send({ type: "chat", text: "Hello" })`. The SDK encodes outgoing messages and parses incoming messages, including the initial state.

`Actor<Metadata, Incoming, Outgoing = Incoming, Tag extends string = string>` types metadata, both message directions, and tags. Use `ActorSocketOf<ChatRoom>` and `ActorMessageOf<ChatRoom>` in hooks to reuse those types. Optional static Zod schemas validate metadata, incoming and outgoing messages, and tags at runtime; see [generics and wire validation](https://github.com/TerseAI/little-actors/blob/main/docs/reference/api.md#generics-and-wire-validation).

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

- [CLI reference](https://github.com/TerseAI/little-actors/blob/main/docs/reference/cli.md): commands, options, and environment variables.
- [TypeScript API reference](https://github.com/TerseAI/little-actors/blob/main/docs/reference/api.md): actors, methods, connections, types, and errors.
- [HTTP and WebSocket reference](https://github.com/TerseAI/little-actors/blob/main/docs/reference/http.md): deployments, backend access, connections, and callbacks.
- [Local development](https://github.com/TerseAI/little-actors/blob/main/docs/guides/local-development.md): build and link a source checkout.
- [Advanced access configuration](https://github.com/TerseAI/little-actors/blob/main/docs/guides/advanced-access.md).

## License

MIT © 2026 Terse
