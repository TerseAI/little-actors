import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import type { SocketContract } from "../wire/contract.js"

import { generateTypeScript } from "./typescript-generator.js"

async function generateClient(contracts: readonly SocketContract[], directory: string): Promise<void> {
    const artifacts = await generateTypeScript(contracts)
    await mkdir(directory, { recursive: true })
    for (const [file, contents] of artifacts) await writeFile(path.join(directory, file), contents)
}

export { generateClient }
