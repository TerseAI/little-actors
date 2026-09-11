# Express + React chat

The sample bundled with `little-actors init`.

## Run it

```sh
npm install
npx little-actors generate
npx little-actors dev
```

Wait for `Local actors ready`. In another terminal, from this directory:

```sh
npm run dev
```

Open [the chat](http://127.0.0.1:3000) in two tabs. Send a message, then reload to see the saved history.

## How it works

| File                                             | Role                                                         |
| ------------------------------------------------ | ------------------------------------------------------------ |
| [src/durable-objects.ts](src/durable-objects.ts) | Saves history and publishes changes with `@Emittable`.       |
| [src/backend.ts](src/backend.ts)                 | Issues socket tickets with `ActorProxy`.                     |
| [src/Chat.tsx](src/Chat.tsx)                     | Sends messages and subscribes to history with `ActorClient`. |

Everyone is a guest in this demo. In your app, authenticate the request before `ActorProxy.handle` and derive metadata from the signed-in user.

`ActorClient()` uses `/api/socket/{actorType}/{actorId}` on the current origin. `ActorProxy` reads local credentials automatically. For a remote actor server, set `DURABLE_OBJECT_CONTROL_PLANE_URL` and `DURABLE_OBJECT_API_KEY` on your backend.

After changing the actor's types, rerun `npx little-actors generate` and restart the actor server.
