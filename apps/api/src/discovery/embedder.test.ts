/**
 * Unit tests for the offline sentence-embedder.
 *
 * All tests run WITHOUT network access and WITHOUT the real ONNX model:
 * - Happy-path shape is proven via an injectable fake pipeline loader.
 * - Degrade path (EMBEDDINGS_ENABLED=false, loader throws) is proven by
 *   asserting that EmbedderUnavailable is thrown.
 */

import { describe, it, expect } from "vitest";
import {
  embedText,
  embedItemText,
  EmbedderUnavailable,
  type PipelineLoader,
} from "./embedder.js";

// ── embedItemText ─────────────────────────────────────────────────────────────

describe("embedItemText", () => {
  it("joins all fields with '. ' separator", () => {
    const result = embedItemText({
      title: "X",
      overview: "Y",
      genres: ["A"],
      keywords: ["b"],
    });
    expect(result).toBe("X. Y. A. b");
  });

  it("omits undefined overview", () => {
    expect(embedItemText({ title: "Only" })).toBe("Only");
  });

  it("omits empty genre/keyword arrays", () => {
    expect(
      embedItemText({ title: "T", overview: "O", genres: [], keywords: [] }),
    ).toBe("T. O");
  });

  it("joins multiple genres and keywords into single space-separated tokens", () => {
    expect(
      embedItemText({
        title: "T",
        genres: ["Action", "Sci-Fi"],
        keywords: ["robot", "future"],
      }),
    ).toBe("T. Action Sci-Fi. robot future");
  });
});

// ── embedText – happy path via fake pipeline ─────────────────────────────────

describe("embedText – fake pipeline (offline, no model needed)", () => {
  /** Factory for a PipelineLoader that immediately returns a fake pipeline. */
  function makeFakeLoader(dims = 384, fillValue = 0.1): PipelineLoader {
    return async () => {
      return async (_text, _opts) => ({
        data: new Float32Array(dims).fill(fillValue),
      });
    };
  }

  it("returns a plain number[] of length 384", async () => {
    const result = await embedText("hello world", {
      loadPipeline: makeFakeLoader(384),
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(384);
    expect(typeof result[0]).toBe("number");
  });

  it("all elements are finite numbers", async () => {
    const result = await embedText("test sentence", {
      loadPipeline: makeFakeLoader(384, 0.5),
    });
    expect(result.every(Number.isFinite)).toBe(true);
  });

  it("query kind does not change vector dimensions", async () => {
    const result = await embedText("find me something", {
      kind: "query",
      loadPipeline: makeFakeLoader(384),
    });
    expect(result).toHaveLength(384);
  });
});

// ── embedText – degrade paths ─────────────────────────────────────────────────

describe("embedText – EmbedderUnavailable degrade", () => {
  it("throws EmbedderUnavailable when EMBEDDINGS_ENABLED=false", async () => {
    const orig = process.env["EMBEDDINGS_ENABLED"];
    process.env["EMBEDDINGS_ENABLED"] = "false";
    try {
      await expect(embedText("hi")).rejects.toThrow(EmbedderUnavailable);
    } finally {
      if (orig === undefined) {
        delete process.env["EMBEDDINGS_ENABLED"];
      } else {
        process.env["EMBEDDINGS_ENABLED"] = orig;
      }
    }
  });

  it("throws EmbedderUnavailable (not a raw error) when loadPipeline throws", async () => {
    const failingLoader: PipelineLoader = async () => {
      throw new Error("onnxruntime native binary unavailable");
    };

    const err = await embedText("test", {
      loadPipeline: failingLoader,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EmbedderUnavailable);
    expect((err as EmbedderUnavailable).name).toBe("EmbedderUnavailable");
    expect((err as EmbedderUnavailable).message).toContain("onnxruntime");
  });

  it("propagates an EmbedderUnavailable thrown by loadPipeline as-is", async () => {
    const specificMsg = "model files not found in MODELS_DIR";
    const failingLoader: PipelineLoader = async () => {
      throw new EmbedderUnavailable(specificMsg);
    };

    const err = await embedText("test", {
      loadPipeline: failingLoader,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EmbedderUnavailable);
    expect((err as EmbedderUnavailable).message).toBe(specificMsg);
  });
});
