import { describe, it, expect } from "vitest";
import { parseMediaPath } from "./parse";

describe("parseMediaPath", () => {
  it("extracts title + year from 'Title (2010)/Title (2010).mkv'", () => {
    const r = parseMediaPath("/m/The Matrix (1999)/The Matrix (1999).mkv");
    expect(r.title).toBe("The Matrix");
    expect(r.year).toBe(1999);
  });

  it("prefers the folder year when filename year differs", () => {
    const r = parseMediaPath(
      "/m/Blade Runner (1982)/Blade Runner (1992 remaster).mkv"
    );
    expect(r.year).toBe(1982);
  });

  it("trusts an embedded tmdb id", () => {
    const r = parseMediaPath("/m/Some Movie (2020) [tmdbid-603]/file.mkv");
    expect(r.tmdbId).toBe(603);
  });

  it("extracts an embedded imdb id", () => {
    const r = parseMediaPath(
      "/m/The Godfather (1972) [imdbid-tt0068646]/The Godfather.mkv"
    );
    expect(r.imdbId).toBe("tt0068646");
    expect(r.year).toBe(1972);
  });

  it("handles a scene-style filename with no parens year", () => {
    const r = parseMediaPath(
      "/m/Interstellar (2014)/Interstellar.2014.1080p.BluRay.mkv"
    );
    expect(r.title).toBe("Interstellar");
    expect(r.year).toBe(2014);
  });
});
