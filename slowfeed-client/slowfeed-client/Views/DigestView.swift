import SwiftUI

struct DigestView: View {
    let digest: Digest

    @Environment(AppState.self) private var appState
    @FocusState private var isFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                DigestHeader(digest: digest)
                    .padding()

                Divider()

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
        .onAppear { isFocused = true }
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
        default: break
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
            // Author & metadata header
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

                if let channel = post.metadata?.channel {
                    Text(channel)
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                if let channelName = post.metadata?.channelName {
                    Text("#\(channelName)")
                        .font(.caption)
                        .foregroundStyle(.purple)
                }

                Spacer()

                if post.isNotification == true {
                    Image(systemName: "bell.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }

            // Title
            Text(post.title)
                .font(.headline)

            // Content (plain text)
            if let content = post.content, !content.isEmpty {
                Text(content)
                    .font(.body)
                    .foregroundStyle(.primary.opacity(0.85))
                    .lineLimit(10)
            }

            // Media (images, videos)
            if let media = post.media, !media.isEmpty {
                MediaView(media: media, postTitle: post.title)
            }

            // External links
            if let links = post.links, !links.isEmpty {
                ForEach(links, id: \.url) { link in
                    LinkCardView(link: link)
                }
            }

            // Embeds (quotes, link cards)
            if let embeds = post.embeds, !embeds.isEmpty {
                ForEach(Array(embeds.enumerated()), id: \.offset) { _, embed in
                    EmbedView(embed: embed)
                }
            }

            // Comments
            if let comments = post.comments, !comments.isEmpty {
                CommentsView(comments: comments)
            }

            // Bottom metadata row
            HStack(spacing: 12) {
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
                if let repostedBy = post.metadata?.repostedBy {
                    Label("Reposted by \(repostedBy)", systemImage: "arrow.2.squarepath")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                if let date = post.publishedAt {
                    Text(date.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }

            // Open link
            if let urlString = post.url, let url = URL(string: urlString), !urlString.isEmpty {
                Button { openURL(url) } label: {
                    Label("Open", systemImage: "arrow.up.right")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
        .padding()
    }
}

// MARK: - Media View

struct MediaView: View {
    let media: [PostMedia]
    let postTitle: String

    var body: some View {
        let images = media.filter { $0.type == "image" }
        let videos = media.filter { $0.type == "video" }

        // Images
        if !images.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(images, id: \.url) { img in
                        if let url = URL(string: img.url) {
                            AsyncImage(url: url) { image in
                                image
                                    .resizable()
                                    .aspectRatio(contentMode: .fit)
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                            } placeholder: {
                                RoundedRectangle(cornerRadius: 8)
                                    .fill(.quaternary)
                                    .frame(width: 200, height: 150)
                            }
                            .frame(maxHeight: 300)
                        }
                    }
                }
            }
        }

        // Video thumbnails
        ForEach(videos, id: \.url) { vid in
            if let thumbUrl = vid.thumbnailUrl, let url = URL(string: thumbUrl) {
                AsyncImage(url: url) { image in
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay(alignment: .center) {
                            Image(systemName: "play.circle.fill")
                                .font(.system(size: 44))
                                .foregroundStyle(.white.opacity(0.9))
                        }
                } placeholder: {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(.quaternary)
                        .aspectRatio(16/9, contentMode: .fit)
                }
                .frame(maxHeight: 250)
            }
        }
    }
}

// MARK: - Link Card View

struct LinkCardView: View {
    let link: PostLink

    @Environment(\.openURL) private var openURL

    var body: some View {
        Button {
            if let url = URL(string: link.url) { openURL(url) }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                if let imageUrl = link.imageUrl, let url = URL(string: imageUrl) {
                    AsyncImage(url: url) { image in
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    } placeholder: {
                        EmptyView()
                    }
                    .frame(maxHeight: 150)
                }

                Text(link.title ?? link.url)
                    .font(.subheadline)
                    .fontWeight(.medium)
                    .lineLimit(2)

                if let desc = link.description {
                    Text(desc)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.5))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Embed View

struct EmbedView: View {
    let embed: PostEmbed

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let author = embed.author {
                Text(author)
                    .font(.caption)
                    .fontWeight(.medium)
                    .foregroundStyle(.secondary)
            }

            if let text = embed.text {
                Text(text)
                    .font(.subheadline)
                    .foregroundStyle(.primary.opacity(0.8))
                    .lineLimit(5)
            }

            if let title = embed.title {
                Text(title)
                    .font(.caption)
                    .fontWeight(.medium)
            }

            if let desc = embed.description {
                Text(desc)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3))
        .overlay(
            Rectangle()
                .fill(embed.type == "quote" ? Color.secondary.opacity(0.4) : Color.purple.opacity(0.4))
                .frame(width: 3),
            alignment: .leading
        )
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

// MARK: - Comments View

struct CommentsView: View {
    let comments: [PostComment]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Top Comments")
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)

            ForEach(comments, id: \.author) { comment in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text("u/\(comment.author)")
                            .font(.caption)
                            .fontWeight(.medium)
                            .foregroundStyle(.blue)
                        if comment.score != 0 {
                            Text("\(comment.score) pts")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Text(comment.body)
                        .font(.caption)
                        .lineLimit(4)
                }
                .padding(.leading, 8)
                .overlay(
                    Rectangle()
                        .fill(.orange.opacity(0.5))
                        .frame(width: 2),
                    alignment: .leading
                )
            }
        }
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
                    numComments: 23,
                    videoId: nil,
                    channel: nil,
                    channelUrl: nil,
                    duration: nil,
                    viewCount: nil,
                    publishedText: nil,
                    guildName: nil,
                    channelName: nil,
                    replyToMessageId: nil,
                    repostedBy: nil,
                    rootUri: nil,
                    parentUri: nil
                ),
                media: [],
                links: [],
                comments: [
                    PostComment(author: "commenter", body: "Great post!", score: 10)
                ],
                embeds: []
            )
        ]
    ))
    .environment(AppState())
}
