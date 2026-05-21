#!/usr/bin/env node
/**
 * recover-ollama-gguf.js
 *
 * Recovers usable GGUF model files from Ollama blob storage based on
 * manifest files that were copied into Project Nana's models/ folder.
 *
 * Strategy:
 *   1. Scan models/ for Ollama-style manifest JSON files
 *   2. Parse each manifest to extract model-layer blob digests
 *   3. Look up blobs in both:
 *      a. The local models/ subfolder (if blobs were moved here)
 *      b. The Ollama default blob storage (~/.ollama/models/blobs/)
 *   4. Verify each blob starts with the GGUF magic bytes ("GGUF")
 *   5. Copy verified blobs as clean .gguf files
 *
 * Safety:
 *   - NEVER deletes or moves any file
 *   - Skips copy if destination .gguf already exists and matches size
 *   - Works with Windows paths containing spaces
 *   - Reports everything it does
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// ── Paths ─────────────────────────────────────────────────────────────────────
const PROJECT_ROOT = path.resolve(__dirname, "..");
const MODELS_DIR = path.join(PROJECT_ROOT, "models");
const OLLAMA_BLOBS_DIR = path.join(os.homedir(), ".ollama", "models", "blobs");

// GGUF magic: first 4 bytes = 0x47 0x47 0x55 0x46 = "GGUF"
const GGUF_MAGIC = Buffer.from("GGUF", "ascii");
const MIN_GGUF_SIZE = 100 * 1024 * 1024; // 100 MB minimum for a real model

// ── Report ────────────────────────────────────────────────────────────────────
const report = {
  inspected: [],
  manifests: [],
  ggufBlobsFound: [],
  ggufFilesCopied: [],
  skipped: [],
  errors: [],
  warnings: [],
};

function log(msg) {
  console.log(`  ${msg}`);
}
function header(msg) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${msg}`);
  console.log(`${"─".repeat(60)}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Read first N bytes of a file.
 */
function readFirstBytes(filePath, n) {
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(n);
  const bytesRead = fs.readSync(fd, buf, 0, n, 0);
  fs.closeSync(fd);
  return buf.slice(0, bytesRead);
}

/**
 * Check if a file starts with the GGUF magic bytes.
 */
function isGGUF(filePath) {
  try {
    const head = readFirstBytes(filePath, 4);
    return head.length >= 4 && head.compare(GGUF_MAGIC) === 0;
  } catch {
    return false;
  }
}

/**
 * Try to parse a file as an Ollama manifest JSON.
 */
function tryParseManifest(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const obj = JSON.parse(raw);
    if (
      obj.schemaVersion &&
      obj.layers &&
      Array.isArray(obj.layers)
    ) {
      return obj;
    }
  } catch {
    // Not a manifest
  }
  return null;
}

/**
 * Given a sha256 digest like "sha256:abcdef...", find the blob file.
 * Checks both the local model subfolder and Ollama's blob storage.
 */
function findBlobFile(digest, localDir) {
  // Ollama stores blobs as "sha256-<hash>" (dash, not colon)
  const blobName = digest.replace(":", "-");

  // 1. Check inside the local model folder (in case blobs were moved there)
  const localCandidates = [];
  if (localDir) {
    localCandidates.push(path.join(localDir, blobName));
    localCandidates.push(path.join(localDir, "blobs", blobName));
    // Also check for the raw hash without prefix
    const hashOnly = digest.split(":")[1];
    if (hashOnly) {
      localCandidates.push(path.join(localDir, hashOnly));
      localCandidates.push(path.join(localDir, "blobs", hashOnly));
    }
  }

  for (const candidate of localCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // 2. Check in Ollama's default blob storage
  const ollamaBlob = path.join(OLLAMA_BLOBS_DIR, blobName);
  if (fs.existsSync(ollamaBlob)) {
    return ollamaBlob;
  }

  return null;
}

/**
 * Recursively find all files in a directory.
 */
function walkDir(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Format bytes to human-readable.
 */
function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }
  if (bytes >= 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }
  if (bytes >= 1024) {
    return (bytes / 1024).toFixed(1) + " KB";
  }
  return bytes + " B";
}

// ── Main Recovery ─────────────────────────────────────────────────────────────

function recoverFromManifests() {
  header("PHASE 1: Scanning for Ollama manifests");

  if (!fs.existsSync(MODELS_DIR)) {
    log("⚠ Models directory not found: " + MODELS_DIR);
    report.errors.push("Models directory not found");
    return;
  }

  // Get immediate subdirectories of models/
  const modelSubdirs = fs
    .readdirSync(MODELS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      name: d.name,
      path: path.join(MODELS_DIR, d.name),
    }));

  for (const subdir of modelSubdirs) {
    report.inspected.push(subdir.path);
    log(`📁 Inspecting: ${subdir.name}/`);

    // Find all files in this subdirectory
    const allFiles = walkDir(subdir.path);

    // Check for existing .gguf files
    const existingGGUF = allFiles.filter((f) =>
      f.toLowerCase().endsWith(".gguf")
    );
    if (existingGGUF.length > 0) {
      for (const g of existingGGUF) {
        log(`  ✓ Existing .gguf: ${path.basename(g)} (${formatSize(fs.statSync(g).size)})`);
      }
    }

    // Look for manifest files (JSON files without extension, or small files)
    for (const file of allFiles) {
      if (file.toLowerCase().endsWith(".gguf")) continue;

      const manifest = tryParseManifest(file);
      if (!manifest) continue;

      const relPath = path.relative(MODELS_DIR, file);
      log(`  📋 Found Ollama manifest: ${relPath}`);
      report.manifests.push({
        file: relPath,
        path: file,
        layers: manifest.layers.length,
      });

      // Extract model layers (the actual GGUF data)
      for (const layer of manifest.layers) {
        const mediaType = layer.mediaType || "";
        const digest = layer.digest || "";
        const size = layer.size || 0;

        if (mediaType === "application/vnd.ollama.image.model") {
          log(`  🔍 Model layer: ${digest.substring(0, 20)}... (${formatSize(size)})`);

          const blobPath = findBlobFile(digest, subdir.path);
          if (!blobPath) {
            log(`  ⚠ Blob NOT found for digest: ${digest.substring(0, 20)}...`);
            report.warnings.push(
              `Blob not found for ${subdir.name} model layer: ${digest}`
            );
            continue;
          }

          log(`  📦 Blob located: ${blobPath}`);

          // Verify GGUF magic
          if (!isGGUF(blobPath)) {
            log(`  ⚠ Blob does NOT have GGUF header — skipping`);
            report.warnings.push(
              `Blob ${path.basename(blobPath)} is not a valid GGUF file`
            );
            continue;
          }

          const actualSize = fs.statSync(blobPath).size;
          log(`  ✅ GGUF verified! Size: ${formatSize(actualSize)}`);
          report.ggufBlobsFound.push({
            model: subdir.name,
            blob: blobPath,
            size: actualSize,
            digest: digest,
          });

          // Determine output path
          const destName = `${subdir.name}.gguf`;
          const destPath = path.join(subdir.path, destName);

          // Copy if needed
          if (fs.existsSync(destPath)) {
            const existingSize = fs.statSync(destPath).size;
            if (existingSize === actualSize) {
              log(`  ⏭ ${destName} already exists with same size — skipping`);
              report.skipped.push({
                dest: destName,
                reason: "Already exists with matching size",
              });
              continue;
            } else {
              log(
                `  ⚠ ${destName} exists but size differs (${formatSize(existingSize)} vs ${formatSize(actualSize)}) — skipping (won't overwrite)`
              );
              report.skipped.push({
                dest: destName,
                reason: `Size mismatch: existing ${formatSize(existingSize)} vs blob ${formatSize(actualSize)}`,
              });
              continue;
            }
          }

          // Perform the copy
          log(`  📤 Copying to: ${destName} ...`);
          try {
            fs.copyFileSync(blobPath, destPath);
            const copiedSize = fs.statSync(destPath).size;
            log(`  ✅ Copied: ${destName} (${formatSize(copiedSize)})`);
            report.ggufFilesCopied.push({
              model: subdir.name,
              dest: destPath,
              size: copiedSize,
            });
          } catch (err) {
            log(`  ❌ Copy failed: ${err.message}`);
            report.errors.push(`Copy failed for ${destName}: ${err.message}`);
          }
        }

        // Handle projector layers (for vision models like minicpm-v)
        if (mediaType === "application/vnd.ollama.image.projector") {
          log(`  🔍 Projector layer: ${digest.substring(0, 20)}... (${formatSize(size)})`);

          const blobPath = findBlobFile(digest, subdir.path);
          if (!blobPath) {
            log(`  ⚠ Projector blob NOT found`);
            report.warnings.push(
              `Projector blob not found for ${subdir.name}: ${digest}`
            );
            continue;
          }

          // Projectors are not GGUF format typically, but copy anyway
          const projDest = path.join(subdir.path, `${subdir.name}-projector.bin`);
          if (fs.existsSync(projDest)) {
            log(`  ⏭ Projector already exists — skipping`);
            continue;
          }

          log(`  📤 Copying projector to: ${path.basename(projDest)} ...`);
          try {
            fs.copyFileSync(blobPath, projDest);
            log(`  ✅ Projector copied (${formatSize(fs.statSync(projDest).size)})`);
          } catch (err) {
            log(`  ⚠ Projector copy failed: ${err.message}`);
          }
        }
      }
    }
  }
}

function scanForLooseGGUF() {
  header("PHASE 2: Scanning for loose GGUF files (no manifest)");

  const allFiles = walkDir(MODELS_DIR);
  let found = 0;

  for (const file of allFiles) {
    // Skip files already in the report
    if (file.toLowerCase().endsWith(".gguf")) continue;
    if (file.toLowerCase().endsWith(".json")) continue;
    if (file.toLowerCase().endsWith(".bin")) continue;
    if (path.basename(file) === ".gitkeep") continue;

    // Check for manifest files (already handled)
    const manifest = tryParseManifest(file);
    if (manifest) continue;

    // Check file size — only look at files > 100MB
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.size < MIN_GGUF_SIZE) continue;

    // Check GGUF magic
    if (isGGUF(file)) {
      found++;
      const relPath = path.relative(MODELS_DIR, file);
      log(`  ✅ GGUF detected: ${relPath} (${formatSize(stat.size)})`);
      report.ggufBlobsFound.push({
        model: path.basename(path.dirname(file)),
        blob: file,
        size: stat.size,
        digest: "loose-file",
      });

      // Determine a clean name
      const dir = path.dirname(file);
      const modelName = path.basename(dir);
      const destName = `${modelName}.gguf`;
      const destPath = path.join(dir, destName);

      if (file === destPath) continue; // already named correctly
      if (fs.existsSync(destPath)) {
        log(`  ⏭ ${destName} already exists — skipping`);
        continue;
      }

      log(`  📤 Copying to: ${destName} ...`);
      try {
        fs.copyFileSync(file, destPath);
        log(`  ✅ Copied: ${destName} (${formatSize(fs.statSync(destPath).size)})`);
        report.ggufFilesCopied.push({
          model: modelName,
          dest: destPath,
          size: fs.statSync(destPath).size,
        });
      } catch (err) {
        log(`  ❌ Copy failed: ${err.message}`);
        report.errors.push(`Copy failed for ${destName}: ${err.message}`);
      }
    }
  }

  if (found === 0) {
    log("  No loose GGUF blobs found (all models handled via manifests).");
  }
}

function printReport() {
  header("RECOVERY REPORT");

  console.log("\n📁 Folders inspected:");
  for (const dir of report.inspected) {
    console.log(`   • ${path.relative(PROJECT_ROOT, dir)}`);
  }

  console.log("\n📋 Ollama manifests found:");
  if (report.manifests.length === 0) {
    console.log("   None");
  } else {
    for (const m of report.manifests) {
      console.log(`   • ${m.file} (${m.layers} layers)`);
    }
  }

  console.log("\n✅ GGUF blobs verified:");
  if (report.ggufBlobsFound.length === 0) {
    console.log("   None found");
  } else {
    for (const b of report.ggufBlobsFound) {
      console.log(`   • ${b.model}: ${formatSize(b.size)}`);
    }
  }

  console.log("\n📤 Clean .gguf files created:");
  if (report.ggufFilesCopied.length === 0) {
    console.log("   None (all may already exist or blobs were not found)");
  } else {
    for (const c of report.ggufFilesCopied) {
      console.log(
        `   • ${path.relative(MODELS_DIR, c.dest)} (${formatSize(c.size)})`
      );
    }
  }

  if (report.skipped.length > 0) {
    console.log("\n⏭ Skipped:");
    for (const s of report.skipped) {
      console.log(`   • ${s.dest}: ${s.reason}`);
    }
  }

  if (report.warnings.length > 0) {
    console.log("\n⚠ Warnings:");
    for (const w of report.warnings) {
      console.log(`   • ${w}`);
    }
  }

  if (report.errors.length > 0) {
    console.log("\n❌ Errors:");
    for (const e of report.errors) {
      console.log(`   • ${e}`);
    }
  }

  // Guidance
  console.log("\n" + "─".repeat(60));
  console.log("  NEXT STEPS");
  console.log("─".repeat(60));

  if (report.ggufFilesCopied.length > 0 || report.ggufBlobsFound.length > 0) {
    console.log("  ✓ Nana should now detect models via Rescan Models.");
    console.log('  ✓ Open the Model Manager panel and click "Rescan models".');
  } else {
    console.log("  ⚠ No GGUF blobs were recovered.");
    console.log("  → The Ollama blobs may have been deleted or moved.");
    console.log("  → Try: ollama pull qwen2.5:3b  (then re-run this script)");
  }

  console.log(
    "\n  ℹ Ollama should still work independently — we only COPIED blobs."
  );
  console.log(
    "  ℹ MiniCPM-V is a vision model. It needs both model + projector"
  );
  console.log(
    "    files. llama.cpp may need special flags to load it properly."
  );
  console.log("");
}

// ── Run ───────────────────────────────────────────────────────────────────────

header("Project Nana — Ollama GGUF Recovery Script");
log(`Project root: ${PROJECT_ROOT}`);
log(`Models directory: ${MODELS_DIR}`);
log(`Ollama blobs: ${OLLAMA_BLOBS_DIR}`);
log(`Ollama blobs exist: ${fs.existsSync(OLLAMA_BLOBS_DIR)}`);

recoverFromManifests();
scanForLooseGGUF();
printReport();
