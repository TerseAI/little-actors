# TypeScript API reference

This page documents the public exports of `little-durable-objects`. Requires Node.js 20+ and an ES module project. For a working application, see the [chat tutorial](../../README.md#build-a-chat-room-in-your-terminal).

- [Actor](#actor)
- [Actor references](#actor-references)
- [ActorSocket](#actorsocket)
- [ActorConnection](#actorconnection)
- [ActorInvocationError](#actorinvocationerror)
- [Types](#types)
- [Client configuration](#client-configuration)

Deployment management and direct WebSocket connections are documented in the [HTTP reference](http.md). Browser clients use the [external WebSocket connection API](http.md#external-connections).

## Actor

```ts
import { Actor } from "little-durable-objects"
```

Base class for actors with saved state. Export a named subclass from your actor entrypoint, normally `src/durable-objects.ts`:

```ts
import { Actor } from "little-durable-objects"

export class ChatRoom extends Actor {
    history: string[] = []

    async post(message: string): Promise<number> {
        this.history.push(message)
        this.broadcast(message)
        return this.history.length
    }
}
```

Classes must extend `Actor` directly and have no required constructor arguments. The base constructor is protected; a custom constructor must also remain protected for the typed `get()` API. Application code addresses actors with [`get()`](#actorget).

The entrypoint's runtime exports must all be actor classes, exported under their class names. Default exports and aliases are rejected. Type-only exports are permitted; shared constants and utilities belong in other modules.

Remote methods must be `async` prototype methods. Getters, setters, symbol methods, synchronous prototype methods, and the reserved names `then`, `connect`, and `broadcast` are rejected. Class-field arrow functions are not discovered as remote methods.

TypeScript `private` and `protected` do not provide authorization for discovered prototype methods. Access checks belong in application code. JavaScript private methods are not remotely discovered.

### Actor.get

```text
static get(actorId: string)
```

Creates a typed reference to an actor of the subclass. Creating a reference is synchronous and makes no remote call. The first operation starts the actor if needed.

**Parameters**

- `actorId` (`string`, required) — Actor ID within the configured namespace and class. See [identity](#identity) for validation.

**Returns:** An inferred [actor reference](#actor-references), exposing the subclass's asynchronous application methods, `connect()`, and `broadcast()`.

**Raises:** An `Error` if the actor definition or ID is invalid.

```ts
import { ChatRoom } from "./durable-objects.js"

const room = ChatRoom.get("lobby")
await room.post("Hello")
```

### Actor.id

```text
protected readonly id: string
```

The current actor ID, available inside an actor method or lifecycle hook. Reading it before the runtime binds the actor, including in its constructor, raises an `Error`. It is not a saved state field.

### Actor.connections

```text
protected readonly connections: readonly ActorSocket[]
```

Connections available during the invocation. Includes the connecting socket during `onConnect` and excludes the disconnected socket during `onDisconnect`. Access outside an invocation raises an `Error`.

Socket objects belong to the current invocation and are not saved actor state. Each actor supports up to 128 connections per gateway process.

### Actor.broadcast

```text
protected broadcast(message: ActorSocketMessage, options?: ActorBroadcastOptions): void
```

Sends to currently open connections. By default, this includes the sender when called from `onMessage`.

**Parameters**

- `message` ([ActorSocketMessage](#actorsocketmessage), required) — Text or binary data to send.
- `options` ([ActorBroadcastOptions](#actorbroadcastoptions), optional) — Recipient exclusions and tag filters. Omitted options send to all open connections.

**Returns:** `void`. Recipients do not acknowledge delivery, and broadcasting does not add the message to saved state.

**Raises:** An `Error` outside an invocation, for invalid messages or tags, or if socket output exceeds its [limits](#socket-output-limits).

Inside an actor method or hook:

```ts
this.broadcast("Hello", { except: socket })
this.broadcast("Document updated", { tags: ["editors", "document-1"] })
```

### Actor.onConnect

```text
async onConnect(socket: ActorSocket<Metadata>): Promise<void>
```

Optional lifecycle hook called when a connection is initialized. The socket is `"connecting"`; acceptance is automatic when the hook succeeds without rejecting it. Calling `socket.reject(4003, "Access denied")` suppresses acceptance and initial state delivery.

**Parameters**

- `socket` ([ActorSocket](#actorsocket)) — Joining connection. Its metadata type is inferred by [`reference.connect()`](#referenceconnect).

**Returns:** `Promise<void>`. Successful state changes are saved.

After acceptance, the connection receives the actor's saved properties, including changes made by this hook:

```json
{ "type": "state", "state": { "history": [] } }
```

Messages sent with `socket.send()` during the hook precede that state message. Existing connections can receive broadcasts during the hook, but the joining connection is not yet a broadcast recipient. Use `socket.send()` to address it directly.

### Actor.onMessage

```text
async onMessage(socket: ActorSocket<Metadata>, message: ActorSocketMessage): Promise<void>
```

Optional lifecycle hook called for incoming application messages. Text arrives unchanged; the runtime does not JSON-parse it. Incoming activity wakes a hibernating actor as needed.

**Parameters**

- `socket` ([ActorSocket](#actorsocket)) — Sending connection, in state `"open"`.
- `message` ([ActorSocketMessage](#actorsocketmessage)) — A `string` for text or `Uint8Array` for binary data.

**Returns:** `Promise<void>`. Successful state changes are saved.

The [chat tutorial](../../README.md#2-create-the-room) shows a complete implementation that saves and broadcasts each message.

### Actor.onDisconnect

```text
async onDisconnect(socket: ActorSocket<Metadata>, code: number, reason: string, wasClean: boolean): Promise<void>
```

Optional lifecycle hook called when the server observes a connection closing. The socket is absent from `this.connections` and cannot send messages.

**Parameters**

- `socket` ([ActorSocket](#actorsocket)) — Closed connection, in state `"closed"`.
- `code` (`number`) — Observed WebSocket close code.
- `reason` (`string`) — Close text.
- `wasClean` (`boolean`) — Whether a clean close was observed.

**Returns:** `Promise<void>`. Successful state changes are saved.

An abrupt server failure can prevent the hook from running. Connections can remain open while an actor hibernates, but clients must reconnect after a gateway restart. Connection metadata and tags are not restored as a new connection after a restart.

### Identity

An actor's namespace, class name, and actor ID identify its saved state. Reusing that identity addresses the same actor. Changing the class name or actor ID addresses a different actor.

| Component        | Maximum length |
| ---------------- | -------------- |
| Namespace ID     | 96 bytes       |
| Actor class name | 48 bytes       |
| Actor ID         | 128 bytes      |
| Method name      | 128 bytes      |

Each component must be nonempty and contain only ASCII letters, digits, `.`, `_`, and `-`. Namespace, class name, and actor ID together must fit 243 bytes. Validation can occur when creating a reference or when a request reaches the server.

### Saved state and serialization

The runtime saves an actor's own enumerable string-keyed properties after successful invocations and lifecycle events. Constructors and field initializers create initial state for new actors. Ordinary TypeScript `private` fields are saved; JavaScript `#private` fields, symbols, and non-enumerable properties are not.

On restoration, saved fields replace initialized enumerable fields. New field initializers are **not merged into existing saved state**. After adding a field to an existing actor, an application can initialize it in a method with `this.history ??= []`.

Arguments, results, metadata, and state use JSON serialization:

| Value                                                            | Serialization behavior                                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Strings, booleans, finite numbers, `null`, arrays, plain objects | Preserved as JSON values.                                                                            |
| `Date`                                                           | Becomes its JSON string representation.                                                              |
| `undefined`, functions, symbols in object properties             | Omitted.                                                                                             |
| `undefined`, functions, symbols in arrays                        | Become `null`.                                                                                       |
| `NaN`, positive or negative infinity                             | Become `null`.                                                                                       |
| `BigInt` or circular references                                  | Fail serialization.                                                                                  |
| `Map`, `Set`, custom classes                                     | Serialize their enumerable properties or `toJSON()` result; prototypes and methods are not retained. |

A method returning `undefined` produces `null` at runtime. TypeScript return annotations do not change JSON behavior. Binary WebSocket messages do not use this JSON representation.

When an actor method throws, its state changes are not saved. External effects, including HTTP requests and already sent WebSocket messages, cannot be rolled back. Socket output can arrive before state is committed; receiving a broadcast does not confirm persistence.

Every accepted connection automatically receives the actor's saved properties. Those fields must not contain secrets that its connected clients are not authorized to read.

Saved state is limited to 16 MiB of JSON. Method requests and responses must fit 32 MiB, including encoded state, arguments or results, and message overhead. Individual limits do not guarantee that a near-limit combination fits in one request.

## Actor references

References are inferred from the subclass passed to [`Actor.get()`](#actorget); there is no separately exported `ActorReference` type. They expose asynchronous application methods, `connect()`, and `broadcast()`. Saved fields and lifecycle hooks are not exposed.

### Remote methods

Application methods retain their declared parameter and return types on the reference. Arguments and results follow the [JSON serialization rules](#saved-state-and-serialization). To read a field remotely, expose a method that returns it.

Calls to the same actor execute one at a time, including across `await` within a method. Separate actors have independent state and can execute concurrently. Concurrent requests are serialized, but their launch order does not guarantee their execution order.

**Returns:** A promise for the method's result. Successful calls save state.

**Raises:** [`ActorInvocationError`](#actorinvocationerror) for failed remote operations, or an ordinary `Error` for definition, configuration, validation, or serialization failures.

Actor-to-actor remote calls, connections, and broadcasts are not supported inside actor invocations. Multiple actors can be coordinated from application code. Work that affects an invocation must be awaited; background work is not a durable job mechanism.

### reference.connect

```text
connect(metadata: Metadata): Promise<ActorConnection>
```

Opens a WebSocket connection to the actor. The SDK handles bearer authentication and initialization.

**Parameters**

- `metadata` (required) — JSON-serializable connection metadata; use `{}` for no metadata. Its type is inferred from `onConnect(socket: ActorSocket<Metadata>)`, or is `unknown` without that hook. Other lifecycle hooks do not establish the inferred type.

**Returns:** `Promise<ActorConnection>`, resolving when the WebSocket opens and initialization is sent. The actor's `onConnect` hook and initial state delivery can still be pending.

**Raises:** An `Error` if setup or opening fails. After opening, failures arrive through [connection events](#connection-events); a hook can still reject the connection.

```ts
import { ChatRoom } from "./durable-objects.js"

const socket = await ChatRoom.get("lobby").connect({})
socket.addEventListener("message", ({ data }) => console.log(String(data)))
```

Install message and close listeners immediately after awaiting `connect()`. A reconnect requires a new call with fresh metadata; neither automatic reconnect nor transient-message replay is provided.

### reference.broadcast

```text
broadcast(message: ActorSocketMessage): Promise<void>
```

Sends transient output to the actor's currently connected clients. It does not execute an actor method, update saved state, or retain the message for future connections. There are no recipient-filter options.

**Parameters**

- `message` ([ActorSocketMessage](#actorsocketmessage), required) — Text or binary data to send.

**Returns:** `Promise<void>`. With no connected clients, there is nothing to deliver.

**Raises:** An `Error` for invalid input or configuration, or an [`ActorInvocationError`](#actorinvocationerror) for a server-reported failure.

```ts
import { ChatRoom } from "./durable-objects.js"

await ChatRoom.get("lobby").broadcast("Deployment completed")
```

To save and broadcast together, invoke an actor method that updates a field and calls [`this.broadcast()`](#actorbroadcast).

## ActorSocket

```ts
import type { ActorSocket } from "little-durable-objects"
```

Actor-side connection passed to lifecycle hooks and listed in `this.connections`. `ActorSocket<Metadata>` describes the metadata shape; its default metadata type is JSON-compatible values. Import it as a type; it is not a constructor.

### ActorSocket.id

```text
readonly id: string
```

Unique connection ID.

### ActorSocket.metadata

```text
metadata: Metadata
```

JSON metadata supplied at connection time. Assign the whole value to retain a change for later events; mutating a nested property alone does not publish an update. Assignment raises an `Error` if the value cannot be serialized.

Inside a hook using `ActorSocket<{ userId: string }>`:

```ts
socket.metadata = { ...socket.metadata, userId: "bob" }
```

Metadata is limited to 64 KiB of JSON-encoded UTF-8. SDK clients supply their own metadata; it is not proof of identity or permission. It lasts for the connection unless copied into saved actor fields.

### ActorSocket.tags

```text
readonly tags: readonly string[]
```

Current connection tags. Replace them with [`setTags()`](#actorsocketsettags). Tags last for the connection and are not saved actor fields.

### ActorSocket.state

```text
readonly state: ActorSocketState
```

Connection state: `"connecting"` during `onConnect`, `"open"` during message handling, or `"closed"` after closing. See [ActorSocketState](#actorsocketstate-type).

### ActorSocket.send

```text
send(message: ActorSocketMessage): void
```

Sends text or binary data to this connection, including during `onConnect`.

**Parameters**

- `message` ([ActorSocketMessage](#actorsocketmessage), required) — A `string` or `Uint8Array`.

**Returns:** `void`.

**Raises:** An `Error` if the socket is closed, the message type is invalid, or socket output exceeds its [limits](#socket-output-limits).

Inside an actor method or hook:

```ts
socket.send("Hello")
```

### ActorSocket.close

```text
close(code?: number, reason?: string): void
```

Closes the connection. Repeating a valid close on an already closed socket does nothing.

**Parameters**

- `code` (`number`, default `1000`) — Integer `1000` or an application code from `3000` through `4999`.
- `reason` (`string`, default `""`) — Close text, at most 123 UTF-8 bytes.

**Returns:** `void`.

**Raises:** An `Error` for an invalid code or an oversized reason, including when the socket is already closed.

### ActorSocket.reject

```text
reject(code?: number, reason?: string): void
```

Rejects a joining connection during `onConnect` and suppresses the automatic state message.

**Parameters**

- `code` (`number`, default `1008`) — Subject to the same validation as [`close()`](#actorsocketclose).
- `reason` (`string`, default `"connection rejected"`) — Close text, at most 123 UTF-8 bytes.

**Returns:** `void`.

**Raises:** An `Error` unless the socket is `"connecting"`, or if the code or reason is invalid.

The current default code `1008` fails close-code validation. Pass an accepted application code explicitly:

```ts
socket.reject(4003, "Access denied")
```

### ActorSocket.setTags

```text
setTags(...tags: string[]): void
```

Replaces connection tags, removing duplicates. Calling with no arguments clears all tags.

**Parameters**

- `tags` (`string[]`) — Up to 128 unique tags, each 1–256 JavaScript string code units. Total tag text must fit 8 KiB of UTF-8.

**Returns:** `void`.

**Raises:** An `Error` for invalid tags or exceeded limits.

```ts
socket.setTags("editors", "document-1")
```

### Socket output limits

Text and binary messages or frames are limited to 16 MiB; the binary limit applies to decoded data. Pending actor socket output is limited to 512 queued operations or 24 MiB of serialized queued output. Exceeding the queue limit fails the operation.

Sending and broadcasting do not acknowledge persistence or recipient delivery. Already sent output cannot be rolled back if the actor later fails.

## ActorConnection

```ts
import type { ActorConnection } from "little-durable-objects"
```

Client-side connection returned by [`reference.connect()`](#referenceconnect). The SDK handles authentication and initialization; application code handles message encoding, validation, display, and replay beyond the initial saved state. Import it as a type; it is not a constructor.

### ActorConnection.readyState

```text
readonly readyState: number
```

WebSocket state: `0` connecting, `1` open, `2` closing, or `3` closed. The connection is already open when `connect()` resolves.

### ActorConnection.send

```text
send(data: string | ArrayBufferLike | ArrayBufferView): void
```

Sends application data to the actor's `onMessage` hook. Send only while the connection is open.

**Parameters**

- `data` (`string | ArrayBufferLike | ArrayBufferView`, required) — Strings are text frames; buffers and typed-array views are binary frames.

**Returns:** `void`. This is not an acknowledgment of actor handling or persistence.

**Raises:** An `Error` if the WebSocket is still connecting. Later transport failures arrive through connection events.

### ActorConnection.close

```text
close(code?: number, reason?: string): void
```

Starts the WebSocket closing handshake. Repeating a close after the connection has closed does nothing.

**Parameters**

- `code` (`number`, optional) — WebSocket close code. Omitted sends no explicit status code; `1000` requests normal closure. Standard sendable WebSocket codes and application codes `3000`–`4999` are accepted.
- `reason` (`string`, default `""`) — Close text, at most 123 UTF-8 bytes.

**Returns:** `void`.

**Raises:** An `Error` for an invalid close code or oversized reason when starting the handshake.

Client connections do not have the actor-side `reject()` method.

### ActorConnection.addEventListener

```text
addEventListener(type, listener): void
```

Registers an event listener. Event fields are inferred from the event name.

**Parameters**

- `type` (`"open" | "message" | "close" | "error"`, required) — [Connection event](#connection-events) to listen for.
- `listener` (function, required) — Receives the corresponding event object and returns `void`.

**Returns:** `void`. The public interface does not accept listener options.

### ActorConnection.removeEventListener

```text
removeEventListener(type, listener): void
```

Removes an event listener.

**Parameters**

- `type` (`"open" | "message" | "close" | "error"`, required) — Event name used when registering.
- `listener` (function, required) — The same function passed to `addEventListener()`.

**Returns:** `void`.

### Connection events

| Event     | Fields                                                                 | Meaning                                                                       |
| --------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `open`    | `type: "open"`                                                         | Connection opened. Normally occurs before `connect()` returns the connection. |
| `message` | `type: "message"`, `data: string \| Uint8Array \| ArrayBuffer`         | Initial state or actor-sent application data.                                 |
| `close`   | `type: "close"`, `code: number`, `reason: string`, `wasClean: boolean` | Connection closed.                                                            |
| `error`   | `type: "error"`                                                        | Connection error. The public event type has no message field.                 |

The initial state is a JSON text message with shape `{"type":"state","state":{...}}`. Subsequent application messages use the encoding chosen by the actor. See [close behavior](http.md#close-behavior) for common codes.

## ActorInvocationError

```ts
import { ActorInvocationError } from "little-durable-objects"
```

An `Error` subclass for failed remote operations. Its `name` is `"ActorInvocationError"`.

```text
new ActorInvocationError(code: string, requestId: string, message: string)
```

**Parameters**

- `code` (`string`, required) — Error category.
- `requestId` (`string`, required) — ID of the caller attempt.
- `message` (`string`, required) — Failure description, available through the inherited `message` property.

```ts
import { ActorInvocationError } from "little-durable-objects"

import { ChatRoom } from "./durable-objects.js"

try {
    await ChatRoom.get("lobby").post("Hello")
} catch (error) {
    if (error instanceof ActorInvocationError) {
        console.error(error.code, error.requestId, error.message)
    }
    throw error
}
```

### ActorInvocationError.code

```text
readonly code: string
```

Server-reported error category. This is an open string, not a closed enum; additional codes can occur.

| Code                 | Meaning                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `unauthenticated`    | Session token rejected or access not permitted. HTTP `401` and `403` during method calls map to this code. |
| `actor_error`        | Actor execution failed, including user exceptions or invalid output.                                       |
| `resource_exhausted` | Execution resource limit reached.                                                                          |
| `unavailable`        | Actor could not be reached or made available.                                                              |
| `outcome_unknown`    | Caller could not confirm the result; the operation may have run and saved state.                           |
| `invalid_request`    | Invalid request reported by the server.                                                                    |
| `conflict`           | Deployment conflict reported by the server.                                                                |
| `internal`           | Server failure.                                                                                            |

### ActorInvocationError.requestId

```text
readonly requestId: string
```

Identifies the caller attempt. It is not an application idempotency key.

### Errors and retries

The SDK can recover from a changed actor location, but application operations are not automatically idempotent. Retrying an uncertain outcome can run an operation twice. An application can store a caller-supplied operation ID and its result in actor state to recognize duplicates.

Validation, actor definition, configuration, serialization, and socket failures can be ordinary `Error` instances. `ActorInvocationError` is the only application error class exported from the package root. Other errors need not have `code` or `requestId`.

## Types

These types are exported from `little-durable-objects` alongside `ActorSocket` and `ActorConnection`.

### ActorClass

```ts
import type { ActorClass } from "little-durable-objects"
```

```text
type ActorClass<Instance extends Actor = Actor> = Function & {
    readonly prototype: Instance
}
```

An actor class whose prototype has type `Instance`. The type describes the class object; runtime discovery still enforces the [actor definition rules](#actor).

### ActorBroadcastOptions

```ts
import type { ActorBroadcastOptions } from "little-durable-objects"
```

Recipient filters for [`Actor.broadcast()`](#actorbroadcast). Both properties are readonly and optional; filters and exclusions can be combined.

#### ActorBroadcastOptions.except

```text
readonly except?: ActorSocket | readonly ActorSocket[]
```

Connections to exclude. Defaults to none; at most 128 exclusions are allowed.

#### ActorBroadcastOptions.tags

```text
readonly tags?: readonly string[]
```

Deliver only to connections having **all** listed tags. Omitted or empty means no tag filter. Each tag must contain 1–256 JavaScript string code units.

### ActorSocketMessage

```text
type ActorSocketMessage = string | Uint8Array
```

Text or binary data accepted by actor-side send and broadcast methods and passed to `onMessage`. Import with `import type { ActorSocketMessage } from "little-durable-objects"`.

### ActorSocketState (type)

```text
type ActorSocketState = "connecting" | "open" | "closed"
```

Actor-side connection state. Import with `import type { ActorSocketState } from "little-durable-objects"`. Client connections instead expose numeric [`readyState`](#actorconnectionreadystate).

## Client configuration

Set environment variables before the first remote operation. Configuration is loaded lazily and cached; changing the environment afterward does not reconfigure the existing client. The package root exposes no per-client configuration constructor.

```sh
export DURABLE_OBJECT_TOKEN='<session-token>'
export DURABLE_OBJECT_NAMESPACE_ID='chat-project'
export DURABLE_OBJECT_CONTROL_PLANE_URL='https://objects.example.com'
```

Local [`run`](cli.md#run-a-client) supplies these values automatically. Hosted clients receive tokens from a trusted backend using the [session-token API](http.md#session-tokens). Admin keys are backend credentials, not SDK session tokens.

### DURABLE_OBJECT_TOKEN

**Required.** Session token authorizing application operations throughout its namespace. The SDK does not automatically renew it. Separate processes are needed for different SDK configurations.

### DURABLE_OBJECT_NAMESPACE_ID

**Required.** Namespace containing the deployed actors. Must satisfy the [identity rules](#identity).

### DURABLE_OBJECT_CONTROL_PLANE_URL

**Required.** HTTP(S) server origin. A port and trailing slash are allowed; paths, queries, fragments, usernames, and passwords are not.

### DURABLE_OBJECT_SOCKET_GATEWAY_URL

**Default:** `DURABLE_OBJECT_CONTROL_PLANE_URL`.

Separate HTTP(S) WebSocket gateway origin, with the same origin restrictions. Use `https://sockets.example.com`; the SDK chooses the corresponding WebSocket scheme.
