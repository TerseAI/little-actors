import assert from "node:assert/strict"
import { test } from "node:test"

import { modalPlacement } from "./regions.js"

test("canonical regions map Modal placement", () => {
    assert.deepEqual(modalPlacement("north-america-east"), {
        regions: ["us-east"],
        cloud: "gcp"
    })
})

for (const [region, pool] of [
    ["north-america-central", "us-central"],
    ["north-america-west", "us-west"]
] as const) {
    test(`${region} uses a broad GCP pool with public routing`, () => {
        assert.deepEqual(modalPlacement(region), {
            regions: [pool],
            cloud: "gcp"
        })
    })
}

test("an unknown canonical region has no Modal placement", () => {
    assert.throws(() => modalPlacement("unconfigured"), /has no Modal placement/u)
})
