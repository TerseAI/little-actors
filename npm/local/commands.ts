import { Command, InvalidArgumentError, Option } from "commander"

export interface DevOptions {
    port: number
    project: string
    entrypoint: string
    storage: "local" | "gcs"
    dataDir?: string
}

interface CliActions {
    dev(options: DevOptions): Promise<void>
    run(script: string, args: string[], options: { dataDir: string }): Promise<void>
    token(options: { dataDir: string }): Promise<void>
    start(): Promise<void>
}

export class LocalCli {
    constructor(private readonly actions: CliActions) {}

    program(version: string): Command {
        const program = new Command().name("lac").description("Run durable TypeScript actors locally or in the cloud").version(version).enablePositionalOptions().showHelpAfterError()
        program
            .command("dev")
            .description("Start local actors with automatic SQLite and file storage")
            .option("--project <directory>", "actor project directory", ".")
            .option("--port <number>", "loopback port (0 selects a free port)", portNumber, 7100)
            .option("--entrypoint <file>", "actor source file, relative to the project", "src/actors.ts")
            .option("--data-dir <directory>", "state directory (default: <project>/.little-actors)")
            .addOption(new Option("--storage <backend>", "where to save actor snapshots").choices(["local", "gcs"]).default("local"))
            .action(options => this.actions.dev(options))
        program
            .command("run <script> [args...]")
            .description("Run a TypeScript client with credentials from the local runtime")
            .option("--data-dir <directory>", "runtime state directory", ".little-actors")
            .passThroughOptions()
            .action((script, args, options) => this.actions.run(script, args, options))
        program
            .command("token")
            .description("Print a one-hour local session token for tools such as wscat")
            .option("--data-dir <directory>", "runtime state directory", ".little-actors")
            .action(options => this.actions.token(options))
        program
            .command("start")
            .description("Start the packaged runtime using your self-hosting environment settings")
            .action(() => this.actions.start())
        program.action(() => {
            program.help()
        })
        return program
    }
}

function portNumber(value: string): number {
    const port = Number(value)
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(port) || port < 0 || port > 65535) throw new InvalidArgumentError("Port must be an integer from 0 to 65535.")
    return port
}
