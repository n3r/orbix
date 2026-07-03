import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import dns from "node:dns";
import type { LookupAddress } from "node:dns";
import type { ReadableStream } from "node:stream/web";
import { Agent, fetch as undiciFetch } from "undici";
import type { buildConnector } from "undici";
import { isPrivateHost } from "@orbix/core";

/**
 * Hardened fetcher for TV upstreams (playlists + segments).
 *
 * SSRF posture (defense in depth):
 *  - http/https URLs only;
 *  - literal-IP hosts are checked with isPrivateHost BEFORE any dial (the
 *    DNS lookup below never runs for IP literals);
 *  - DNS resolution happens inside the undici Agent via a validating lookup
 *    that rejects private/link-local/ULA answers on EVERY resolution — a
 *    hostname cannot rebind to 127.0.0.1 mid-session;
 *  - redirects are followed manually (cap 5) so every hop re-runs both checks.
 *
 * The optional `lookup` override (tests) replaces only the DNS layer; the
 * literal-IP pre-check always applies.
 */

export interface UpstreamResult {
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | null;
  text?: string;
}

/** Pinned modern-browser UA — ZDF & friends 403 curl-ish agents (spec probe). */
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_TEXT_BYTES = 16 * 1024 * 1024; // 16 MiB — playlists are KB-to-low-MB; anything larger is hostile

/**
 * Reads a response body to completion with a byte cap (wantText:true path
 * only). Segments use the streaming path below and pass `body` through to
 * the caller unbuffered — capping them here would break large-but-legit
 * segments, so this must never be used for that path.
 */
async function readCappedText(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_TEXT_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("upstream body too large");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/** dns.lookup that fails when any resolved address is private (rebinding guard). */
const validatingLookup: LookupFunction = (hostname, options, callback) => {
  const cb = callback as (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void;
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, []);
    const list = addresses as LookupAddress[];
    if (list.length === 0) {
      return cb(Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }), []);
    }
    for (const a of list) {
      if (isPrivateHost(a.address)) {
        return cb(
          Object.assign(new Error(`private upstream blocked: ${hostname}`), { code: "EPRIVATE" }),
          [],
        );
      }
    }
    if ((options as { all?: boolean }).all) return cb(null, list);
    return cb(null, list[0]!.address, list[0]!.family);
  });
};

export function makeTvUpstream(opts?: { lookup?: LookupFunction }) {
  const connect = {
    lookup: opts?.lookup ?? validatingLookup,
    timeout: 5_000, // connect timeout (spec: ~5 s)
  } as buildConnector.BuildOptions;
  const agent = new Agent({ connect, headersTimeout: 10_000 }); // header timeout (spec: ~10 s)

  async function fetchUpstream(
    url: string,
    init: { userAgent: string | null; referrer: string | null; wantText: boolean; timeoutMs?: number },
  ): Promise<UpstreamResult> {
    // Bounds the whole fetch (connect + headers + body); streaming
    // (wantText:false) callers should pass a larger timeoutMs since this
    // isn't meant to cap an entire streaming session.
    const signal = AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const headers: Record<string, string> = { "user-agent": init.userAgent ?? BROWSER_UA };
    if (init.referrer) headers["referer"] = init.referrer;

    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const parsed = new URL(current); // throws on junk — caller maps to 502
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`unsupported scheme: ${parsed.protocol}`);
      }
      // Literal-IP hosts never reach the DNS lookup — check them directly.
      const bareHost = parsed.hostname.replace(/^\[|\]$/g, ""); // strip [v6] brackets
      if (isIP(bareHost) !== 0 && isPrivateHost(bareHost)) {
        throw new Error(`private upstream blocked: ${bareHost}`);
      }

      const res = await undiciFetch(current, {
        method: "GET",
        headers,
        redirect: "manual",
        dispatcher: agent,
        signal,
      });

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!location) throw new Error(`redirect without location from ${current}`);
        if (hop === MAX_REDIRECTS) throw new Error("too many redirects");
        current = new URL(location, current).toString();
        continue;
      }

      const headerRecord: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headerRecord[key] = value;
      });

      if (init.wantText) {
        const text = await readCappedText(res.body as unknown as ReadableStream<Uint8Array> | null);
        return { finalUrl: current, status: res.status, headers: headerRecord, body: null, text };
      }
      return {
        finalUrl: current,
        status: res.status,
        headers: headerRecord,
        body: res.body as unknown as ReadableStream<Uint8Array> | null,
      };
    }
    throw new Error("too many redirects");
  }

  return {
    fetchUpstream,
    /** Close keep-alive sockets (app shutdown / test teardown). */
    close: () => agent.close(),
  };
}

export type TvUpstream = ReturnType<typeof makeTvUpstream>;
