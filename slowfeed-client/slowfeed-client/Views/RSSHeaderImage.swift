import SwiftUI

/// User-configurable layout for the RSS header image shown above each
/// post body. Thumbnail = compact icon-sized chip next to the title,
/// full = wide hero. Picker lives in App Settings.
enum RSSImageStyle: String, Codable, CaseIterable, Identifiable {
    case thumbnail
    case full

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .thumbnail: return "Thumbnail"
        case .full: return "Full Image"
        }
    }
}

/// Renders the first image from an RSS post's HTML as either a small
/// thumbnail or a full-width hero, per the user's `rssImageStyle`.
/// Lives between the post title and the post body in `PostView`.
struct RSSHeaderImage: View {
    let urlString: String
    let style: RSSImageStyle

    private var url: URL? { URL(string: urlString) }

    var body: some View {
        switch style {
        case .thumbnail:
            CachedImage(url: url) {
                RoundedRectangle(cornerRadius: 8)
                    .fill(.quaternary)
                    .frame(width: 88, height: 88)
            }
            .aspectRatio(contentMode: .fill)
            .frame(width: 88, height: 88)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        case .full:
            CachedImage(url: url) {
                RoundedRectangle(cornerRadius: 10)
                    .fill(.quaternary)
                    .aspectRatio(16.0 / 9.0, contentMode: .fit)
            }
            .aspectRatio(contentMode: .fit)
            .frame(maxWidth: 600)
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }
}
