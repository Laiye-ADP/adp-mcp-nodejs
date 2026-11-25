import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist");
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ["src/*.ts"],
  outdir: dist,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node20",
  // Modules read ../catalog and ../package.json relative to import.meta.url.
  chunkNames: "chunk-[hash]",
  metafile: true,
  write: false
});

// Ship the original license notices for dependencies included in the JS bundle.
const packageDirs = new Set();
for (const input of Object.keys(bundle.metafile.inputs)) {
  const match = input.match(/^(.*\bnode_modules\/(?:@[^/]+\/)?[^/]+)\//);
  if (match) packageDirs.add(match[1]);
}
const notices = [];
for (const dir of [...packageDirs].sort()) {
  const packageDir = join(root, dir);
  const { name, version } = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  const files = (await readdir(packageDir)).filter(file => /^(licen[cs]e|copying|notice)(\..*)?$/i.test(file)).sort();
  if (!files.length) throw new Error(`Missing license text for ${name}@${version}`);
  const texts = await Promise.all(files.map(file => readFile(join(packageDir, file), "utf8")));
  notices.push([`${name}@${version}`, ...texts].join("\n\n"));
}

// dist is generated; rebuilding must not publish obsolete chunks from an older build.
await rm(dist, { recursive: true, force: true });
await mkdir(dist);
for (const file of bundle.outputFiles) await writeFile(file.path, file.contents);
await writeFile(join(dist, "THIRD-PARTY-NOTICES.txt"), notices.join("\n\n"));
