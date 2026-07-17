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
///
/// Owns its load (rather than using `CachedImage`) so a FAILED image can
/// collapse to nothing: email-derived feeds (Kill the Newsletter) often
/// reference images that 403 outside the mail client, and the old
/// always-there 16:9 placeholder rendered as a giant near-invisible box
/// between the title and body.
struct RSSHeaderImage: View {
    let urlString: String
    let style: RSSImageStyle

    @State private var image: PlatformImage?
    /// True once the first load attempt finished (success or failure).
    @State private var resolved = false

    private var url: URL? { URL(string: urlString) }

    var body: some View {
        Group {
            if let image {
                loadedBody(image)
            } else if !resolved {
                placeholderBody
            }
            // else: load failed → render nothing; the post just has no hero.
        }
        .task(id: url) {
            guard let url else { resolved = true; return }
            image = ImageCache.shared.image(for: url)
            if image == nil {
                image = await ImageLoader.shared.image(for: url)
            }
            resolved = true
        }
    }

    @ViewBuilder
    private func loadedBody(_ image: PlatformImage) -> some View {
        #if os(macOS)
        let img = Image(nsImage: image)
        #else
        let img = Image(uiImage: image)
        #endif
        switch style {
        case .thumbnail:
            img.resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: 88, height: 88)
                .clipShape(RoundedRectangle(cornerRadius: 8))
        case .full:
            img.resizable()
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: 600, maxHeight: 500)
                .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }

    @ViewBuilder
    private var placeholderBody: some View {
        switch style {
        case .thumbnail:
            RoundedRectangle(cornerRadius: 8)
                .fill(.quaternary)
                .frame(width: 88, height: 88)
        case .full:
            // Short strip, not a 16:9 block — it exists for a moment while
            // the image loads; a giant reserved box reads as a broken post.
            RoundedRectangle(cornerRadius: 10)
                .fill(.quaternary)
                .frame(maxWidth: 600)
                .frame(height: 120)
        }
    }
}
