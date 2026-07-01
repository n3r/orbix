const BASE = "https://api4.thetvdb.com/v4";
const ARTWORKS_BASE = "https://artworks.thetvdb.com";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class TvdbError extends Error {
  constructor(status: number) {
    super(`TVDB request failed with status ${status}`);
    this.name = "TvdbError";
  }
}

// ---------------------------------------------------------------------------
// Normalised shapes
// ---------------------------------------------------------------------------

export interface TvdbSearchResult {
  tvdbId: number;
  title: string;
  year?: number;
}

// ---------------------------------------------------------------------------
// Raw shapes (only what we read)
// ---------------------------------------------------------------------------

interface RawLogin {
  data?: { token?: string };
}
interface RawSearchItem {
  tvdb_id?: string;
  name?: string;
  year?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Normalise a TVDB image field to an absolute URL (v4 usually already is). */
export function absUrl(u: string | null | undefined): string | undefined {
  if (!u) return undefined;
  if (u.startsWith("http")) return u;
  return `${ARTWORKS_BASE}${u.startsWith("/") ? "" : "/"}${u}`;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class TvdbClient {
  private readonly apiKey: string;
  private readonly pin?: string;
  private readonly fetchImpl: typeof fetch;
  /** 3-letter ISO 639-2 language for localized endpoints; undefined = English. */
  readonly language?: string;
  private token?: string;

  constructor(apiKey: string, fetchImpl?: typeof fetch, pin?: string, language?: string) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.pin = pin;
    this.language = language;
  }

  private async login(): Promise<string> {
    const res = await this.fetchImpl(`${BASE}/login`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(this.pin ? { apikey: this.apiKey, pin: this.pin } : { apikey: this.apiKey }),
    });
    if (!res.ok) throw new TvdbError(res.status);
    const raw = (await res.json()) as RawLogin;
    const token = raw.data?.token;
    if (!token) throw new TvdbError(res.status);
    this.token = token;
    return token;
  }

  /** GET a path (already including BASE) with the Bearer token; one re-login on 401. */
  private async get<T>(path: string): Promise<T> {
    if (!this.token) await this.login();
    let res = await this.fetchImpl(path, {
      headers: { Authorization: `Bearer ${this.token}`, accept: "application/json" },
    });
    if (res.status === 401) {
      await this.login();
      res = await this.fetchImpl(path, {
        headers: { Authorization: `Bearer ${this.token}`, accept: "application/json" },
      });
    }
    if (!res.ok) throw new TvdbError(res.status);
    return res.json() as Promise<T>;
  }

  async searchSeries(title: string, year?: number): Promise<TvdbSearchResult | null> {
    const url = `${BASE}/search?query=${encodeURIComponent(title)}&type=series`;
    const data = await this.get<{ data?: RawSearchItem[] }>(url);
    const items = data.data ?? [];
    // Prefer an exact-year match when a year is known; else the first result.
    const pick =
      (year != null && items.find((i) => Number(i.year) === year)) || items[0];
    if (!pick || pick.tvdb_id == null) return null;
    return {
      tvdbId: Number(pick.tvdb_id),
      title: pick.name ?? title,
      ...(pick.year ? { year: Number(pick.year) } : {}),
    };
  }
}
