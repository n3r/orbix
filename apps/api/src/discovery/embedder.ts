/**
 * Offline sentence-embedder using transformers.js + bge-small-en-v1.5.
 *
 * Key design goals:
 * - OFFLINE by default (allowRemoteModels=false); opt-in download via
 *   ORBIX_ALLOW_MODEL_DOWNLOAD=true.
 * - Degrades cleanly: throws EmbedderUnavailable when the model is absent,
 *   native binary is missing, or EMBEDDINGS_ENABLED=false.
 * - Pipeline loader is INJECTABLE via opts.loadPipeline for unit tests,
 *   so tests never need a real model or network.
 */

export class EmbedderUnavailable extends Error {
  override name = "EmbedderUnavailable";
  constructor(msg = "Embedder unavailable") {
    super(msg);
  }
}

/**
 * Minimal callable interface that must be satisfied by any pipeline (real or fake).
 * Matches the FeatureExtractionPipeline callback signature from transformers.js.
 */
export type RawPipeline = (
  text: string,
  opts?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: ArrayLike<number> }>;

/**
 * Injectable loader: returns a callable RawPipeline.
 * Default: loads the real transformers.js feature-extraction pipeline.
 * Tests inject a fake to avoid network / native binary.
 */
export type PipelineLoader = () => Promise<RawPipeline>;

// ── Constants ─────────────────────────────────────────────────────────────────

const BGE_MODEL = "Xenova/bge-small-en-v1.5";

/**
 * bge recommends this prefix for query vectors (not for passage/document vectors).
 * @see https://huggingface.co/BAAI/bge-small-en-v1.5
 */
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

// ── Module-level singleton ────────────────────────────────────────────────────

let _singletonPromise: Promise<RawPipeline> | null = null;
let _failedErr: EmbedderUnavailable | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function isEmbeddingsEnabled(): boolean {
  const v = process.env["EMBEDDINGS_ENABLED"];
  if (v === undefined || v === "") return true;
  return v !== "false" && v !== "0";
}

/**
 * The real pipeline loader. Uses a dynamic import so the native binary
 * (onnxruntime-node) is only loaded when the pipeline is first requested,
 * not at module evaluation time — this keeps tests safe.
 */
async function defaultPipelineLoader(): Promise<RawPipeline> {
  const modelsDir = process.env["MODELS_DIR"] ?? "./data/models";
  // Opt-in to allow the model to be downloaded once (e.g. at first run / CI).
  // Default is OFFLINE (false) — model must be pre-downloaded into MODELS_DIR.
  const allowRemote = process.env["ORBIX_ALLOW_MODEL_DOWNLOAD"] === "true";

  // Dynamic import keeps the native binary out of module scope.
  const { env: tfEnv, pipeline } = await import("@huggingface/transformers");

  // Apply offline flags BEFORE creating the pipeline.
  tfEnv.allowRemoteModels = allowRemote;
  tfEnv.localModelPath = modelsDir;
  tfEnv.cacheDir = modelsDir;

  const pipe = await pipeline("feature-extraction", BGE_MODEL);
  return pipe as unknown as RawPipeline;
}

/**
 * Returns the module-level singleton pipeline (real loader only).
 * Caches the first failure so retries don't storm the native binary.
 */
async function getSingleton(): Promise<RawPipeline> {
  if (_failedErr) throw _failedErr;
  if (!_singletonPromise) {
    _singletonPromise = defaultPipelineLoader().catch((err) => {
      _failedErr = new EmbedderUnavailable(
        err instanceof Error ? err.message : String(err),
      );
      _singletonPromise = null;
      throw _failedErr;
    });
  }
  return _singletonPromise;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface EmbedTextOpts {
  /**
   * "query"   → prepends the BGE query prefix (for search-query embeddings).
   * "passage" → uses text as-is (default, for document/passage embeddings).
   */
  kind?: "query" | "passage";

  /**
   * Inject a custom pipeline loader. When provided, bypasses the module-level
   * singleton. Used in tests to supply a fake pipeline without any network or
   * native binary dependency.
   */
  loadPipeline?: PipelineLoader;
}

/**
 * Embed `text` into a 384-dimensional float vector using bge-small-en-v1.5.
 *
 * @throws {EmbedderUnavailable} when:
 *   - `EMBEDDINGS_ENABLED=false` in the environment
 *   - The model is not available offline and `ORBIX_ALLOW_MODEL_DOWNLOAD` is not set
 *   - The native ONNX runtime binary is absent / failed to build
 *   - An injected `loadPipeline` throws
 */
export async function embedText(
  text: string,
  opts?: EmbedTextOpts,
): Promise<number[]> {
  if (!isEmbeddingsEnabled()) {
    throw new EmbedderUnavailable(
      "Embeddings are disabled (EMBEDDINGS_ENABLED=false)",
    );
  }

  let pipe: RawPipeline;

  if (opts?.loadPipeline) {
    // Test injection path — no singleton, no caching.
    try {
      pipe = await opts.loadPipeline();
    } catch (err) {
      throw err instanceof EmbedderUnavailable
        ? err
        : new EmbedderUnavailable(
            err instanceof Error ? err.message : String(err),
          );
    }
  } else {
    // Production path — lazy singleton.
    pipe = await getSingleton();
  }

  const input = opts?.kind === "query" ? QUERY_PREFIX + text : text;
  const output = await pipe(input, { pooling: "mean", normalize: true });
  return Array.from(output.data) as number[];
}

/**
 * Build a searchable passage string from a MediaItem's metadata fields.
 * Concatenates non-empty fields with ". " separator.
 *
 * Result: "title. overview. genre1 genre2. keyword1 keyword2"
 */
export function embedItemText(item: {
  title: string;
  overview?: string;
  genres?: string[];
  keywords?: string[];
}): string {
  return [
    item.title,
    item.overview,
    (item.genres ?? []).join(" "),
    (item.keywords ?? []).join(" "),
  ]
    .filter(Boolean)
    .join(". ");
}
