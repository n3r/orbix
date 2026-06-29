import { describe, it, expect } from "vitest";
import { parseConstraints } from "./constraints";

describe("parseConstraints", () => {
  describe("runtime – max (under / less than / below)", () => {
    it("extracts runtimeMaxSec from 'under 2 hours'", () => {
      const r = parseConstraints("something light and funny under 2 hours");
      expect(r.runtimeMaxSec).toBe(7200);
    });

    it("extracts runtimeMaxSec from 'under 90 minutes'", () => {
      const r = parseConstraints("movie under 90 minutes");
      expect(r.runtimeMaxSec).toBe(5400);
    });

    it("extracts runtimeMaxSec from 'under 90 min'", () => {
      const r = parseConstraints("short film under 90 min");
      expect(r.runtimeMaxSec).toBe(5400);
    });

    it("handles decimal hours: 'under 1.5 hours' → 5400", () => {
      const r = parseConstraints("something under 1.5 hours");
      expect(r.runtimeMaxSec).toBe(5400);
    });

    it("handles 'less than 2 hours'", () => {
      const r = parseConstraints("comedy less than 2 hours");
      expect(r.runtimeMaxSec).toBe(7200);
    });

    it("handles 'below 2 hours'", () => {
      const r = parseConstraints("horror below 2 hours");
      expect(r.runtimeMaxSec).toBe(7200);
    });
  });

  describe("runtime – min (over / more than / at least)", () => {
    it("extracts runtimeMinSec from 'over 2 hours'", () => {
      const r = parseConstraints("epic over 2 hours");
      expect(r.runtimeMinSec).toBe(7200);
    });

    it("extracts runtimeMinSec from 'at least 90 minutes'", () => {
      const r = parseConstraints("drama at least 90 minutes");
      expect(r.runtimeMinSec).toBe(5400);
    });

    it("extracts runtimeMinSec from 'more than 2 hours'", () => {
      const r = parseConstraints("action more than 2 hours");
      expect(r.runtimeMinSec).toBe(7200);
    });
  });

  describe("decade", () => {
    it("extracts decade from 'from the 90s'", () => {
      const r = parseConstraints("tense thriller from the 90s");
      expect(r.decadeStart).toBe(1990);
      expect(r.decadeEnd).toBe(1999);
    });

    it("extracts decade from '1990s'", () => {
      const r = parseConstraints("movie from the 1990s");
      expect(r.decadeStart).toBe(1990);
      expect(r.decadeEnd).toBe(1999);
    });

    it("extracts decade from '2000s'", () => {
      const r = parseConstraints("action from the 2000s");
      expect(r.decadeStart).toBe(2000);
      expect(r.decadeEnd).toBe(2009);
    });

    it("extracts decade from bare '80s'", () => {
      const r = parseConstraints("classic 80s horror");
      expect(r.decadeStart).toBe(1980);
      expect(r.decadeEnd).toBe(1989);
    });

    it("handles 'in the 70s'", () => {
      const r = parseConstraints("drama in the 70s");
      expect(r.decadeStart).toBe(1970);
      expect(r.decadeEnd).toBe(1979);
    });

    it("handles 'before 2000'", () => {
      const r = parseConstraints("film before 2000");
      expect(r.decadeEnd).toBe(1999);
      expect(r.decadeStart).toBeUndefined();
    });

    it("handles 'after 2010'", () => {
      const r = parseConstraints("film after 2010");
      expect(r.decadeStart).toBe(2011);
      expect(r.decadeEnd).toBeUndefined();
    });
  });

  describe("genres", () => {
    it("maps 'funny' → Comedy", () => {
      const r = parseConstraints("something funny");
      expect(r.genres).toContain("Comedy");
    });

    it("maps 'comedy' → Comedy", () => {
      const r = parseConstraints("good comedy");
      expect(r.genres).toContain("Comedy");
    });

    it("maps 'scary' → Horror", () => {
      const r = parseConstraints("scary movie for kids");
      expect(r.genres).toContain("Horror");
    });

    it("maps 'horror' → Horror", () => {
      const r = parseConstraints("80s horror film");
      expect(r.genres).toContain("Horror");
    });

    it("maps 'thriller' → Thriller", () => {
      const r = parseConstraints("tense thriller from the 90s");
      expect(r.genres).toContain("Thriller");
    });

    it("maps 'tense' → Thriller", () => {
      const r = parseConstraints("something tense");
      expect(r.genres).toContain("Thriller");
    });

    it("maps 'action' → Action", () => {
      const r = parseConstraints("action movie");
      expect(r.genres).toContain("Action");
    });

    it("maps 'romantic' → Romance", () => {
      const r = parseConstraints("romantic film");
      expect(r.genres).toContain("Romance");
    });

    it("maps 'romance' → Romance", () => {
      const r = parseConstraints("good romance");
      expect(r.genres).toContain("Romance");
    });

    it("maps 'sci-fi' → Science Fiction", () => {
      const r = parseConstraints("great sci-fi adventure");
      expect(r.genres).toContain("Science Fiction");
    });

    it("maps 'science fiction' → Science Fiction", () => {
      const r = parseConstraints("science fiction epic");
      expect(r.genres).toContain("Science Fiction");
    });

    it("maps 'drama' → Drama", () => {
      const r = parseConstraints("emotional drama");
      expect(r.genres).toContain("Drama");
    });

    it("maps 'documentary' → Documentary", () => {
      const r = parseConstraints("nature documentary");
      expect(r.genres).toContain("Documentary");
    });

    it("maps 'animated' → Animation", () => {
      const r = parseConstraints("animated adventure");
      expect(r.genres).toContain("Animation");
    });

    it("maps 'animation' → Animation", () => {
      const r = parseConstraints("great animation");
      expect(r.genres).toContain("Animation");
    });

    it("maps 'family' → Family", () => {
      const r = parseConstraints("good family film");
      expect(r.genres).toContain("Family");
    });

    it("collects unique genres only", () => {
      const r = parseConstraints("funny comedy");
      const comedyCount = r.genres.filter((g) => g === "Comedy").length;
      expect(comedyCount).toBe(1);
    });
  });

  describe("rating", () => {
    it("maps 'for kids' → PG", () => {
      const r = parseConstraints("scary movie for kids");
      expect(r.ratingMax).toBe("PG");
    });

    it("maps 'for children' → PG", () => {
      const r = parseConstraints("something fun for children");
      expect(r.ratingMax).toBe("PG");
    });

    it("maps 'family-friendly' → PG", () => {
      const r = parseConstraints("family-friendly adventure");
      expect(r.ratingMax).toBe("PG");
    });

    it("maps 'kid-friendly' → PG", () => {
      const r = parseConstraints("kid-friendly comedy");
      expect(r.ratingMax).toBe("PG");
    });

    it("maps 'G rated' → G", () => {
      const r = parseConstraints("something G rated");
      expect(r.ratingMax).toBe("G");
    });

    it("maps 'PG-13' → PG-13", () => {
      const r = parseConstraints("PG-13 action movie");
      expect(r.ratingMax).toBe("PG-13");
    });
  });

  describe("residualText", () => {
    it("removes 'under 2 hours' from residual", () => {
      const r = parseConstraints("something light and funny under 2 hours");
      expect(r.residualText).not.toMatch(/under 2 hours/i);
    });

    it("removes genre signal words from residual", () => {
      const r = parseConstraints("something light and funny under 2 hours");
      expect(r.residualText).not.toMatch(/\bfunny\b/i);
    });

    it("keeps non-signal adjectives like 'light'", () => {
      const r = parseConstraints("something light and funny under 2 hours");
      expect(r.residualText).toMatch(/light/i);
    });

    it("removes decade phrase from residual", () => {
      const r = parseConstraints("tense thriller from the 90s");
      expect(r.residualText).not.toMatch(/from the 90s/i);
    });

    it("removes genre words from residual", () => {
      const r = parseConstraints("tense thriller from the 90s");
      expect(r.residualText).not.toMatch(/\bthriller\b/i);
      expect(r.residualText).not.toMatch(/\btense\b/i);
    });

    it("removes rating phrase from residual", () => {
      const r = parseConstraints("scary movie for kids");
      expect(r.residualText).not.toMatch(/for kids/i);
    });

    it("returns unchanged trimmed input when no constraints match", () => {
      const r = parseConstraints("a quiet melancholy story");
      expect(r.residualText).toBe("a quiet melancholy story");
      expect(r.runtimeMaxSec).toBeUndefined();
      expect(r.runtimeMinSec).toBeUndefined();
      expect(r.decadeStart).toBeUndefined();
      expect(r.decadeEnd).toBeUndefined();
      expect(r.genres).toHaveLength(0);
      expect(r.ratingMax).toBeUndefined();
    });

    it("collapses multiple whitespace in residual", () => {
      const r = parseConstraints("tense thriller from the 90s");
      expect(r.residualText).not.toMatch(/\s{2,}/);
    });
  });

  describe("composite queries", () => {
    it("full composite: light+funny+under 2 hours", () => {
      const r = parseConstraints("something light and funny under 2 hours");
      expect(r.runtimeMaxSec).toBe(7200);
      expect(r.genres).toContain("Comedy");
      expect(r.residualText).toMatch(/light/i);
      expect(r.residualText).not.toMatch(/under 2 hours/i);
      expect(r.residualText).not.toMatch(/\bfunny\b/i);
    });

    it("thriller+decade: genres+decade extracted", () => {
      const r = parseConstraints("tense thriller from the 90s");
      expect(r.decadeStart).toBe(1990);
      expect(r.decadeEnd).toBe(1999);
      expect(r.genres).toContain("Thriller");
    });

    it("horror+rating", () => {
      const r = parseConstraints("scary movie for kids");
      expect(r.genres).toContain("Horror");
      expect(r.ratingMax).toBe("PG");
    });
  });
});
