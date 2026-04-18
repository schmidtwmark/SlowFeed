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

    @Environment(\.openURL) private var openURL
    @Environment(AppState.self) private var appState
    @State private var debugJSON: String?

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
            PostHeaderView(post: post)

            // Title — Reddit is the only source with a real editorial title.
            // Bluesky / Discord / YouTube all have server-synthesized titles
            // that just restate the author or content.
            if source == .reddit, !titleIsDuplicate, !displayTitle.isEmpty {
                Text(displayTitle)
                    .font(.headline)
                    .foregroundStyle(.primary)
            }

            // Body
            if let content = post.content, !content.isEmpty {
                Text(content)
                    .font(.body)
                    .foregroundStyle(.primary.opacity(0.85))
                    .lineLimit(10)
            }

            // Media
            if let media = post.media, !media.isEmpty {
                MediaView(media: media,
                          postTitle: post.title,
                          imageNamespace: imageNamespace,
                          onSelectImage: onSelectImage)
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
        .onTapGesture {
            appState.focusedPostId = post.postId
            appState.keyboardFocusPane = .posts
            if let url = postURL { openURL(url) }
        }
        .contextMenu { contextMenu }
        .sheet(item: $debugJSON) { json in
            DebugJSONView(title: "Post JSON", json: json)
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
            Button { openURL(url) } label: { Label("Open", systemImage: "safari") }

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
