import { z } from "zod"

import { ActorConfigurationError } from "../errors.js"

function parseHostSettings(environment: NodeJS.ProcessEnv) {
    const result = actorSessionSettingsSchema.safeParse(environment)
    if (!result.success)
        throw new ActorConfigurationError(`actor-host session settings are invalid: ${result.error.message}`)
    return {
        socketPath: result.data.DURABLE_OBJECT_EXECUTOR_SOCKET,
        actorEntrypoint: result.data.DURABLE_OBJECT_ENTRYPOINT,
        startupTimeoutMs: parseStartupTimeout(environment.DURABLE_OBJECT_HOST_STARTUP_MS),
        actorIdleTimeoutMs: parseActorIdleTimeout(environment.DURABLE_OBJECT_ACTOR_IDLE_TIMEOUT_MS)
    }
}

function parseStartupTimeout(value: string | undefined): number {
    if (value === undefined) return DEFAULT_ACTOR_STARTUP_TIMEOUT_MS
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed <= 0)
        throw new ActorConfigurationError("DURABLE_OBJECT_HOST_STARTUP_MS must be a positive integer")
    return parsed
}

function parseActorIdleTimeout(value: string | undefined): number {
    if (value === undefined) return DEFAULT_ACTOR_IDLE_TIMEOUT_MS
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_IDLE_TIMEOUT_MS) {
        throw new ActorConfigurationError(
            `DURABLE_OBJECT_ACTOR_IDLE_TIMEOUT_MS must be an integer between 1 and ${MAX_IDLE_TIMEOUT_MS}`
        )
    }
    return parsed
}

const DEFAULT_ACTOR_STARTUP_TIMEOUT_MS = 10_000
const DEFAULT_ACTOR_IDLE_TIMEOUT_MS = 60_000
const MAX_IDLE_TIMEOUT_MS = 86_400_000

const actorSessionSettingsSchema = z.object({
    DURABLE_OBJECT_EXECUTOR_SOCKET: z.string().trim().min(1),
    DURABLE_OBJECT_ENTRYPOINT: z.string().trim().min(1).optional()
})

export { parseHostSettings, DEFAULT_ACTOR_IDLE_TIMEOUT_MS }
