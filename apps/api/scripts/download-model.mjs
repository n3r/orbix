/**
 * Download the bge-small-en-v1.5 embedding model at Docker build time.
 *
 * Run from the repo root (after pnpm install):
 *   MODELS_DIR=/app/data/models node apps/api/scripts/download-model.mjs
 *
 * Node ESM resolution works because this file is inside the @orbix/api
 * workspace where @huggingface/transformers is installed.
 */
import { env, pipeline } from "@huggingface/transformers";

const modelsDir = process.env.MODELS_DIR ?? "/app/data/models";

env.allowRemoteModels = true;
env.localModelPath = modelsDir;
env.cacheDir = modelsDir;

console.log(`Downloading Xenova/bge-small-en-v1.5 to ${modelsDir}...`);
await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5");
console.log("Model download complete.");
