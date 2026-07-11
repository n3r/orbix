#!/usr/bin/env node
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "..");
const port = Number.parseInt(process.env.ORBIX_SMOKE_PORT ?? process.env.PORT ?? "0", 10);
const host = process.env.ORBIX_SMOKE_HOST ?? "127.0.0.1";
const token = process.env.ORBIX_SMOKE_TOKEN ?? "orb_smoke";
const videoPath = join(tmpdir(), "orbix-ios-smoke-direct.mp4");
const artDir = join(tmpdir(), "orbix-ios-smoke-art-v3");
const artPath = (path) => path.replace(/\.png$/, "-calm.png");
const revokedTokens = new Set();
const playbackStats = {
  playbackInfoByFileId: {},
  directRequestsByFileId: {},
  progressPutsByKey: {},
};

const profile = {
  id: "profile-standard",
  name: "Nikita",
  avatar: null,
  kind: "standard",
  maturityCap: null,
  language: "en",
};

const lockedProfile = {
  id: "profile-locked",
  name: "Guest",
  avatar: null,
  kind: "standard",
  maturityCap: null,
  language: "en",
};

const cards = {
  harbor: {
    id: "movie-harbor",
    title: "The Last Harbor",
    year: 2025,
    posterPath: artPath("poster/harbor.png"),
    backdropPath: artPath("backdrop/harbor.png"),
    progress: { positionSec: 840, durationSec: 6120 },
    resume: null,
  },
  orbit: {
    id: "movie-orbit",
    title: "Orbital",
    year: 2026,
    posterPath: artPath("poster/orbital.png"),
    backdropPath: artPath("backdrop/orbital.png"),
    progress: null,
    resume: null,
  },
  comedy: {
    id: "movie-comedy",
    title: "Friday Plans",
    year: 2024,
    posterPath: artPath("poster/friday.png"),
    backdropPath: artPath("backdrop/friday.png"),
    progress: null,
    resume: null,
  },
  family: {
    id: "movie-family",
    title: "Moon Garden",
    year: 2022,
    posterPath: artPath("poster/moon-garden.png"),
    backdropPath: artPath("backdrop/moon-garden.png"),
    progress: null,
    resume: null,
  },
  series: {
    id: "series-night-signal",
    title: "Night Signal",
    year: 2023,
    posterPath: artPath("poster/night-signal.png"),
    backdropPath: artPath("backdrop/night-signal.png"),
    progress: { positionSec: 510, durationSec: 2580 },
    resume: { seasonNumber: 1, episodeNumber: 2, episodeTitle: "Cold Open" },
  },
};

const progress = new Map([
  ["movie-harbor:", { positionSec: 840, durationSec: 6120, finished: false }],
  ["series-night-signal:episode-night-signal-2", { positionSec: 510, durationSec: 2580, finished: false }],
]);
const wishlist = new Set();

const files = new Map([
  ["file-harbor", { itemId: "movie-harbor", title: "The Last Harbor" }],
  ["file-orbit", { itemId: "movie-orbit", title: "Orbital" }],
  ["file-comedy", { itemId: "movie-comedy", title: "Friday Plans" }],
  ["file-family", { itemId: "movie-family", title: "Moon Garden" }],
  ["file-night-signal-1", { itemId: "series-night-signal", title: "Night Signal" }],
  ["file-night-signal-2", { itemId: "series-night-signal", title: "Night Signal" }],
]);

const details = new Map([
  [
    "movie-harbor",
    {
      id: "movie-harbor",
      kind: "movie",
      title: "The Last Harbor",
      year: 2025,
      overview: "A lighthouse keeper and a stranded pilot cross a silent coast before the storm returns.",
      posterPath: artPath("poster/harbor.png"),
      backdropPath: artPath("backdrop/harbor.png"),
      logoPath: null,
      runtimeSec: 6120,
      rating: "PG-13",
      genres: ["Drama", "Mystery"],
      cast: [
        { name: "Maya Stone", character: "Elena" },
        { name: "Jon Reyes", character: "Callum" },
      ],
      director: { name: "Ari Voss" },
      files: [{ id: "file-harbor" }],
    },
  ],
  [
    "movie-orbit",
    {
      id: "movie-orbit",
      kind: "movie",
      title: "Orbital",
      year: 2026,
      overview: "A rescue crew wakes above a dark planet and finds the mission has already changed.",
      posterPath: artPath("poster/orbital.png"),
      backdropPath: artPath("backdrop/orbital.png"),
      logoPath: null,
      runtimeSec: 7020,
      rating: "PG-13",
      genres: ["Science Fiction", "Thriller"],
      cast: [
        { name: "Ilya Novak", character: "Anton" },
        { name: "Reina Cole", character: "Vega" },
      ],
      director: { name: "Lina Park" },
      files: [{ id: "file-orbit" }],
    },
  ],
  [
    "movie-comedy",
    {
      id: "movie-comedy",
      kind: "movie",
      title: "Friday Plans",
      year: 2024,
      overview: "Three friends try to keep a quiet dinner from turning into a citywide scavenger hunt.",
      posterPath: artPath("poster/friday.png"),
      backdropPath: artPath("backdrop/friday.png"),
      logoPath: null,
      runtimeSec: 5520,
      rating: "PG",
      genres: ["Comedy"],
      cast: [{ name: "Sam Rivera", character: "Nico" }],
      director: { name: "Dee Mercer" },
      files: [{ id: "file-comedy" }],
    },
  ],
  [
    "movie-family",
    {
      id: "movie-family",
      kind: "movie",
      title: "Moon Garden",
      year: 2022,
      overview: "A brother and sister map a glowing backyard world while their parents plan one last move.",
      posterPath: artPath("poster/moon-garden.png"),
      backdropPath: artPath("backdrop/moon-garden.png"),
      logoPath: null,
      runtimeSec: 5940,
      rating: "PG",
      genres: ["Adventure", "Family"],
      cast: [{ name: "Leah Chen", character: "Mira" }],
      director: { name: "Rowan Keene" },
      files: [{ id: "file-family" }],
    },
  ],
  [
    "series-night-signal",
    {
      id: "series-night-signal",
      kind: "series",
      title: "Night Signal",
      year: 2023,
      overview: "A small town hears the same broadcast every midnight, and each episode changes one memory.",
      posterPath: artPath("poster/night-signal.png"),
      backdropPath: artPath("backdrop/night-signal.png"),
      logoPath: null,
      runtimeSec: null,
      rating: "TV-14",
      genres: ["Mystery", "Science Fiction"],
      cast: [{ name: "Nora Vale", character: "June" }],
      director: null,
      seasons: [{ seasonNumber: 1, name: "Season 1", episodeCount: 2, posterPath: null }],
      files: [],
    },
  ],
]);

const episodes = [
  {
    id: "episode-night-signal-1",
    episodeNumber: 1,
    title: "The Broadcast",
    overview: "June records the signal and realizes every radio in town is playing it.",
    stillPath: artPath("still/night-signal-1.png"),
    runtimeSec: 2640,
    airDate: "2023-10-01",
    fileId: "file-night-signal-1",
    progress: null,
  },
  {
    id: "episode-night-signal-2",
    episodeNumber: 2,
    title: "Cold Open",
    overview: "A familiar voice appears in the transmission with a warning no one wants to hear.",
    stillPath: artPath("still/night-signal-2.png"),
    runtimeSec: 2580,
    airDate: "2023-10-08",
    fileId: "file-night-signal-2",
    progress: { positionSec: 510, durationSec: 2580, finished: false },
  },
];

function ensureVideo() {
  if (existsSync(videoPath)) return;
  execFileSync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=8:size=640x360:rate=24",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-t",
    "8",
    videoPath,
  ], { stdio: "ignore" });
}

function ensureArt() {
  mkdirSync(artDir, { recursive: true });

  const specs = [
    [artPath("poster/harbor.png"), "360x540", "0x10151d", "0x2f6f73", "0xa98355", "poster"],
    [artPath("backdrop/harbor.png"), "960x540", "0x10151d", "0x2f6f73", "0xa98355", "backdrop"],
    [artPath("poster/orbital.png"), "360x540", "0x10131d", "0x56647c", "0x8aa8bd", "poster"],
    [artPath("backdrop/orbital.png"), "960x540", "0x10131d", "0x56647c", "0x8aa8bd", "backdrop"],
    [artPath("poster/friday.png"), "360x540", "0x181411", "0x927248", "0xb9855f", "poster"],
    [artPath("backdrop/friday.png"), "960x540", "0x181411", "0x927248", "0xb9855f", "backdrop"],
    [artPath("poster/moon-garden.png"), "360x540", "0x10170f", "0x526f55", "0x9b8c5a", "poster"],
    [artPath("backdrop/moon-garden.png"), "960x540", "0x10170f", "0x526f55", "0x9b8c5a", "backdrop"],
    [artPath("poster/night-signal.png"), "360x540", "0x11121d", "0x50446f", "0x497582", "poster"],
    [artPath("backdrop/night-signal.png"), "960x540", "0x11121d", "0x50446f", "0x497582", "backdrop"],
    [artPath("still/night-signal-1.png"), "960x540", "0x11121d", "0x50446f", "0x497582", "backdrop"],
    [artPath("still/night-signal-2.png"), "960x540", "0x11121d", "0x5e4d58", "0x497582", "backdrop"],
  ];

  for (const [name, size, base, accent, secondary, shape] of specs) {
    const outputPath = join(artDir, name.replaceAll("/", "-"));
    if (existsSync(outputPath)) continue;
    const isPoster = shape === "poster";
    execFileSync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${base}:s=${size}`,
      "-vf",
      [
        `drawbox=x=iw*-0.10:y=ih*0.05:w=iw*0.72:h=ih*0.72:color=${accent}@0.52:t=fill`,
        `drawbox=x=iw*0.42:y=ih*0.18:w=iw*0.72:h=ih*0.68:color=${secondary}@0.34:t=fill`,
        `drawbox=x=iw*0.12:y=ih*0.62:w=iw*0.86:h=ih*0.42:color=black@0.28:t=fill`,
        "gblur=sigma=18",
        `drawbox=x=iw*${isPoster ? "0.13" : "0.09"}:y=ih*${isPoster ? "0.16" : "0.20"}:w=iw*${isPoster ? "0.74" : "0.36"}:h=ih*${isPoster ? "0.54" : "0.46"}:color=black@0.22:t=fill`,
        `drawbox=x=iw*${isPoster ? "0.19" : "0.14"}:y=ih*${isPoster ? "0.22" : "0.26"}:w=iw*${isPoster ? "0.62" : "0.25"}:h=ih*${isPoster ? "0.42" : "0.32"}:color=${secondary}@0.26:t=fill`,
        `drawbox=x=iw*0.10:y=ih*0.80:w=iw*0.36:h=ih*0.012:color=white@0.22:t=fill`,
        "noise=alls=8:allf=t+u",
      ].join(","),
      "-frames:v",
      "1",
      outputPath,
    ], { stdio: "ignore" });
  }
}

function readJson(req) {
  return new Promise((resolveBody) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolveBody(body ? JSON.parse(body) : {});
      } catch {
        resolveBody({});
      }
    });
  });
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(data.byteLength),
  });
  res.end(data);
}

function sendNoContent(res) {
  res.writeHead(204);
  res.end();
}

function sendImage(res, imagePath) {
  ensureArt();
  const normalizedPath = imagePath.replace(/^\/api\/images\//, "");
  const generatedPath = join(artDir, normalizedPath.replaceAll("/", "-"));
  const data = readFileSync(existsSync(generatedPath) ? generatedPath : iconImage);
  res.writeHead(200, {
    "content-type": "image/png",
    "cache-control": "no-store",
    "content-length": String(data.byteLength),
  });
  res.end(data);
}

function sendVideo(req, res) {
  ensureVideo();
  const size = statSync(videoPath).size;
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      res.end();
      return;
    }
    const start = match[1] ? Number.parseInt(match[1], 10) : 0;
    const end = match[2] ? Math.min(Number.parseInt(match[2], 10), size - 1) : size - 1;
    if (start >= size || end < start) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      res.end();
      return;
    }
    const data = readFileSync(videoPath).subarray(start, end + 1);
    res.writeHead(206, {
      "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end}/${size}`,
      "content-length": String(data.byteLength),
      "content-type": "video/mp4",
    });
    if (req.method === "HEAD") res.end();
    else res.end(data);
    return;
  }

  res.writeHead(200, {
    "accept-ranges": "bytes",
    "content-length": String(size),
    "content-type": "video/mp4",
  });
  if (req.method === "HEAD") res.end();
  else res.end(readFileSync(videoPath));
}

function requireBearer(req, res) {
  const value = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (value === token && !revokedTokens.has(value)) return true;
  sendJson(res, 401, { error: "unauthorized" });
  return false;
}

function incrementStat(bucket, key) {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

function resetPlaybackStats() {
  playbackStats.playbackInfoByFileId = {};
  playbackStats.directRequestsByFileId = {};
  playbackStats.progressPutsByKey = {};
}

const allCards = [cards.harbor, cards.orbit, cards.comedy, cards.family, cards.series];
const libraryCards = new Map([
  ["library-movies", [cards.harbor, cards.orbit, cards.comedy, cards.series]],
  ["library-family", [cards.family, cards.comedy]],
]);

function cardList(libraryId) {
  if (libraryId) return libraryCards.get(libraryId) ?? [];
  return allCards;
}

function libraryItems(libraryId, query, sort) {
  const q = query.toLowerCase();
  const sourceItems = cardList(libraryId);
  const items = sourceItems
    .filter((card) => {
      const detail = details.get(card.id);
      return !q || card.title.toLowerCase().includes(q) || detail?.genres?.join(" ").toLowerCase().includes(q);
    });

  if (sort === "year") {
    items.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title));
  } else if (sort === "added") {
    items.sort((a, b) => sourceItems.indexOf(a) - sourceItems.indexOf(b));
  } else {
    items.sort((a, b) => a.title.localeCompare(b.title));
  }

  return items.map(({ id, title, year, posterPath }) => ({ id, title, year, posterPath, matchState: "matched" }));
}

function searchItems(query) {
  const q = query.toLowerCase();
  return cardList()
    .filter((card) => {
      const detail = details.get(card.id);
      return !q || card.title.toLowerCase().includes(q) || detail?.genres?.join(" ").toLowerCase().includes(q);
    })
    .map(({ id, title, year, posterPath }) => ({ id, title, year, posterPath, matchState: "matched" }));
}

function wishlistItems() {
  return [...wishlist]
    .map((id) => {
      const card = cardList().find((candidate) => candidate.id === id);
      if (!card) return null;
      return {
        id: card.id,
        title: card.title,
        year: card.year,
        posterPath: card.posterPath,
        matchState: "matched",
      };
    })
    .filter(Boolean);
}

const iconImage = join(root, "Resources-iOS/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png");
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
  const path = decodeURIComponent(url.pathname);

  console.log(`${req.method} ${path}`);

  if (req.method === "GET" && path === "/health") {
    sendJson(res, 200, { ok: true, service: "orbix", name: "Orbix Smoke" });
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && path.startsWith("/api/play/")) {
    if (url.searchParams.get("token") !== token) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    const playMatch = /^\/api\/play\/([^/]+)\/direct$/.exec(path);
    if (req.method === "GET" && playMatch) {
      incrementStat(playbackStats.directRequestsByFileId, playMatch[1]);
    }
    sendVideo(req, res);
    return;
  }

  if (req.method === "GET" && path.startsWith("/api/images/")) {
    sendImage(res, path);
    return;
  }

  if (req.method === "POST" && path === "/api/smoke/revoke-token") {
    if (req.headers.authorization !== `Bearer ${token}`) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    revokedTokens.add(token);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && path === "/api/smoke/reset-token") {
    revokedTokens.clear();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && path === "/api/smoke/reset-playback-stats") {
    resetPlaybackStats();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && path === "/api/smoke/reset-wishlist") {
    wishlist.clear();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && path === "/api/smoke/playback-stats") {
    sendJson(res, 200, playbackStats);
    return;
  }

  if (path.startsWith("/api/") && !requireBearer(req, res)) return;

  if (req.method === "GET" && path === "/api/me/profile") {
    sendJson(res, 200, profile);
    return;
  }

  if (req.method === "GET" && path === "/api/profiles") {
    sendJson(res, 200, [profile, lockedProfile]);
    return;
  }

  const selectMatch = /^\/api\/profiles\/([^/]+)\/select$/.exec(path);
  if (req.method === "POST" && selectMatch) {
    const selectedProfileId = selectMatch[1];
    if (![profile.id, lockedProfile.id].includes(selectedProfileId)) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (selectedProfileId === lockedProfile.id) {
      const body = await readJson(req);
      if (body.pin !== "2468") {
        sendJson(res, 403, { error: "pin_required" });
        return;
      }
    }
    sendJson(res, 200, { profileId: selectMatch[1] });
    return;
  }

  if (req.method === "GET" && path === "/api/home/rows") {
    sendJson(res, 200, {
      rows: [
        { key: "continue", title: "Continue Watching", items: [cards.harbor, cards.series] },
        { key: "tonight", title: "Pick something for tonight", items: [cards.orbit, cards.comedy, cards.harbor] },
        { key: "hiddenGems", title: "Hidden gems", items: [cards.series, cards.comedy, cards.orbit] },
      ],
    });
    return;
  }

  if (req.method === "GET" && path === "/api/me/menu") {
    sendJson(res, 200, {
      items: [
        { libraryId: "library-movies", name: "Movies & Series" },
        { libraryId: "library-family", name: "Family Night" },
      ],
    });
    return;
  }

  const libraryItemsMatch = /^\/api\/libraries\/([^/]+)\/items$/.exec(path);
  if (req.method === "GET" && libraryItemsMatch) {
    const libraryId = libraryItemsMatch[1];
    if (!libraryCards.has(libraryId)) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    sendJson(res, 200, libraryItems(libraryId, url.searchParams.get("q") ?? "", url.searchParams.get("sort") ?? "title"));
    return;
  }

  if (req.method === "GET" && path === "/api/search") {
    sendJson(res, 200, { items: searchItems(url.searchParams.get("q") ?? ""), usedEmbeddings: false });
    return;
  }

  if (req.method === "GET" && path === "/api/wishlist") {
    sendJson(res, 200, wishlistItems());
    return;
  }

  if (req.method === "GET" && path === "/api/wishlist/ids") {
    sendJson(res, 200, { ids: [...wishlist] });
    return;
  }

  const wishlistMatch = /^\/api\/wishlist\/([^/]+)$/.exec(path);
  if (wishlistMatch && req.method === "POST") {
    if (!details.has(wishlistMatch[1])) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    wishlist.add(wishlistMatch[1]);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (wishlistMatch && req.method === "DELETE") {
    wishlist.delete(wishlistMatch[1]);
    sendJson(res, 200, { ok: true });
    return;
  }

  const itemMatch = /^\/api\/items\/([^/]+)$/.exec(path);
  if (req.method === "GET" && itemMatch) {
    const detail = details.get(itemMatch[1]);
    if (!detail) sendJson(res, 404, { error: "not_found" });
    else sendJson(res, 200, detail);
    return;
  }

  const similarMatch = /^\/api\/items\/([^/]+)\/similar$/.exec(path);
  if (req.method === "GET" && similarMatch) {
    sendJson(res, 200, {
      items: cardList()
        .filter((card) => card.id !== similarMatch[1])
        .slice(0, 3)
        .map(({ id, title, year, posterPath }) => ({ id, title, year, posterPath, matchState: "matched" })),
    });
    return;
  }

  const episodesMatch = /^\/api\/items\/([^/]+)\/seasons\/(\d+)\/episodes$/.exec(path);
  if (req.method === "GET" && episodesMatch) {
    if (episodesMatch[1] !== "series-night-signal" || episodesMatch[2] !== "1") {
      sendJson(res, 200, { episodes: [] });
    } else {
      sendJson(res, 200, { episodes });
    }
    return;
  }

  const progressMatch = /^\/api\/items\/([^/]+)\/progress$/.exec(path);
  if (progressMatch && req.method === "GET") {
    const key = `${progressMatch[1]}:${url.searchParams.get("episodeId") ?? ""}`;
    sendJson(res, 200, progress.get(key) ?? { positionSec: 0, durationSec: 0, finished: false });
    return;
  }

  if (progressMatch && req.method === "PUT") {
    const body = await readJson(req);
    const episodeId = typeof body.episodeId === "string" ? body.episodeId : "";
    const durationSec = Number.isFinite(body.durationSec) ? Math.floor(body.durationSec) : 0;
    const positionSec = Number.isFinite(body.positionSec) ? Math.floor(body.positionSec) : 0;
    incrementStat(playbackStats.progressPutsByKey, `${progressMatch[1]}:${episodeId}`);
    progress.set(`${progressMatch[1]}:${episodeId}`, {
      positionSec,
      durationSec,
      finished: durationSec > 0 && positionSec / durationSec >= 0.9,
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && path === "/api/playback/info") {
    const body = await readJson(req);
    const fileId = typeof body.fileId === "string" ? body.fileId : "";
    if (!files.has(fileId)) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    incrementStat(playbackStats.playbackInfoByFileId, fileId);
    const playSessionId = `smoke-${Date.now()}`;
    sendJson(res, 200, {
      playSessionId,
      mode: "direct",
      streamUrl: `/api/play/${fileId}/direct?token=${encodeURIComponent(token)}`,
      container: "mp4",
      videoCodec: "h264",
      audioTracks: [
        { index: 0, codec: "aac", channels: 2, language: "en", selected: true },
        { index: 1, codec: "aac", channels: 2, language: "es", selected: false },
      ],
      subtitleTracks: [
        { index: 0, codec: "webvtt", language: "en", available: true },
        { index: 1, codec: "srt", language: "fr", available: false, reason: "unsupported" },
      ],
    });
    return;
  }

  if (req.method === "POST" && /^\/api\/playback\/[^/]+\/stop$/.test(path)) {
    sendNoContent(res);
    return;
  }

  sendJson(res, 404, { error: "not_found" });
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`Orbix iOS smoke server listening at http://${host}:${actualPort}`);
  console.log(`Launch args: -orbixBaseURL http://${host}:${actualPort} -orbixToken ${token}`);
});
