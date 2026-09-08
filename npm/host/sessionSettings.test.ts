import assert from "node:assert/strict"
import { test } from "node:test"

import { ActorConfigurationError } from "../shared/errors.js"

import { ActorSessionSettings } from "./session.js"

test("a managed socket needs no local actor credentials", () => {
    const settings = ActorSessionSettings.fromEnvironment({
        LAC_EXECUTOR_SOCKET: "/tmp/actor.sock",
        LAC_ENTRYPOINT: "src/custom-actors.ts"
    })

    assert.equal(settings.socketPath, "/tmp/actor.sock")
    assert.equal(settings.actorEntrypoint, "src/custom-actors.ts")
    assert.equal(settings.startupTimeoutMs, 10_000)
    assert.equal(settings.actorIdleTimeoutMs, 60_000)
})

test("resident actor idle timeout is configurable and bounded", () => {
    assert.equal(
        ActorSessionSettings.fromEnvironment({
            LAC_EXECUTOR_SOCKET: "/tmp/actor.sock",
            LAC_ACTOR_IDLE_TIMEOUT_MS: "2500"
        }).actorIdleTimeoutMs,
        2_500
    )
    for (const value of ["0", "86400001", "not-a-number"]) {
        assert.throws(
            () =>
                ActorSessionSettings.fromEnvironment({
                    LAC_EXECUTOR_SOCKET: "/tmp/actor.sock",
                    LAC_ACTOR_IDLE_TIMEOUT_MS: value
                }),
            ActorConfigurationError
        )
    }
})

test("actor-host startup timeout is configurable and bounded", () => {
    assert.equal(
        ActorSessionSettings.fromEnvironment({
            LAC_EXECUTOR_SOCKET: "/tmp/actor.sock",
            LAC_HOST_STARTUP_MS: "2500"
        }).startupTimeoutMs,
        2_500
    )
    assert.throws(
        () =>
            ActorSessionSettings.fromEnvironment({
                LAC_EXECUTOR_SOCKET: "/tmp/actor.sock",
                LAC_HOST_STARTUP_MS: "0"
            }),
        ActorConfigurationError
    )
})

test("actor-host settings require a private session socket", () => {
    assert.throws(() => ActorSessionSettings.fromEnvironment({}), ActorConfigurationError)
})
