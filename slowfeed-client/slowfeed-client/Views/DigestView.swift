import SwiftUI

struct DigestView: View {
    let digest: Digest

    @Environment(AppState.self) private var appState
    @FocusState private var isFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // Header
                DigestHeader(digest: digest)
                    .padding()

                Divider()

                // Posts
                if let posts = digest.posts, !posts.isEmpty {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(posts) { post in
                            PostView(post: post)
                            Divider()
                        }
                    }
                } else {
                    ContentUnavailableView(
                        "No Posts",
                        systemImage: "doc.text",
                        description: Text("This digest has no posts.")
                    )
                    .padding(.top, 40)
                }
            }
        }
        .focusable()
        .focused($isFocused)
        #if os(macOS)
        .onKeyPress { keyPress in
            handleKeyPress(keyPress)
        }
        #endif
        .onAppear {
            isFocused = true
        }
    }

    #if os(macOS)
    private func handleKeyPress(_ keyPress: KeyPress) -> KeyPress.Result {
        switch keyPress.key {
        case .leftArrow, "h":
            if appState.canNavigatePrevious {
                Task { await appState.navigateToPreviousDigest() }
                return .handled
            }
        case .rightArrow, "l":
            if appState.canNavigateNext {
                Task { await appState.navigateToNextDigest() }
                return .handled
            }
        default:
            break
        }
        return .ignored
    }
    #endif
}

// MARK: - Digest Header

struct DigestHeader: View {
    let digest: Digest

    @Environment(AppState.self) private var appState
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                SourceBadge(source: digest.source)

                Spacer()

                if digest.isRead {
                    Label("Read", systemImage: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Button {
                    if let url = URL(string: "\(appState.serverURL)/digest/\(digest.id)") {
                        openURL(url)
                    }
                } label: {
                    Label("Open in Safari", systemImage: "safari")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }

            Text(digest.title)
                .font(.title2)
                .fontWeight(.semibold)

            HStack(spacing: 16) {
                Label("\(digest.postCount) posts", systemImage: "doc.text")

                Label(digest.publishedAt.formatted(date: .abbreviated, time: .shortened), systemImage: "clock")
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Source Badge

struct SourceBadge: View {
    let source: SourceType

    var body: some View {
        Label(source.displayName, systemImage: source.iconName)
            .font(.caption)
            .fontWeight(.medium)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(sourceColor.opacity(0.2))
            .foregroundStyle(sourceColor)
            .clipShape(Capsule())
    }

    private var sourceColor: Color {
        switch source {
        case .reddit: return .orange
        case .bluesky: return .blue
        case .youtube: return .red
        case .discord: return .purple
        }
    }
}

// MARK: - Post View

struct PostView: View {
    let post: DigestPost

    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Author and metadata
            HStack {
                if let author = post.author, !author.isEmpty {
                    Text(author)
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .foregroundStyle(.secondary)
                }

                if let subreddit = post.metadata?.subreddit {
                    Text("r/\(subreddit)")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }

                if let channelName = post.metadata?.channelName {
                    Text("#\(channelName)")
                        .font(.caption)
                        .foregroundStyle(.purple)
                }

                Spacer()

                if post.isNotification {
                    Image(systemName: "bell.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }

            // Title
            Text(post.title)
                .font(.headline)

            // Content
            if let content = post.content, !content.isEmpty {
                Text(content)
                    .font(.body)
                    .foregroundStyle(.primary.opacity(0.85))
                    .lineLimit(10)
            }

            // Thumbnail for YouTube
            if let thumbnail = post.metadata?.thumbnail, let url = URL(string: thumbnail) {
                AsyncImage(url: url) { image in
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                } placeholder: {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(.quaternary)
                        .aspectRatio(16/9, contentMode: .fit)
                }
                .frame(maxHeight: 200)
            }

            // Bottom metadata row
            HStack(spacing: 12) {
                if let score = post.metadata?.score {
                    Label("\(score)", systemImage: "arrow.up")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let comments = post.metadata?.comments {
                    Label("\(comments)", systemImage: "bubble.right")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let duration = post.metadata?.duration {
                    Label(duration, systemImage: "clock")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let repostedBy = post.metadata?.repostedBy {
                    Label("Reposted by \(repostedBy)", systemImage: "arrow.2.squarepath")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Text(post.publishedAt.formatted(date: .abbreviated, time: .shortened))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }

            // Open link button
            Button {
                if let url = URL(string: post.url) {
                    openURL(url)
                }
            } label: {
                Label("Open", systemImage: "arrow.up.right")
                    .font(.caption)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding()
    }
}

#Preview {
    DigestView(digest: Digest(
        id: "test",
        source: .reddit,
        title: "Reddit Digest: 5 posts",
        postCount: 5,
        postIds: [],
        publishedAt: Date(),
        createdAt: Date(),
        readAt: nil,
        posts: [
            DigestPost(
                postId: "1",
                source: "reddit",
                title: "Example Post Title",
                content: "This is some example content for the post.",
                url: "https://reddit.com",
                author: "u/example",
                publishedAt: Date(),
                isNotification: false,
                metadata: PostMetadata(
                    avatarUrl: nil,
                    score: 142,
                    subreddit: "swift",
                    comments: 23,
                    thumbnail: nil,
                    channel: nil,
                    duration: nil,
                    guildName: nil,
                    channelName: nil,
                    repostedBy: nil
                )
            )
        ]
    ))
    .environment(AppState())
}
