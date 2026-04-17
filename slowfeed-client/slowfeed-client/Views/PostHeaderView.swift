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

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let repostedBy = post.metadata?.repostedBy {
                Label("Reposted by \(repostedBy)", systemImage: "arrow.2.squarepath")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(alignment: .center, spacing: 8) {
                avatar
                identityBlock
                Spacer(minLength: 8)
                topRightAccessories
            }
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
            HeaderChip(text: "r/\(subreddit)", color: .orange)
        } else if let channelName = post.metadata?.channelName, !channelName.isEmpty {
            HeaderChip(text: "#\(channelName)", color: .purple)
        }
    }
}

// MARK: - Primary chip rule

extension DigestPost {
    /// True when the header should render a chip on the right (Reddit subreddit
    /// or Discord channel). Bluesky and YouTube don't get a chip — Bluesky
    /// has no equivalent category, and YouTube's channel is already shown as
    /// the author. When this is true ``PostView`` moves the date to the footer.
    var showsPrimaryHeaderChip: Bool {
        if let s = metadata?.subreddit, !s.isEmpty { return true }
        if let n = metadata?.channelName, !n.isEmpty { return true }
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
