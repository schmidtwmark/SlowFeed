import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// A single post card: header + title + content + media + links + embeds + comments.
///
/// The header (avatar, author, chips, date) lives in ``PostHeaderView`` — edit
/// layout tweaks there. This view orchestrates the order of the sections and
/// handles interactions (tap to open, context menu, focus highlight).
struct PostView: View {
    let post: DigestPost
    var source: SourceType = .reddit
    var digestId: String?
    var imageNamespace: Namespace.ID?
    var onSelectImage: (([PostMedia], Int) -> Void)?
    var quotedPost: DigestPost?
    /// Callback invoked when this card wants to push the RSS reader.
    /// Owned by `DigestView` so the destination is registered once at the
    /// NavigationStack root rather than per-post inside a ForEach
    /// (which produced a dead "Read more" / dead long-card tap).
    var onOpenReader: ((DigestPost) -> Void)?

    @Environment(\.openURL) private var openURL
    @Environment(AppState.self) private var appState
    @State private var debugJSON: String?
    /// Expansion state for long Reddit selftext (Show more / Show less).
    @State private var isContentExpanded = false
    #if os(iOS)
    /// In-app SFSafariViewController target. Set to a non-nil URL to
    /// present the sheet; the sheet sets it back to nil on dismiss.
    @State private var safariTarget: SafariSheetTarget?
    #endif

    private var postURL: URL? {
        guard let urlString = post.url, !urlString.isEmpty else { return nil }
        // Normalize old.reddit.com → reddit.com for existing cached data
        let normalized = urlString.replacingOccurrences(of: "://old.reddit.com", with: "://reddit.com")
        return URL(string: normalized)
    }

    /// Strip legacy "r/subreddit: " prefix from Reddit titles.
    private var displayTitle: String {
        post.title.replacingOccurrences(of: #"^r/\w+:\s*"#, with: "", options: .regularExpression)
    }

    /// True if the title is just a synthetic restatement of the content,
    /// ignoring whitespace, punctuation, and "author: " / "#channel - @user: "
    /// prefixes that the server builds for Bluesky and Discord posts.
    private var titleIsDuplicate: Bool {
        guard let content = post.content, !content.isEmpty else { return false }
        let normTitle = normalizeForCompare(displayTitle)
        let normContent = normalizeForCompare(content)
        guard normTitle.count >= 4, normContent.count >= 4 else { return false }

        // Exact containment in either direction catches `title = "@handle: X"`
        // when content = X, or `title = X` when content starts with X.
        if normTitle.contains(normContent) || normContent.contains(normTitle) {
            return true
        }

        // Server truncates some synthetic titles (e.g. Bluesky caps at 100 chars),
        // so the title may only cover a prefix of the content. If ≥80% of the
        // shorter string matches as a substring of the longer, treat as duplicate.
        let (shorter, longer) = normTitle.count <= normContent.count
            ? (normTitle, normContent)
            : (normContent, normTitle)
        let cutoff = max(20, Int(Double(shorter.count) * 0.8))
        guard shorter.count >= cutoff else { return false }
        let probe = String(shorter.prefix(cutoff))
        return longer.contains(probe)
    }

    private func normalizeForCompare(_ s: String) -> String {
        let folded = s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
        return folded.unicodeScalars
            .filter { CharacterSet.alphanumerics.contains($0) }
            .map { String($0) }
            .joined()
    }

    private var isFocused: Bool {
        appState.focusedPostId == post.postId && appState.keyboardFocusPane == .posts
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            PostHeaderView(post: post, source: source, onOpenURL: { url in
                openPostURL(url, forceExternal: false)
            })

            // Title — Reddit, YouTube, and RSS all have real editorial titles.
            // Bluesky / Discord / Mastodon titles are server-synthesized and
            // just restate the author or content, so they stay hidden.
            // RSS titles are always editorial; the duplicate check only
            // applies to Reddit/YouTube where it can fire on quoted bodies.
            if !displayTitle.isEmpty,
               source == .rss
                || ((source == .reddit || source == .youtube) && !titleIsDuplicate) {
                Text(displayTitle)
                    .font(.headline)
                    .foregroundStyle(.primary)
            }

            // Reddit link flair ("Discussion", "OC", …), colored like the
            // subreddit's flair when the server captured colors.
            if source == .reddit, let flair = post.metadata?.flair, !flair.isEmpty {
                FlairChip(
                    text: flair,
                    backgroundHex: post.metadata?.flairBackgroundColor,
                    textScheme: post.metadata?.flairTextColor
                )
            }

            // RSS header image (first <img> from the article HTML).
            // Sized per the user's rssImageStyle setting.
            if source == .rss,
               let urlString = post.metadata?.headerImageURL,
               !urlString.isEmpty {
                RSSHeaderImage(urlString: urlString, style: appState.rssImageStyle)
            }

            // Body
            if source == .rss {
                rssBody
            } else if source == .reddit, let content = post.content, !content.isEmpty {
                redditBody(content)
            } else if let content = post.content, !content.isEmpty {
                Text(content.linkified())
                    .font(.body)
                    .foregroundStyle(.primary.opacity(0.85))
                    .lineLimit(10)
                    .tint(.accentColor)
            }

            // Media
            if let media = post.media, !media.isEmpty {
                MediaView(media: media,
                          postTitle: post.title,
                          imageNamespace: imageNamespace,
                          onSelectImage: onSelectImage,
                          isNSFW: post.metadata?.nsfw == true)
            }

            // External links
            if let links = post.links, !links.isEmpty {
                ForEach(links, id: \.url) { link in
                    LinkCardView(link: link)
                }
            }

            // Embeds (quote posts, link cards from Discord embeds, etc.)
            if let embeds = post.embeds, !embeds.isEmpty {
                ForEach(Array(embeds.enumerated()), id: \.offset) { _, embed in
                    EmbedView(embed: embed)
                }
            }

            // Inline Bluesky-quoted post
            if let quoted = quotedPost {
                QuotedPostBubble(post: quoted,
                                 imageNamespace: imageNamespace,
                                 onSelectImage: onSelectImage)
            }

            // Comments (Reddit)
            if let comments = post.comments, !comments.isEmpty {
                CommentsView(comments: comments)
            }

            metadataFooter
        }
        // Hard-clamp the post card to the available width — without this
        // any inner content with intrinsic width (long URLs, hardcoded
        // image maxWidth) can push the digest list wider than the screen on
        // iPhone, producing horizontal scroll.
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(isFocused ? Color.accentColor.opacity(0.08) : Color.clear)
        .overlay(alignment: .leading) {
            if isFocused {
                Rectangle()
                    .fill(Color.accentColor)
                    .frame(width: 3)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { handleCardTap() }
        .contextMenu { contextMenu }
        .sheet(item: $debugJSON) { json in
            DebugJSONView(title: "Post JSON", json: json)
        }
        #if os(iOS)
        .sheet(item: $safariTarget) { target in
            SafariView(url: target.url)
                .ignoresSafeArea()
        }
        #endif
    }

    /// Tap on the post card. RSS overrides the default open-original-URL
    /// behavior to match the user's "tap a long post → reader view" spec.
    private func handleCardTap() {
        appState.focusedPostId = post.postId
        appState.keyboardFocusPane = .posts

        if source == .rss, let content = post.content,
           content.count > Self.rssShortPostThreshold {
            onOpenReader?(post)
            return
        }

        if let url = postURL { openPostURL(url, forceExternal: false) }
    }

    /// Open a post URL honoring the user's `browserPreference`. When
    /// `forceExternal` is true (the long-press "Open in Safari" menu
    /// item), bypass the preference and always hand off to the system
    /// browser. macOS only has the system browser, so the preference
    /// is effectively a no-op there.
    private func openPostURL(_ url: URL, forceExternal: Bool) {
        #if os(iOS)
        if !forceExternal && appState.browserPreference == .inApp {
            safariTarget = SafariSheetTarget(url: url)
        } else {
            openURL(url)
        }
        #else
        openURL(url)
        #endif
    }

    // MARK: - Reddit body

    /// Selftext longer than this renders collapsed behind "Show more".
    /// The server no longer truncates, so the full text is always here.
    private static let redditCollapseThreshold: Int = 600

    /// Body for Reddit selftext. Long posts collapse to 10 lines with an
    /// in-place Show more / Show less toggle — the full content is readable
    /// without leaving the app.
    @ViewBuilder
    private func redditBody(_ content: String) -> some View {
        let isLong = content.count > Self.redditCollapseThreshold
        VStack(alignment: .leading, spacing: 6) {
            Text(content.linkified())
                .font(.body)
                .foregroundStyle(.primary.opacity(0.85))
                .lineLimit(isLong && !isContentExpanded ? 10 : nil)
                .tint(.accentColor)
            if isLong {
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        isContentExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(isContentExpanded ? "Show less" : "Show more")
                            .fontWeight(.medium)
                        Image(systemName: isContentExpanded ? "chevron.up" : "chevron.down")
                    }
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - RSS body

    /// Anything below this length renders inline; longer posts render a
    /// preview + "Read more" that pushes the full reader. Roughly 250 words.
    private static let rssShortPostThreshold: Int = 1500

    /// Body for RSS posts. Short posts render the entire stripped text
    /// inline; longer ones get a preview with a `NavigationLink` to
    /// ``RSSReaderView`` for the full HTML.
    @ViewBuilder
    private var rssBody: some View {
        if let content = post.content, !content.isEmpty {
            let isShort = content.count <= Self.rssShortPostThreshold
            if isShort {
                Text(content)
                    .font(.body)
                    .foregroundStyle(.primary.opacity(0.9))
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text(content)
                        .font(.body)
                        .foregroundStyle(.primary.opacity(0.85))
                        .lineLimit(8)
                    Button {
                        onOpenReader?(post)
                    } label: {
                        HStack(spacing: 4) {
                            Text("Read more")
                                .fontWeight(.medium)
                            Image(systemName: "arrow.right")
                        }
                        .font(.caption)
                        .foregroundStyle(.orange)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    /// True when at least one left-side metric (score, comments, video duration)
    /// will render in the footer.
    private var hasFooterMetrics: Bool {
        post.metadata?.score != nil
            || post.metadata?.numComments != nil
            || post.metadata?.duration != nil
    }

    /// Bottom metadata row. When the header took the top-right slot for a
    /// source chip (Reddit/Discord), the date lives here:
    /// - Reddit has left-side metrics, so the date goes bottom-right.
    /// - Discord has no metrics, so the date goes bottom-left.
    /// When the header is already showing the date (Bluesky/YouTube), this
    /// row just shows any left metrics.
    private var metadataFooter: some View {
        HStack(spacing: 12) {
            let showFooterDate = post.showsPrimaryHeaderChip && post.publishedAt != nil

            if showFooterDate, !hasFooterMetrics, let date = post.publishedAt {
                // No left metrics (e.g. Discord) → date on the left.
                timestampLabel(for: date)
                Spacer()
            } else {
                if let score = post.metadata?.score {
                    Label("\(score)", systemImage: "arrow.up")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let numComments = post.metadata?.numComments {
                    Label("\(numComments)", systemImage: "bubble.right")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let duration = post.metadata?.duration {
                    Label(duration, systemImage: "clock")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if showFooterDate, let date = post.publishedAt {
                    timestampLabel(for: date)
                }
            }
        }
    }

    private func timestampLabel(for date: Date) -> some View {
        Text(formatPostTimestamp(date))
            .font(.caption)
            .foregroundStyle(.tertiary)
            .lineLimit(1)
            .fixedSize()
    }

    @ViewBuilder
    private var contextMenu: some View {
        if let url = postURL {
            // "Open" honors the browser preference (in-app vs Safari).
            // "Open in Safari" always hands off to the system browser
            // regardless of the preference, so the user can override
            // per-post via long-press.
            Button { openPostURL(url, forceExternal: false) } label: {
                Label("Open", systemImage: "safari")
            }
            #if os(iOS)
            if appState.browserPreference == .inApp {
                Button { openPostURL(url, forceExternal: true) } label: {
                    Label("Open in Safari", systemImage: "safari.fill")
                }
            }
            #endif

            Button {
                #if os(macOS)
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(url.absoluteString, forType: .string)
                #else
                UIPasteboard.general.string = url.absoluteString
                #endif
            } label: { Label("Copy Link", systemImage: "doc.on.doc") }

            ShareLink("Share Link", item: url)
        }

        Divider()

        Button {
            Task { await appState.toggleSavePost(post, source: source, digestId: digestId) }
        } label: {
            if appState.savedPostIds.contains(post.postId) {
                Label("Unsave", systemImage: "bookmark.slash")
            } else {
                Label("Save for Later", systemImage: "bookmark")
            }
        }

        Divider()

        Button {
            debugJSON = prettyJSON(post)
        } label: {
            Label("Show Raw JSON", systemImage: "curlybraces")
        }
    }
}

// MARK: - Flair chip

/// Small capsule showing a Reddit post's link flair. Uses the subreddit's
/// flair colors when the server captured them (`backgroundHex` +
/// Reddit's "light"/"dark" `textScheme`), falling back to a neutral
/// tinted chip.
struct FlairChip: View {
    let text: String
    var backgroundHex: String?
    var textScheme: String?

    var body: some View {
        Text(text)
            .font(.caption2)
            .fontWeight(.medium)
            .lineLimit(1)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(backgroundColor, in: Capsule())
            .foregroundStyle(foregroundColor)
    }

    private var backgroundColor: Color {
        Color(hex: backgroundHex ?? "") ?? Color.secondary.opacity(0.18)
    }

    private var foregroundColor: Color {
        guard Color(hex: backgroundHex ?? "") != nil else { return .secondary }
        // Reddit's flair schemes: "light" = light text on a dark bg,
        // "dark" = dark text on a light bg.
        return textScheme == "dark" ? .black : .white
    }
}

extension Color {
    /// Parse "#RRGGBB" / "RRGGBB" (Reddit's flair color format). Returns nil
    /// for empty / malformed strings so callers can fall back.
    init?(hex: String) {
        let cleaned = hex.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "#", with: "")
        guard cleaned.count == 6, let value = UInt64(cleaned, radix: 16) else { return nil }
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}

// MARK: - Timestamp Formatting

/// Human-friendly timestamp for a post. "Today at 7:40 PM" or
/// "Yesterday at 4:16 PM" within the last two days; the abbreviated date and
/// time (e.g. "Apr 16, 2026 at 7:40 PM") otherwise.
func formatPostTimestamp(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
    let timeString = date.formatted(date: .omitted, time: .shortened)
    if calendar.isDateInToday(date) {
        return "Today at \(timeString)"
    }
    if calendar.isDateInYesterday(date) {
        return "Yesterday at \(timeString)"
    }
    return date.formatted(date: .abbreviated, time: .shortened)
}

// MARK: - Previews

#if DEBUG
#Preview("Reddit — long handle") {
    PostView(post: PreviewPostSamples.redditLongHandle, source: .reddit)
        .environment(AppState())
        .frame(width: 440)
}

#Preview("Reddit — image + body") {
    PostView(post: PreviewPostSamples.redditImagePost, source: .reddit)
        .environment(AppState())
        .frame(width: 440)
}

#Preview("Reddit — text only") {
    PostView(post: PreviewPostSamples.redditTextPost, source: .reddit)
        .environment(AppState())
        .frame(width: 440)
}

#Preview("Bluesky — repost with quote embed") {
    PostView(post: PreviewPostSamples.blueskyRepost, source: .bluesky)
        .environment(AppState())
        .frame(width: 440)
}

#Preview("Bluesky — gallery with alt text") {
    PostView(post: PreviewPostSamples.blueskyGallery, source: .bluesky)
        .environment(AppState())
        .frame(width: 500)
}

#Preview("Discord — meme channel (title dedup)") {
    PostView(post: PreviewPostSamples.discordMeme, source: .discord)
        .environment(AppState())
        .frame(width: 440)
}

#Preview("Notification") {
    PostView(post: PreviewPostSamples.blueskyNotification, source: .bluesky)
        .environment(AppState())
        .frame(width: 440)
}

#Preview("YouTube — dedup author / channel") {
    PostView(post: PreviewPostSamples.youtubeVideo, source: .youtube)
        .environment(AppState())
        .frame(width: 440)
}

#Preview("Mastodon") {
    PostView(post: PreviewPostSamples.mastodonPost, source: .mastodon)
        .environment(AppState())
        .frame(width: 440)
}

#Preview("Timestamps — today / yesterday / older") {
    ScrollView {
        VStack(alignment: .leading, spacing: 0) {
            PostView(post: PreviewPostSamples.redditLongHandle, source: .reddit)
            Divider()
            PostView(post: PreviewPostSamples.redditImagePost, source: .reddit)
            Divider()
            PostView(post: PreviewPostSamples.redditTextPost, source: .reddit)
        }
    }
    .environment(AppState())
    .frame(width: 440, height: 700)
}
#endif
