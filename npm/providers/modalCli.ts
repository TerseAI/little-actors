#!/usr/bin/env node
import { stdin, stdout } from "node:process"

import { runProviderCommand } from "./commandProcess.js"

runProviderCommand(stdin, stdout, async () => {
    const { ModalSandboxProvider } = await import("./modal.js")
    return new ModalSandboxProvider()
}).then(
    // SDK connections can keep the process alive after its reply has been flushed.
    () => process.exit(0),
    error => process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`, () => process.exit(1))
)
