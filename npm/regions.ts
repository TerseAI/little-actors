const canonicalRegionPattern = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u

interface ModalPlacement {
    readonly regions: readonly string[]
    readonly cloud?: string
    readonly privateNetwork?: boolean
}

interface RegionDefinition {
    readonly modal: ModalPlacement
}

type CanonicalRegionCatalog = Readonly<Record<string, RegionDefinition>>

const recommendedRegionCatalog = {
    "north-america-east": {
        modal: { regions: ["us-east"], cloud: "gcp" }
    },
    "north-america-central": {
        modal: { regions: ["us-central"], cloud: "gcp" }
    },
    "north-america-south": {
        modal: { regions: ["us-south"], cloud: "gcp" }
    },
    "north-america-west": {
        modal: { regions: ["us-west"], cloud: "gcp" }
    },
    "europe-west": {
        modal: { regions: ["eu-west"], cloud: "gcp" }
    },
    "asia-southeast": {
        modal: { regions: ["ap-southeast"], cloud: "gcp" }
    }
} as const satisfies CanonicalRegionCatalog

function modalPlacement(region: string, catalog: CanonicalRegionCatalog = recommendedRegionCatalog): ModalPlacement {
    const placement = catalog[validateCanonicalRegion(region)]?.modal
    if (!placement) throw new Error(`canonical region ${JSON.stringify(region)} has no Modal placement`)
    return placement
}

function validateCanonicalRegion(value: string): string {
    if (!canonicalRegionPattern.test(value)) throw new Error(`invalid canonical region ${JSON.stringify(value)}`)
    return value
}

export { modalPlacement, recommendedRegionCatalog, validateCanonicalRegion }
export type { CanonicalRegionCatalog, ModalPlacement, RegionDefinition }
