import { ActorConnection } from "./connection.js"
import type { ActorDescriptor, ClientDependencies, ClientOptions } from "./types.js"

type ConnectionOf<Descriptor> =
    Descriptor extends ActorDescriptor<infer Incoming, infer Outgoing, infer State, infer Field>
        ? ActorConnection<Incoming, Outgoing, State, Field>
        : never

function createClient<Actors extends Record<string, ActorDescriptor<any, any, any, any>>>(
    actors: Actors,
    options: ClientOptions,
    dependencies: ClientDependencies = {}
) {
    return Object.fromEntries(
        Object.entries(actors).map(([name, descriptor]) => [
            name,
            {
                get: (actorId: string) => {
                    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(actorId)) throw new Error("invalid actor ID")
                    return new ActorConnection(
                        { actorType: descriptor.actorType, actorId },
                        descriptor,
                        options,
                        dependencies
                    )
                }
            }
        ])
    ) as { readonly [Name in keyof Actors]: { get(actorId: string): ConnectionOf<Actors[Name]> } }
}

export { createClient }
