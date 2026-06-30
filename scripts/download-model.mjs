/**
 * Download the bge-small-en-v1.5 embedding model at Docker build time.
 *
 * Usage (inside the container, after pnpm install):
 *   MODELS_DIR=/app/data/models node scripts/download-model.mjs
 *
 * This script is used by apps/api/Dockerfile to bake the model into the image
 * so the first run works offline. The model (~130 MB) is cached in MODELS_DIR.
 */
import { env, pipeline } from "@huggingface/transformers";

const modelsDir = process.env.MODELS_DIR ?? "/app/data/models";

env.allowRemoteModels = true;
env.localModelPath = modelsDir;
env.cacheDir = modelsDir;

console.log(`Downloading Xenova/bge-small-en-v1.5 to ${modelsDir}...`);
await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5");
console.log("Model download complete.");
