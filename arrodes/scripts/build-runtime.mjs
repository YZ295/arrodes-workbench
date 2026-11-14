import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));

export async function buildRuntime(output) {
  await build({
    entryPoints: [resolve(root, "apps/server/src/collab/runtime.ts")],
    outfile: output,
    alias: { "@aew/contracts": resolve(root, "packages/contracts/src/errors.ts") },
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildRuntime(resolve(root, "arrodes/agent/collab-runtime.mjs"));
}
