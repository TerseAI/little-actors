# Express + React chat

The chat app bundled with `little-actors init`. Start with the [quickstart](https://github.com/TerseAI/little-actors#quickstart).

## Run it

From this directory, with Node.js 22.19+:

```sh
npm install
npx little-actors generate
npx little-actors dev
```

The SDK comes from npm. Generation writes the client and proxy to `generated/`. The actor server downloads its native runtime automatically.

Wait for `Local actors ready at http://127.0.0.1:7100`. In another terminal, from the same directory:

```sh
npm run dev
```

Open **http://127.0.0.1:3000**, choose a name, and send a message. Open a private browser window for a second user. Reload either page to receive the saved conversation.

## How it works

| File                                             | Role                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| [src/durable-objects.ts](src/durable-objects.ts) | Saves history and publishes changes with `@Emittable`.                |
| [src/backend.ts](src/backend.ts)                 | Stores the demo session and authorizes connections with `ActorProxy`. |
| [src/Chat.tsx](src/Chat.tsx)                     | Sends messages and subscribes to history with `ActorClient`.          |
| [src/frontend.ts](src/frontend.ts)               | Mounts React in [index.html](index.html).                             |

The backend reads credentials from `.little-actors/runtime.json` on each connection or renewal. The API key stays on the backend. Replace the demo name form with your own authentication and room-access checks.

After changing the actor's message or state types, rerun the generation command above and restart the actor server.

For a hosted actor service, set `DURABLE_OBJECT_CONTROL_PLANE_URL` and `DURABLE_OBJECT_API_KEY` on Express. You can also set `DURABLE_OBJECT_NAMESPACE_ID`.

Run `npm run build`, then `npm start` to serve the built app alongside the actor server.
