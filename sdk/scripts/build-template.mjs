import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const source = new URL("../../examples/chat/", import.meta.url)
const destination = new URL("../dist/templates/chat/", import.meta.url)
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))

await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
for (const file of ["package.json", "tsconfig.json", "index.html", "README.md", "src"])
    await cp(new URL(file, source), new URL(file, destination), {
        recursive: true,
        filter: file => !["generated", "node_modules", ".little-actors", "dist"].includes(path.basename(file))
    })
// npm excludes .gitignore; init restores its name after copying the template.
await copyFile(new URL(".gitignore", source), new URL("gitignore", destination))
await copyFile(new URL("../../LICENSE.md", import.meta.url), new URL("LICENSE.md", destination))
const metadata = JSON.parse(await readFile(new URL("package.json", destination), "utf8"))
metadata.dependencies["little-actors"] = version
await writeFile(new URL("package.json", destination), JSON.stringify(metadata, null, 4) + "\n")
