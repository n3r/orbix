import { SaxesParser } from "saxes";

/** One parsed XMLTV `<programme>` row, window-filtered and offset-applied. */
export interface XmltvProgramme {
  epgId: string;
  start: Date;
  stop: Date;
  title: string;
  description: string | null;
  category: string | null;
  lang: string | null;
}

/** An XMLTV `<channel>`'s id plus every `<display-name>` text, in file order. */
export interface XmltvChannelName {
  id: string;
  names: string[];
}

/**
 * Parse an XMLTV timestamp: "20260703193000 +0300". Seconds and the offset are
 * both optional; a missing offset means UTC. Returns null when the shape does
 * not match (feeds are machine-generated — no lenient recovery beyond this).
 */
export function parseXmltvDate(s: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s*([+-])(\d{2})(\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se, sign, oh, om] = m;
  const utcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, se ? +se : 0);
  if (!sign) return new Date(utcMs);
  const offMin = (sign === "-" ? -1 : 1) * (+oh * 60 + +om);
  return new Date(utcMs - offMin * 60_000);
}

export interface XmltvCollectorOptions {
  /**
   * Programme filter: only rows whose `channel` attribute is in this set are
   * emitted. `null` = discovery pass (channel names only, no programmes).
   * Membership is checked LIVE at each `</programme>` — callers may add ids
   * mid-stream (XMLTV orders all <channel> elements before any <programme>,
   * so ids admitted while channels stream in still catch every programme).
   */
  wantedIds: Set<string> | null;
  /** Minutes added to every parsed start/stop (the "guide is hours off" knob). */
  offsetMin: number;
  windowStart: Date;
  /** Programmes intersecting [windowStart, windowEnd) are kept. */
  windowEnd: Date;
  onProgramme: (p: XmltvProgramme) => void;
  onChannel?: (c: XmltvChannelName) => void;
}

/**
 * Incremental XMLTV collector: feed it decoded string chunks, get rows out.
 * Pure — no fs/network/zlib; gunzip and byte→string decoding live in the api.
 * Malformed XML throws out of write()/end() (callers mark the source errored).
 */
export function createXmltvCollector(opts: XmltvCollectorOptions): {
  write(chunk: string): void;
  end(): void;
} {
  const parser = new SaxesParser();
  const offsetMs = opts.offsetMin * 60_000;

  // <channel> state
  let inChannel = false;
  let channelId = "";
  let channelNames: string[] = [];

  // <programme> state
  let inProgramme = false;
  let progChannel = "";
  let progStart: Date | null = null;
  let progStop: Date | null = null;
  let title: string | null = null;
  let titleLang: string | null = null;
  let desc: string | null = null;
  let category: string | null = null;

  // Text accumulation for the element we care about (multi-chunk safe).
  let textTarget: "display-name" | "title" | "desc" | "category" | null = null;
  let textBuf = "";

  parser.on("error", (err) => {
    throw err;
  });

  parser.on("opentag", (tag) => {
    const name = tag.name.toLowerCase();
    const attrs = tag.attributes as Record<string, string>;
    if (name === "channel") {
      inChannel = true;
      channelId = attrs["id"] ?? "";
      channelNames = [];
    } else if (name === "programme") {
      inProgramme = true;
      progChannel = attrs["channel"] ?? "";
      progStart = parseXmltvDate(attrs["start"] ?? "");
      progStop = parseXmltvDate(attrs["stop"] ?? "");
      title = null;
      titleLang = null;
      desc = null;
      category = null;
    } else if (inChannel && name === "display-name") {
      textTarget = "display-name";
      textBuf = "";
    } else if (inProgramme && (name === "title" || name === "desc" || name === "category")) {
      textTarget = name;
      textBuf = "";
      // v1: the FIRST <title> wins; capture its lang attr before it closes.
      if (name === "title" && title === null) titleLang = attrs["lang"] ?? null;
    }
  });

  const onText = (t: string) => {
    if (textTarget) textBuf += t;
  };
  parser.on("text", onText);
  parser.on("cdata", onText);

  parser.on("closetag", (tag) => {
    const name = tag.name.toLowerCase();
    if (textTarget && name === textTarget) {
      const text = textBuf.trim();
      if (name === "display-name") {
        if (text) channelNames.push(text);
      } else if (name === "title") {
        if (title === null && text) title = text; // first one wins (v1)
      } else if (name === "desc") {
        if (desc === null && text) desc = text;
      } else if (name === "category") {
        if (category === null && text) category = text;
      }
      textTarget = null;
      textBuf = "";
      return;
    }
    if (name === "channel" && inChannel) {
      inChannel = false;
      if (channelId && opts.onChannel) opts.onChannel({ id: channelId, names: channelNames });
    } else if (name === "programme" && inProgramme) {
      inProgramme = false;
      if (opts.wantedIds === null) return; // discovery pass
      if (!opts.wantedIds.has(progChannel)) return; // untracked channel
      if (!progStart || !progStop || !title) return; // malformed row → skip
      const start = new Date(progStart.getTime() + offsetMs); // offset AFTER parsing
      const stop = new Date(progStop.getTime() + offsetMs);
      if (!(stop > opts.windowStart && start < opts.windowEnd)) return; // window
      opts.onProgramme({
        epgId: progChannel,
        start,
        stop,
        title,
        description: desc,
        category,
        lang: titleLang,
      });
    }
  });

  return {
    write(chunk: string) {
      parser.write(chunk);
    },
    end() {
      parser.close();
    },
  };
}
