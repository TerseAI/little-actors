import { Ajv } from "ajv"
import standaloneCode from "ajv/dist/standalone/index.js"
import { build } from "esbuild"
import { compile } from "json-schema-to-typescript"
import type { JSONSchema } from "json-schema-to-typescript"
import { fileURLToPath } from "node:url"

import type { SocketContract } from "../wire/contract.js"

async function generateTypeScript(contracts: readonly SocketContract[]): Promise<ReadonlyMap<string, string>> {
    const artifacts = new Map<string, string>()
    for (const contract of contracts) {
        if (!/^[A-Za-z_$][\w$]*$/u.test(contract.actorType))
            throw new Error(`actor name ${contract.actorType} cannot be emitted as a TypeScript identifier`)
        for (const [file, contents] of await actorFiles(contract)) artifacts.set(file, contents)
        for (const [file, contents] of await proxyFiles(contract)) artifacts.set(file, contents)
    }
    artifacts.set("index.ts", clientIndex(contracts))
    artifacts.set("proxy.ts", proxyIndex(contracts))
    return artifacts
}

async function actorFiles(contract: SocketContract): Promise<[string, string][]> {
    const name = contract.actorType
    const kinds = ["Incoming", "Outgoing", "State"]
    const declarations = await wireDeclarations(contract, kinds)
    const fields = contract.emittable.map(field => JSON.stringify(field)).join(" | ") || "never"
    const validators = validatorBinding(name, declarations)
    const source = `import * as ${validators} from "./${name}.validators.js"\n\n${declarations}\nexport const ${name}: import("little-actors/browser").ActorDescriptor<ActorTypes["incoming"], ActorTypes["outgoing"], ActorTypes["state"], ${fields}> = {\n    actorType: ${JSON.stringify(name)},\n    emittable: ${JSON.stringify(contract.emittable)},\n    validators: ${validators}\n}\n`
    return [
        [`${name}.actor.ts`, source],
        [`${name}.validators.js`, await validatorsSource(contract, kinds)],
        [`${name}.validators.d.ts`, validatorDeclarations(kinds)]
    ]
}

async function proxyFiles(contract: SocketContract): Promise<[string, string][]> {
    const name = contract.actorType
    const kinds = ["Metadata"]
    const declarations = await wireDeclarations(contract, kinds)
    const validators = validatorBinding(name, declarations)
    const source = `import * as ${validators} from "./${name}.proxy-validators.js"\n\n${declarations}\nexport const ${name}: import("little-actors/proxy").ProxyActor<ActorTypes["metadata"]> = { metadata: ${validators}.metadata }\n`
    return [
        [`${name}.proxy.ts`, source],
        [`${name}.proxy-validators.js`, await validatorsSource(contract, kinds)],
        [`${name}.proxy-validators.d.ts`, validatorDeclarations(kinds)]
    ]
}

async function wireDeclarations(contract: SocketContract, kinds: readonly string[]): Promise<string> {
    const properties = Object.fromEntries(
        kinds.map(kind => [
            kind.toLowerCase(),
            typeof contract.schema.definitions?.[kind] === "boolean"
                ? contract.schema.definitions[kind]
                : { $ref: `#/definitions/${kind}` }
        ])
    )
    return compile(
        {
            ...contract.schema,
            type: "object",
            additionalProperties: false,
            properties,
            required: Object.keys(properties)
        } as JSONSchema,
        "ActorTypes",
        { bannerComment: "", unknownAny: true, additionalProperties: false }
    )
}

function validatorBinding(name: string, declarations: string): string {
    let validators = `${name}Validators`
    while (declarations.includes(validators)) validators = `_${validators}`
    return validators
}

function validatorDeclarations(kinds: readonly string[]): string {
    return (
        kinds.map(kind => `export declare const ${kind.toLowerCase()}: (value: unknown) => boolean`).join("\n") + "\n"
    )
}

async function validatorsSource(contract: SocketContract, kinds: readonly string[]): Promise<string> {
    const ajv = new Ajv({ strict: false, validateFormats: false, code: { source: true, esm: true } })
    ajv.addSchema({ ...contract.schema, $id: "actor-contract" })
    const source = standaloneCode.default(
        ajv,
        Object.fromEntries(kinds.map(kind => [kind.toLowerCase(), `actor-contract#/definitions/${kind}`]))
    )
    const result = await build({
        stdin: { contents: source, resolveDir: fileURLToPath(new URL("../../", import.meta.url)), loader: "js" },
        bundle: true,
        platform: "browser",
        format: "esm",
        write: false,
        minify: true,
        logLevel: "silent"
    })
    return result.outputFiles[0]!.text
}

function clientIndex(contracts: readonly SocketContract[]): string {
    const { imports, actors } = actorImports(contracts, "actor")
    return `import { createClient } from "little-actors/browser"\nimport type { ClientOptions } from "little-actors/browser"\n${imports}\n\nexport function ActorClient(options: ClientOptions) {\n    return createClient({ ${actors} }, options)\n}\n`
}

function proxyIndex(contracts: readonly SocketContract[]): string {
    const { imports, actors } = actorImports(contracts, "proxy")
    return `import { SocketProxy } from "little-actors/proxy"
import type { SocketAuthorization, SocketProxyDependencies, SocketProxyOptions } from "little-actors/proxy"
${imports}

const actors = { ${actors} }
export type ActorAuthorization = SocketAuthorization<typeof actors>

export class ActorProxy extends SocketProxy<typeof actors> {
    constructor(options: SocketProxyOptions = {}, dependencies: SocketProxyDependencies = {}) {
        super(actors, options, dependencies)
    }

    static handle(request: Request, authorization: ActorAuthorization, options: SocketProxyOptions = {}): Promise<Response> {
        return new ActorProxy(options).handle(request, authorization)
    }
}
`
}

function actorImports(contracts: readonly SocketContract[], suffix: string) {
    const imports = contracts
        .map(({ actorType }, index) => `import { ${actorType} as actor${index} } from "./${actorType}.${suffix}.js"`)
        .join("\n")
    const actors = contracts.map(({ actorType }, index) => `[${JSON.stringify(actorType)}]: actor${index}`).join(", ")
    return { imports, actors }
}

export { generateTypeScript }
