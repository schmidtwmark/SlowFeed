import SwiftUI

/// Header section of a post card: avatar + name/handle on the left, and on the
/// right either a source chip (Reddit subreddit / Discord channel) OR the
/// published date. When a chip is shown, the date moves to ``PostView``'s
/// metadata footer; otherwise the date lives here in the header.
///
/// Layout rules:
/// - Name/handle always `.lineLimit(1)` with tail truncation so long hyphenated
///   usernames (e.g. `u/MarvelsGrant-Man136`) don't wrap into an L-shape.
/// - The identity VStack is `.fixedSize(vertical: true)` so it can't compress
///   into two flat lines when the row gets tight.
/// - The right side shows at most one piece: chip takes precedence over date.
///   Notification bell (when present) renders to the left of either.
struct PostHeaderView: View {
    let post: DigestPost
    /// Source for URL construction — Reddit users → reddit.com/u/...,
    /// Bluesky handles → bsky.app/profile/..., etc. Defaults to
    /// `.reddit` for backwards compat with old call sites.
    var source: SourceType = .reddit
    /// Called with a profile / subreddit URL when the user taps the
    /// avatar, name, or source chip. PostView wires this to
    /// `openPostURL` so it honors the in-app browser preference.
    var onOpenURL: ((URL) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let repostedBy = post.metadata?.repostedBy {
                Label("Reposted by \(repostedBy)", systemImage: "arrow.2.squarepath")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(alignment: .center, spacing: 8) {
                identityTapTarget {
                    HStack(alignment: .center, spacing: 8) {
                        avatar
                        identityBlock
                    }
                }
                Spacer(minLength: 8)
                topRightAccessories
            }
        }
    }

    /// Wraps the avatar + identityBlock in a tappable Button when we
    /// can derive a profile URL for this source; otherwise renders the
    /// content as a plain HStack.
    @ViewBuilder
    private func identityTapTarget<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        if let url = profileURL, let onOpenURL {
            Button { onOpenURL(url) } label: { content() }
                .buttonStyle(.plain)
                .accessibilityLabel("Open profile")
        } else {
            content()
        }
    }

    @ViewBuilder
    private var avatar: some View {
        if let avatarUrl = post.metadata?.avatarUrl, let url = URL(string: avatarUrl) {
            CachedImage(url: url) { Circle().fill(.quaternary) }
                .aspectRatio(contentMode: .fill)
                .clipShape(Circle())
                .frame(width: 28, height: 28)
        }
    }

    @ViewBuilder
    private var identityBlock: some View {
        if let displayName = post.metadata?.displayName, !displayName.isEmpty {
            VStack(alignment: .leading, spacing: 1) {
                Text(displayName)
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if let author = post.author, !author.isEmpty {
                    Text(author)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        } else if let author = post.author, !author.isEmpty {
            Text(author)
                .font(.subheadline)
                .fontWeight(.medium)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
    }

    /// Build a profile URL from the post's author / metadata, scoped
    /// to the source. Returns nil for sources where there's no
    /// reasonable profile URL (Discord DMs, RSS items, …).
    private var profileURL: URL? {
        switch source {
        case .reddit:
            guard let author = post.author, !author.isEmpty else { return nil }
            // Reddit `author` can be either "username" or "u/username".
            let user = author.hasPrefix("u/") ? String(author.dropFirst(2)) : author
            return URL(string: "https://reddit.com/u/\(user)")
        case .bluesky:
            guard let author = post.author, !author.isEmpty else { return nil }
            let handle = author.hasPrefix("@") ? String(author.dropFirst()) : author
            return URL(string: "https://bsky.app/profile/\(handle)")
        case .youtube:
            if let urlString = post.metadata?.channelUrl, let url = URL(string: urlString) {
                return url
            }
            return nil
        case .mastodon:
            // Authors look like "@user@instance.tld" — convert to a
            // browser profile URL on that instance.
            guard let author = post.author, !author.isEmpty else { return nil }
            let trimmed = author.hasPrefix("@") ? String(author.dropFirst()) : author
            let parts = trimmed.split(separator: "@", maxSplits: 1).map(String.init)
            if parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty {
                return URL(string: "https://\(parts[1])/@\(parts[0])")
            }
            return nil
        case .discord, .rss:
            return nil
        }
    }

    /// Build a subreddit URL (Reddit only). Used when the user taps
    /// the `r/subreddit` chip in `primaryChip`.
    private var subredditURL: URL? {
        guard source == .reddit,
              let sub = post.metadata?.subreddit,
              !sub.isEmpty else { return nil }
        return URL(string: "https://reddit.com/r/\(sub)")
    }

    /// Top-right cluster: optional notification bell, followed by either the
    /// source chip or the published date (chip wins when both are present).
    @ViewBuilder
    private var topRightAccessories: some View {
        HStack(spacing: 6) {
            if post.isNotification == true {
                Image(systemName: "bell.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .accessibilityLabel("Notification")
            }
            if post.showsPrimaryHeaderChip {
                primaryChip
            } else if let date = post.publishedAt {
                Text(formatPostTimestamp(date))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
        .fixedSize()
    }

    /// Renders the single source chip. Call-sites should first check
    /// ``DigestPost.showsPrimaryHeaderChip`` to decide whether to use this.
    @ViewBuilder
    private var primaryChip: some View {
        if let subreddit = post.metadata?.subreddit, !subreddit.isEmpty {
            // Reddit chip is a tap target → opens the subreddit page.
            if let url = subredditURL, let onOpenURL {
                Button { onOpenURL(url) } label: {
                    HeaderChip(text: "r/\(subreddit)", color: .orange)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open r/\(subreddit)")
            } else {
                HeaderChip(text: "r/\(subreddit)", color: .orange)
            }
        } else if let channelName = post.metadata?.channelName, !channelName.isEmpty {
            HeaderChip(text: "#\(channelName)", color: .purple)
        } else if let feedTitle = post.metadata?.feedTitle, !feedTitle.isEmpty {
            HeaderChip(text: feedTitle, color: .orange)
        }
    }
}

// MARK: - Primary chip rule

extension DigestPost {
    /// True when the header should render a chip on the right (Reddit
    /// subreddit, Discord channel, or RSS feed title). Bluesky / YouTube /
    /// Mastodon don't get a chip. When this is true ``PostView`` moves the
    /// published date to the footer.
    var showsPrimaryHeaderChip: Bool {
        if let s = metadata?.subreddit, !s.isEmpty { return true }
        if let n = metadata?.channelName, !n.isEmpty { return true }
        if let f = metadata?.feedTitle, !f.isEmpty { return true }
        return false
    }
}

/// Small capsule label used in the chip row.
struct HeaderChip: View {
    var systemImage: String?
    let text: String
    let color: Color

    var body: some View {
        HStack(spacing: 3) {
            if let systemImage {
                Image(systemName: systemImage).font(.caption2)
            }
            Text(text)
                .font(.caption2)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(color.opacity(0.12), in: Capsule())
    }
}

// MARK: - Previews

#if DEBUG
#Preview("Reddit — long hyphenated handle") {
    PostHeaderView(post: PreviewPostSamples.redditLongHandle)
        .padding()
        .frame(width: 380)
}

#Preview("Bluesky — displayName + handle + repost") {
    PostHeaderView(post: PreviewPostSamples.blueskyRepost)
        .padding()
        .frame(width: 380)
}

#Preview("Discord — channel chip") {
    PostHeaderView(post: PreviewPostSamples.discordMeme)
        .padding()
        .frame(width: 380)
}

#Preview("Notification") {
    PostHeaderView(post: PreviewPostSamples.blueskyNotification)
        .padding()
        .frame(width: 380)
}

#Preview("YouTube — channel == author (chip suppressed)") {
    PostHeaderView(post: PreviewPostSamples.youtubeVideo)
        .padding()
        .frame(width: 380)
}

#Preview("Narrow width — all variants") {
    ScrollView {
        VStack(alignment: .leading, spacing: 16) {
            PostHeaderView(post: PreviewPostSamples.redditLongHandle)
            Divider()
            PostHeaderView(post: PreviewPostSamples.blueskyRepost)
            Divider()
            PostHeaderView(post: PreviewPostSamples.discordMeme)
            Divider()
            PostHeaderView(post: PreviewPostSamples.blueskyNotification)
            Divider()
            PostHeaderView(post: PreviewPostSamples.youtubeVideo)
        }
        .padding()
    }
    .frame(width: 320, height: 600)
}
#endif
