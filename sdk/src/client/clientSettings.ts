import { z } from "zod"

import { ActorConfigurationError } from "../errors.js"

function configuredSettings(options: unknown) {
    const result = clientOptionsSchema.safeParse(options)
    if (!result.success)
        throw new ActorConfigurationError(`durable-object client settings are invalid: ${result.error.message}`)
    const controlPlaneUrl = validateOrigin(result.data.controlPlaneUrl)
    return {
        credential: (result.data.apiKey ?? result.data.token)!,
        namespaceId: result.data.namespaceId,
        controlPlaneUrl,
        socketGatewayUrl: validateOrigin(result.data.socketGatewayUrl ?? controlPlaneUrl)
    }
}

function validateOrigin(origin: string): string {
    let url: URL
    try {
        url = new URL(origin)
    } catch (error) {
        throw new ActorConfigurationError(`actor HTTP origin is invalid: ${origin}`, { cause: error })
    }
    if (
        !/^https?:$/u.test(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
    ) {
        throw new ActorConfigurationError(`actor control-plane URL must be an HTTP or HTTPS origin: ${origin}`)
    }
    return url.origin
}

const clientOptionsSchema = z
    .object({
        apiKey: z.string().trim().min(1).optional(),
        token: z.string().trim().min(1).optional(),
        namespaceId: z
            .string()
            .regex(/^[A-Za-z0-9._-]+$/u)
            .optional(),
        controlPlaneUrl: z.string().url(),
        socketGatewayUrl: z.string().url().optional()
    })
    .refine(
        settings => (settings.apiKey === undefined) !== (settings.token === undefined),
        "Configure exactly one of apiKey or token"
    )

export { configuredSettings }
