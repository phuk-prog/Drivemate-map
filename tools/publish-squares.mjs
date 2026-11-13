// Publishes the square files built on this machine: compresses each .dmap to .dmap.gz and uploads
// it to the GitHub release of its latitude row (squares-lat<latIdx>, created when missing), because
// a release holds at most 1000 files. Squares of the regions.json squareAreas (Stockport, London)
// also go to maps-latest, where older app builds read them.
// Uses the gh command line tool, which reads its token from GH_TOKEN; the token is never printed.
// Usage: node tools/publish-squares.mjs [--dry-run]   (--dry-run prints the gh commands instead)

import { readFile, readdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SQUARES_DIR } from "./build-squares.mjs";
import { parseSquareId, squareRelease, squareBbox, squaresTouching, squareId } from "./grid.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY_RELEASE = "maps-latest";
const BATCH = 50;

export function releaseNotes(tag) {
  const latIdx = Number(tag.replace("squares-lat", ""));
  const [minLat, , maxLat] = squareBbox({ latIdx, lonIdx: 0 });
  return {
    title: `Drivemate map squares, latitude ${minLat.toFixed(2)} to ${maxLat.toFixed(2)}`,
    notes: `Map squares (0.05 degrees) whose southern edge is at latitude ${minLat.toFixed(2)}. ` +
      "Each file is named <squareId>.dmap.gz and is replaced when the square is rebuilt. Map data © OpenStreetMap contributors, ODbL.",
  };
}

// Groups square file names by the release they belong to: { tag: [names] }.
export function groupByRelease(names) {
  const groups = {};
  for (const name of names) {
    const sq = parseSquareId(name.replace(/\.dmap(\.gz)?$/, ""));
    if (!sq) continue;
    (groups[squareRelease(sq)] ??= []).push(name);
  }
  return groups;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const gh = (args) => {
    if (dryRun) {
      console.log(`gh ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
      return "";
    }
    for (let attempt = 1; ; attempt++) {
      try {
        return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
      } catch (err) {
        if (attempt >= 3) throw err;
        console.log(`gh ${args[0]} ${args[1]} failed, retrying (${attempt})`);
        execFileSync("sleep", [String(10 * attempt)]);
      }
    }
  };

  const plain = (await readdir(SQUARES_DIR)).filter((f) => /^lat-?\d+_lon-?\d+\.dmap$/.test(f)).sort();
  if (plain.length === 0) {
    console.log("No square files were built on this run. Nothing to publish.");
    return;
  }
  for (const f of plain) await writeFile(join(SQUARES_DIR, `${f}.gz`), gzipSync(await readFile(join(SQUARES_DIR, f)), { level: 9 }));
  const files = plain.map((f) => `${f}.gz`);
  const groups = groupByRelease(files);

  const existing = new Set(dryRun ? [] : gh(["release", "list", "--limit", "1000", "--json", "tagName", "--jq", ".[].tagName"]).split("\n").filter(Boolean));
  for (const [tag, names] of Object.entries(groups)) {
    if (!existing.has(tag)) {
      const { title, notes } = releaseNotes(tag);
      gh(["release", "create", tag, "--title", title, "--notes", notes, "--latest=false"]);
    }
    for (let i = 0; i < names.length; i += BATCH) {
      gh(["release", "upload", tag, ...names.slice(i, i + BATCH).map((n) => join(SQUARES_DIR, n)), "--clobber"]);
    }
    console.log(`${tag}: ${names.length} square(s) uploaded`);
  }

  // Stockport and London squares stay in maps-latest too, for older app builds.
  const config = JSON.parse(await readFile(join(ROOT, "regions.json"), "utf8"));
  const legacy = new Set();
  for (const area of config.squareAreas ?? []) {
    const [minLon, minLat, maxLon, maxLat] = area.bbox;
    for (const sq of squaresTouching([minLat, minLon, maxLat, maxLon])) legacy.add(`${squareId(sq)}.dmap.gz`);
  }
  const legacyFiles = files.filter((f) => legacy.has(f));
  if (legacyFiles.length) {
    if (!dryRun && !existing.has(LEGACY_RELEASE)) {
      gh(["release", "create", LEGACY_RELEASE, "--title", "Drivemate map regions (latest)",
        "--notes", "Automatically updated map regions. Each file replaces the previous version.", "--latest=false"]);
    }
    for (let i = 0; i < legacyFiles.length; i += BATCH) {
      gh(["release", "upload", LEGACY_RELEASE, ...legacyFiles.slice(i, i + BATCH).map((n) => join(SQUARES_DIR, n)), "--clobber"]);
    }
    console.log(`${LEGACY_RELEASE}: ${legacyFiles.length} Stockport/London square(s) uploaded`);
  }
  console.log(`published ${files.length} square file(s) to ${Object.keys(groups).length} row release(s)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
