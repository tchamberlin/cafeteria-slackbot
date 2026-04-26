import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

export async function loadBundle(entryPath) {
  const built = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  const dir = mkdtempSync(join(tmpdir(), "cafeteria-bundle-"));
  const out = join(dir, "bundle.mjs");
  writeFileSync(out, built.outputFiles[0].contents);
  return import(pathToFileURL(out).href);
}
