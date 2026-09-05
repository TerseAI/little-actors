import assert from "node:assert/strict"
import test from "node:test"

import { diagnoseBottleneck, eventMark, summarizeGcpEntries, summarizeModalLogs, summarizeTimeline } from "./websocket-streaming-lab.mjs"

test("summarizeTimeline separates startup latency from stream cadence", () => {
    const summary = summarizeTimeline([
        { name: "websocket_connecting", atMs: 500 },
        { name: "actor_socket_ready", atMs: 900 },
        { name: "prompt_sent", atMs: 1_000 },
        { name: "prompt_accepted", atMs: 1_020 },
        { name: "generation_started", atMs: 1_200 },
        { name: "text_delta", atMs: 1_900, characters: 2 },
        { name: "text_delta", atMs: 1_930, characters: 3 },
        { name: "text_delta", atMs: 2_500, characters: 1 },
        { name: "generation_completed", atMs: 2_600 }
    ])

    assert.equal(summary.socketToActorReadyMs, 400)
    assert.equal(summary.promptAcceptedMs, 20)
    assert.equal(summary.promptToGenerationMs, 200)
    assert.equal(summary.timeToFirstTextMs, 900)
    assert.equal(summary.generationToFirstTextMs, 700)
    assert.equal(summary.streamDurationMs, 700)
    assert.equal(summary.completionTailMs, 100)
    assert.equal(summary.textDeltaCount, 3)
    assert.equal(summary.textCharacters, 6)
    assert.equal(summary.invalidTextDeltaCount, 0)
    assert.deepEqual(summary.interDeltaGapMs, {
        min: 30,
        mean: 300,
        p50: 30,
        p95: 570,
        p99: 570,
        max: 570
    })
})

test("eventMark preserves malformed Buffer-shaped text deltas as diagnostics", () => {
    const mark = eventMark({
        type: "text_delta",
        generationId: "generation-1",
        delta: { type: "Buffer", data: [104, 105] }
    })

    assert.equal(mark.validDelta, false)
    assert.equal(mark.receivedType, "buffer_json")
    assert.equal(mark.characters, 2)
    assert.equal(mark.bytes, 2)
})

test("summarizeGcpEntries reports control-plane and socket-effect latency", () => {
    const entries = [
        requestEntry("/socket-effects", "0.010s"),
        requestEntry("/socket-effects", "0.020s"),
        requestEntry("/durable_object.v1.ActorControlPlaneService/Execute", "0.100s"),
        { jsonPayload: { event: "actor_socket_message_committed" } }
    ]

    const summary = summarizeGcpEntries(entries, 3)

    assert.equal(summary.socketEffects.count, 2)
    assert.equal(summary.socketEffects.latencyMs.p50, 10)
    assert.equal(summary.socketEffects.latencyMs.p95, 20)
    assert.equal(summary.socketEffects.expectedMinimum, 3)
    assert.equal(summary.socketEffects.captureComplete, false)
    assert.equal(summary.actorExecute.count, 1)
    assert.equal(summary.actorExecute.latencyMs.max, 100)
    assert.equal(summary.socketMessagesCommitted, 1)
})

test("summarizeModalLogs groups actor work and durable writes", () => {
    const logs = [
        modalLine({ event: "actor_host_invocation", method: "onMessage", completed_at_ms: 253 }),
        modalLine({ event: "actor_host_invocation", method: "checkpointOutput", completed_at_ms: 197 }),
        modalLine({ event: "actor_host_invocation", method: "finish", completed_at_ms: 190 }),
        modalLine({ event: "actor_state_write", completed_at_ms: 248 }),
        "unstructured runtime output"
    ].join("\n")

    const summary = summarizeModalLogs(logs)

    assert.deepEqual(summary.invocations.onMessage, { count: 1, latencyMs: metric(253) })
    assert.deepEqual(summary.invocations.checkpointOutput, { count: 1, latencyMs: metric(197) })
    assert.equal(summary.stateWrites.count, 1)
    assert.equal(summary.stateWrites.latencyMs.max, 248)
})

test("diagnoseBottleneck identifies first-token startup as the dominant wait", () => {
    const diagnosis = diagnoseBottleneck(
        {
            promptToGenerationMs: 220,
            generationToFirstTextMs: 6_200,
            completionTailMs: 80,
            invalidTextDeltaCount: 0,
            interDeltaGapMs: { min: 8, mean: 18, p50: 12, p95: 35, p99: 60, max: 80 }
        },
        { socketEffects: { count: 40, latencyMs: metric(2) } }
    )

    assert.equal(diagnosis.bottleneck, "workflow_or_model_start")
    assert.match(diagnosis.explanation, /6,200 ms/)
})

test("diagnoseBottleneck does not blame a fast gateway for chunk stalls", () => {
    const diagnosis = diagnoseBottleneck(
        {
            promptToGenerationMs: 100,
            generationToFirstTextMs: 180,
            completionTailMs: 40,
            invalidTextDeltaCount: 0,
            interDeltaGapMs: { min: 10, mean: 90, p50: 20, p95: 600, p99: 900, max: 1_000 }
        },
        { socketEffects: { count: 20, latencyMs: metric(3) } }
    )

    assert.equal(diagnosis.bottleneck, "workflow_or_model_chunking")
})

test("diagnoseBottleneck prioritizes malformed deltas", () => {
    const diagnosis = diagnoseBottleneck(
        {
            promptToGenerationMs: 100,
            generationToFirstTextMs: 180,
            completionTailMs: 40,
            invalidTextDeltaCount: 12,
            interDeltaGapMs: { min: 10, mean: 20, p50: 15, p95: 30, p99: 40, max: 50 }
        },
        { socketEffects: { count: 12, latencyMs: metric(3) } }
    )

    assert.equal(diagnosis.bottleneck, "invalid_delta_protocol")
    assert.match(diagnosis.explanation, /12 text_delta events/)
})

function requestEntry(path, latency) {
    return { httpRequest: { requestUrl: `https://example.test${path}`, latency } }
}

function modalLine(payload) {
    return `2026-09-04 17:39:55-04:00 ${JSON.stringify(payload)}`
}

function metric(value) {
    return { min: value, mean: value, p50: value, p95: value, p99: value, max: value }
}
