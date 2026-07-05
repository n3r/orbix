# Product

## Register

product

## Users

**The household, on the couch — plus the admin who set it up.** Orbix runs on a self-hoster's NAS and serves everyone under one roof:

- **Viewers** (adults, teens, kids) arrive after login, pick a Netflix-style profile, and want one thing: to find something worth watching tonight and start it fast — on a laptop, phone, tablet, or a TV browser across the room. Their library is large (1000+ titles), personal, and often watched during an internet outage. They are not "users of a homelab tool"; they expect the fluency of a commercial streaming app.
- **The admin** (one technically-comfortable household member) also lives in the same UI: adding libraries, fixing metadata mismatches, tuning the encoder, managing TV channels. These technical surfaces are used rarely but must feel as considered as the browse experience — the admin is still a household member, not a sysadmin at a console.
- **Kids** get a server-enforced, maturity-capped view. Safety is not a UI toggle; it is guaranteed on every route. The design must make "the right person is watching" legible and trustworthy.

## Product Purpose

Orbix is a **self-hosted, offline-capable media server that feels like your own Netflix** for a personal library. It exists to beat the incumbents (Plex, Jellyfin) on three axes:

1. **Discovery for large libraries** — auto-generated home rails plus natural-language mood search ("something light and funny under 2 hours"), powered by local embeddings, so you find what to watch without scrolling thousands of posters.
2. **Works offline** — all metadata and artwork are cached to local disk at scan time; browsing and playback never touch the internet.
3. **A genuinely nice, fast UI** — modern, responsive, poster-forward, cinematic. This is the differentiator and the reason Impeccable is here.

Success looks like: a household member opens Orbix, and within seconds — with no spinner, no clutter, no "which server am I on" — is watching. And a first-time visitor can't tell it isn't a commercial streaming product.

## Brand Personality

**Cinematic, premium, and quietly personal.** Three words: **immersive, effortless, trustworthy.**

- The content is the star. Chrome recedes into layered darks; posters, backdrops, and video are the brightest, most saturated things on screen.
- The signature is the **indigo → violet "orbit" accent** (`#6d7bff → #a06dff`) — a small, deliberate identity that distinguishes Orbix from Netflix red and from every other streaming clone. Red is reserved strictly for errors, destructive actions, and the live-TV indicator.
- Voice is calm and confident, never chatty or cute. It behaves like a product that has nothing to prove.
- The emotional goal on the browse surfaces is *anticipation* (the feeling of scanning a great shelf); on the admin surfaces it is *ease and control*.

## Anti-references

- **Generic SaaS / Bootstrap admin.** No cards-everywhere, gray-on-gray, template-dashboard energy — especially not on the admin, settings, and fix-match screens. The technical surfaces must feel like Orbix, not like a config panel bolted onto a media app.
- **Sterile minimalism.** Not stripped so bare it feels empty or cold. Orbix is dark but *rich* — depth, warmth, layered surfaces, considered motion. Empty states teach and invite; they never read as "nothing here."
- (Implicitly) the cluttered, utilitarian homelab-tool aesthetic of Plex/Jellyfin — many controls, weak hierarchy, technical jargon in the viewer's face.

## Design Principles

1. **Content is the interface.** The brightest, most saturated pixels on any browse screen belong to the artwork and video. Chrome — nav, controls, metadata — recedes so the library can shine. When in doubt, remove UI, don't add it.
2. **Fast enough to feel local — because it is.** Interactions should feel instant. Prefer skeletons and cached frames over spinners; keep motion in the 150–250 ms band on task surfaces so the UI never makes someone wait to browse. Perceived speed is a feature, not a nicety.
3. **A streaming product, not a homelab tool.** Every surface — including Libraries, Encoder settings, Fix-Match, and the TV channel manager — gets the same craft as the home screen. No gray SaaS fallback for "the technical parts." The admin is a household member too.
4. **Rich, not sterile.** Warmth and depth beat empty minimalism. Layered darks, the orbit accent used with intent, and purposeful motion give the product life. Delight is earned in moments (a resume bar, a hover-promote, a first-run welcome), not sprayed across every screen.
5. **Trust is designed, not assumed.** Profiles, kids-mode, and offline status are load-bearing. Make it always legible who is watching, what is safe, and that the library is there even when the internet isn't — the household should never have to wonder.

## Accessibility & Inclusion

- **Target: WCAG 2.1 AA.** Body text ≥ 4.5:1 against its background; large/bold text ≥ 3:1. This is non-trivial on a dark, poster-forward UI where text sits over artwork — text over images needs scrims/gradients, not hope. The existing `--text-dim` (`#9aa3b2`) must be verified per-surface, never assumed to pass.
- **Reduced motion is not optional.** Every animation (hover-promote, billboard transitions, row scroll, player chrome) needs a `prefers-reduced-motion: reduce` alternative — typically a crossfade or an instant state change.
- **Full keyboard operability.** Every control is reachable and operable by keyboard with a visible focus ring, including the virtualized TV time×channel grid, the media rows, and the player overlay. Focus must be managed on route/overlay changes.
- **Household inclusivity.** Legible at couch distance and on phones; kids surfaces are simple and forgiving; nothing critical is conveyed by color alone (pair the live/error red and the orbit accent with icon or text).
