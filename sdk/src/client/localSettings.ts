import { readFileSync } from "node:fs"

function readLocalSettings(): LocalSettings {
    try {
        return JSON.parse(readFileSync(".little-actors/runtime.json", "utf8"))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
        throw error
    }
}

interface LocalSettings {
    readonly controlPlaneUrl?: string
    readonly apiKey?: string
    readonly namespaceId?: string
}

export { readLocalSettings }
