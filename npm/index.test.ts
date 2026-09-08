import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { test } from "node:test"

import * as api from "./index.js"

test("importing actor definitions does not load remote transports or TypeScript tooling", () => {
    const entrypoint = new URL("./index.js", import.meta.url).href
    execFileSync(process.execPath, [
        "--input-type=module",
        "--eval",
        `
        import { register } from "node:module";
        register("data:text/javascript," + encodeURIComponent(\`export function resolve(specifier, context, next) {
            if (/^(?:@grpc\\\\/|protobufjs$|ws$|tsx\\\\/)/.test(specifier)) throw new Error("eager dependency: " + specifier);
            return next(specifier, context);
        }\`));
        await import(${JSON.stringify(entrypoint)});
    `
    ])
})

test("the package root exposes the complete minimal actor API", () => {
    assert.deepEqual(Object.keys(api).sort(), ["Actor", "ActorInvocationError"])
})

test("actor calls read environment settings lazily without a setup function", () => {
    const entrypoint = new URL("./index.js", import.meta.url).href
    for (const socketGatewayUrl of [undefined, "https://sockets.example.com"]) {
        execFileSync(process.execPath, [
            "--input-type=module",
            "--eval",
            `
            import assert from "node:assert/strict";
            for (const key of ["LAC_TOKEN", "LAC_NAMESPACE_ID", "LAC_CONTROL_PLANE_URL", "LAC_SOCKET_GATEWAY_URL"]) delete process.env[key];
            const { Actor, ActorInvocationError } = await import(${JSON.stringify(entrypoint)});
            Object.assign(process.env, {
                LAC_TOKEN: "workflow-token",
                LAC_NAMESPACE_ID: "project-1",
                LAC_CONTROL_PLANE_URL: "https://control.example.com"
            });
            const socketGatewayUrl = ${JSON.stringify(socketGatewayUrl) ?? "undefined"};
            if (socketGatewayUrl) process.env.LAC_SOCKET_GATEWAY_URL = socketGatewayUrl;
            const requests = [];
            globalThis.fetch = async (url, options) => {
                assert.equal(options.headers.authorization, "Bearer workflow-token");
                requests.push(url);
                return new Response("{}", { status: url.endsWith("/target") ? 401 : 200 });
            };
            class Counter extends Actor { async increment() { return 1; } }
            const counter = Counter.get("one");
            await assert.rejects(counter.increment(), error => error instanceof ActorInvocationError && error.code === "unauthenticated");
            await counter.broadcast("hello");
            assert.deepEqual(requests, [
                "https://control.example.com/v1/namespaces/project-1/actors/Counter/one/target",
                (socketGatewayUrl ?? "https://control.example.com") + "/v1/namespaces/project-1/actors/Counter/one/socket-effects"
            ]);
        `
        ])
    }
})
