import SwiftUI

/// Rating chips for the title hero — tvOS port of the web's
/// `apps/web/src/components/RatingBadges.tsx`. Every value is optional — this
/// renders only the chips it's handed and collapses to nothing (via the
/// `if hasAny` gate in `body`) when none are present, so it degrades cleanly
/// before the ratings-ingestion phase (Phase 3 Task 1) populates the data for
/// a given title.
struct RatingBadges: View {
    let imdbRating: Double?
    let rtRating: Int?
    let tmdbScore: Double?
    let metacritic: Int?
    let mpaa: String?

    private var hasAny: Bool {
        imdbRating != nil || rtRating != nil || tmdbScore != nil || metacritic != nil
            || (mpaa?.isEmpty == false)
    }

    var body: some View {
        if hasAny {
            HStack(spacing: 8) {
                if let imdbRating {
                    imdbChip(imdbRating)
                }
                if let rtRating {
                    rtChip(rtRating)
                }
                if let tmdbScore {
                    tmdbChip(tmdbScore)
                }
                if let metacritic {
                    metacriticChip(metacritic)
                }
                if let mpaa, !mpaa.isEmpty {
                    mpaaPlate(mpaa)
                }
            }
            .font(.system(size: 22, weight: .medium))
            .accessibilityIdentifier("ratingBadges")
        }
    }

    /// Web line 32: `bg-[#f5c518]` + black text. `#f5c518` is IMDb's brand
    /// yellow, not a design token — the web hardcodes it too (see the brief),
    /// so it's intentionally the one non-`OrbixColor` literal in this view.
    private func imdbChip(_ rating: Double) -> some View {
        HStack(spacing: 4) {
            Text("IMDb")
                .font(.system(size: 15, weight: .bold))
            Text(fmt1(rating))
        }
        .foregroundStyle(.black)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color(red: 0xF5 / 255, green: 0xC5 / 255, blue: 0x18 / 255))
        .clipShape(RoundedRectangle(cornerRadius: OrbixRadius.chip, style: .continuous))
    }

    /// Web line 39: `rtRating >= 60 ? "🍅" : "🤢"`.
    private func rtChip(_ rating: Int) -> some View {
        chip {
            HStack(spacing: 4) {
                Text(rating >= 60 ? "🍅" : "🤢")
                Text("\(rating)%")
            }
        }
    }

    private func tmdbChip(_ score: Double) -> some View {
        chip {
            HStack(spacing: 4) {
                Text("TMDB")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(OrbixColor.accent)
                Text(fmt1(score))
            }
        }
    }

    private func metacriticChip(_ score: Int) -> some View {
        chip {
            HStack(spacing: 4) {
                Text("MC")
                    .font(.system(size: 15, weight: .semibold))
                Text("\(score)")
            }
        }
    }

    /// Web line 56: bordered plate rather than a filled chip.
    private func mpaaPlate(_ rating: String) -> some View {
        Text(rating)
            .foregroundStyle(OrbixColor.textDim)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .overlay {
                RoundedRectangle(cornerRadius: OrbixRadius.chip, style: .continuous)
                    .strokeBorder(OrbixColor.textDim.opacity(0.4))
            }
    }

    @ViewBuilder
    private func chip(@ViewBuilder content: () -> some View) -> some View {
        content()
            .foregroundStyle(OrbixColor.text)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(OrbixColor.surface2)
            .clipShape(RoundedRectangle(cornerRadius: OrbixRadius.chip, style: .continuous))
    }

    private func fmt1(_ value: Double) -> String {
        String(format: "%.1f", value)
    }
}

#Preview {
    RatingBadges(
        imdbRating: 8.4,
        rtRating: 92,
        tmdbScore: 7.6,
        metacritic: 71,
        mpaa: "PG-13"
    )
    .padding(40)
    .background(OrbixColor.bg)
}
