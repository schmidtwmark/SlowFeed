import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct DigestView: View {
    let digest: Digest

    @Environment(AppState.self) private var appState
    @Environment(\.openURL) private var openURL
    @FocusState private var isFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // Header: tappable title opens digest in Safari
                DigestHeader(digest: digest)
                    .padding()
                    .contentShape(Rectangle())
                    .onTapGesture {
                        if let url = URL(string: "\(appState.serverURL)/digest/\(digest.id)") {
                            openURL(url)
                        }
                    }

                Divider()

                if let posts = digest.posts, !posts.isEmpty {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if digest.source == .bluesky {
                            BlueskyThreadedView(posts: posts, source: digest.source, digestId: digest.id)
                        } else {
                            ForEach(posts) { post in
                                PostView(post: post, source: digest.source, digestId: digest.id)
                                Divider()
                            }
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

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 6) {
                Text(digest.title)
                    .font(.title2)
                    .fontWeight(.semibold)

                HStack(spacing: 12) {
                    SourceBadge(source: digest.source)

                    if digest.isRead {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Spacer()

            Text(digest.publishedAt.formatted(date: .abbreviated, time: .shortened))
                .font(.caption)
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

// MARK: - Bluesky Threaded View

struct BlueskyThreadedView: View {
    let posts: [DigestPost]
    var source: SourceType = .bluesky
    var digestId: String?

    /// Groups posts by rootUri into threads, preserving standalone posts
    private var groups: [(id: String, posts: [DigestPost])] {
        var threads: [String: [DigestPost]] = [:]
        var standalone: [DigestPost] = []
        var threadOrder: [String] = []

        for post in posts {
            if let raw = post.metadata?.rootUri {
                // This post is part of a thread
                let key = raw
                if threads[key] == nil {
                    threads[key] = []
                    threadOrder.append(key)
                }
                threads[key]!.append(post)
            } else {
                standalone.append(post)
            }
        }

        // Check if any standalone post is actually a thread root
        // (other posts reference it via rootUri that ends with the standalone's postId)
        var usedStandalone = Set<String>()
        for (rootUri, _) in threads {
            if let root = standalone.first(where: { rootUri.hasSuffix($0.postId) }) {
                threads[rootUri]!.insert(root, at: 0)
                usedStandalone.insert(root.postId)
            }
        }

        var result: [(id: String, posts: [DigestPost])] = []

        // Add threads in order
        for key in threadOrder {
            if let threadPosts = threads[key] {
                let sorted = threadPosts.sorted {
                    ($0.publishedAt ?? .distantPast) < ($1.publishedAt ?? .distantPast)
                }
                result.append((id: key, posts: sorted))
            }
        }

        // Add remaining standalone posts
        for post in standalone where !usedStandalone.contains(post.postId) {
            result.append((id: post.postId, posts: [post]))
        }

        // Sort all groups by earliest post time
        result.sort {
            let t0 = $0.posts.first?.publishedAt ?? .distantPast
            let t1 = $1.posts.first?.publishedAt ?? .distantPast
            return t0 < t1
        }

        return result
    }

    var body: some View {
        ForEach(groups, id: \.id) { group in
            if group.posts.count == 1 {
                PostView(post: group.posts[0], source: source, digestId: digestId)
                Divider()
            } else {
                ThreadGroupView(posts: group.posts, source: source, digestId: digestId)
                Divider()
            }
        }
    }
}

/// Renders a group of Bluesky posts as a thread with tree indentation
struct ThreadGroupView: View {
    let posts: [DigestPost]
    var source: SourceType = .bluesky
    var digestId: String?

    /// Calculate indent level for each post based on parent chain
    private func indentLevel(for post: DigestPost) -> Int {
        guard let parentUri = post.metadata?.parentUri else { return 0 }

        // Find the parent in our posts array
        if let parent = posts.first(where: { parentUri.hasSuffix($0.postId) }) {
            return indentLevel(for: parent) + 1
        }
        // Parent not in our list — treat as top-level reply
        return 1
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(posts) { post in
                let indent = min(indentLevel(for: post), 4)
                HStack(spacing: 0) {
                    if indent > 0 {
                        // Thread line indicators
                        ForEach(0..<indent, id: \.self) { _ in
                            Rectangle()
                                .fill(Color.blue.opacity(0.3))
                                .frame(width: 2)
                                .padding(.horizontal, 8)
                        }
                    }
                    PostView(post: post, source: source, digestId: digestId)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if post.id != posts.last?.id {
                    Divider()
                        .padding(.leading, CGFloat(indent) * 18)
                }
            }
        }
    }
}

// MARK: - Post View

struct PostView: View {
    let post: DigestPost
    var source: SourceType = .reddit
    var digestId: String?

    @Environment(\.openURL) private var openURL
    @Environment(AppState.self) private var appState

    private var postURL: URL? {
        guard let urlString = post.url, !urlString.isEmpty else { return nil }
        return URL(string: urlString)
    }

    private var firstMedia: PostMedia? {
        post.media?.first
    }

    private var hasMedia: Bool {
        firstMedia != nil
    }

    /// True if the title just repeats the author + content
    private var titleIsDuplicate: Bool {
        guard let content = post.content, !content.isEmpty else { return false }
        let titleLower = post.title.lowercased()
        let contentStart = content.prefix(60).lowercased()
        return titleLower.contains(contentStart) || contentStart.contains(titleLower)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Repost indicator at top
            if let repostedBy = post.metadata?.repostedBy {
                Label("Reposted by \(repostedBy)", systemImage: "arrow.2.squarepath")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // Author row with avatar, metadata, and date
            HStack(spacing: 8) {
                if let avatarUrl = post.metadata?.avatarUrl, let url = URL(string: avatarUrl) {
                    AsyncImage(url: url) { image in
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .clipShape(Circle())
                    } placeholder: {
                        Circle().fill(.quaternary)
                    }
                    .frame(width: 28, height: 28)
                }

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

                if post.isNotification == true {
                    Image(systemName: "bell.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }

                Spacer()

                if let date = post.publishedAt {
                    Text(date.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }

            // Title - skip if duplicate
            if !titleIsDuplicate {
                Text(post.title)
                    .font(.headline)
                    .foregroundStyle(.primary)
            }

            // Content
            if let content = post.content, !content.isEmpty {
                Text(content)
                    .font(.body)
                    .foregroundStyle(.primary.opacity(0.85))
                    .lineLimit(10)
            }

            // Media
            if let media = post.media, !media.isEmpty {
                MediaView(media: media, postTitle: post.title)
            }

            // External links
            if let links = post.links, !links.isEmpty {
                ForEach(links, id: \.url) { link in
                    LinkCardView(link: link)
                }
            }

            // Embeds
            if let embeds = post.embeds, !embeds.isEmpty {
                ForEach(Array(embeds.enumerated()), id: \.offset) { _, embed in
                    EmbedView(embed: embed)
                }
            }

            // Comments
            if let comments = post.comments, !comments.isEmpty {
                CommentsView(comments: comments)
            }

            // Bottom metadata row (score, comments, etc.)
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
                Spacer()
            }
        }
        .padding()
        .contentShape(Rectangle())
        .onTapGesture {
            if let url = postURL { openURL(url) }
        }
        .contextMenu {
            if let url = postURL {
                Button {
                    openURL(url)
                } label: {
                    Label("Open", systemImage: "safari")
                }

                Button {
                    #if os(macOS)
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(url.absoluteString, forType: .string)
                    #else
                    UIPasteboard.general.string = url.absoluteString
                    #endif
                } label: {
                    Label("Copy Link", systemImage: "doc.on.doc")
                }

                ShareLink("Share Link", item: url)
            }

            if hasMedia {
                Divider()

                Button {
                    Task { await copyMediaToClipboard() }
                } label: {
                    Label("Copy Media", systemImage: "photo.on.rectangle")
                }

                Button {
                    Task { await shareMedia() }
                } label: {
                    Label("Share Media", systemImage: "square.and.arrow.up")
                }
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
        }
    }

    /// Download media and return (data, media item) for the first media attachment
    private func downloadMedia() async -> (Data, PostMedia)? {
        guard let media = firstMedia, let url = URL(string: media.url) else { return nil }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            return (data, media)
        } catch {
            return nil
        }
    }

    /// File extension based on media type and URL
    private func fileExtension(for media: PostMedia) -> String {
        // Try URL path extension first
        let urlExt = URL(string: media.url)?.pathExtension ?? ""
        if !urlExt.isEmpty { return urlExt }
        // Fall back based on type
        switch media.type {
        case "video": return "mp4"
        case "image": return "jpg"
        default: return "bin"
        }
    }

    /// Write data to a temp file and return the URL
    private func writeTempFile(data: Data, media: PostMedia) -> URL {
        let ext = fileExtension(for: media)
        let filename = "slowfeed_media_\(UUID().uuidString.prefix(8)).\(ext)"
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        try? data.write(to: tempURL)
        return tempURL
    }

    private func copyMediaToClipboard() async {
        guard let (data, media) = await downloadMedia() else { return }
        let isImage = media.type == "image"
        let tempFileURL = writeTempFile(data: data, media: media)

        await MainActor.run {
            #if os(macOS)
            let pb = NSPasteboard.general
            pb.clearContents()
            if isImage, let image = NSImage(data: data) {
                pb.writeObjects([image])
            } else {
                // Video/file: copy as file URL so it can be pasted into Finder, Messages, etc.
                pb.writeObjects([tempFileURL as NSURL])
            }
            #else
            if isImage, let image = UIImage(data: data) {
                UIPasteboard.general.image = image
            } else {
                // Video: copy file URL
                UIPasteboard.general.url = tempFileURL
            }
            #endif
        }
    }

    private func shareMedia() async {
        guard let (data, media) = await downloadMedia() else { return }
        let tempFileURL = writeTempFile(data: data, media: media)

        await MainActor.run {
            #if os(macOS)
            let items: [Any]
            if media.type == "image", let image = NSImage(data: data) {
                items = [image]
            } else {
                items = [tempFileURL]
            }
            let picker = NSSharingServicePicker(items: items)
            if let window = NSApp.keyWindow, let contentView = window.contentView {
                picker.show(relativeTo: contentView.bounds, of: contentView, preferredEdge: .minY)
            }
            #else
            let items: [Any]
            if media.type == "image", let image = UIImage(data: data) {
                items = [image]
            } else {
                items = [tempFileURL]
            }
            let activityVC = UIActivityViewController(activityItems: items, applicationActivities: nil)
            if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
               let rootVC = windowScene.windows.first?.rootViewController {
                rootVC.present(activityVC, animated: true)
            }
            #endif
        }
    }
}

// MARK: - Media View

struct MediaView: View {
    let media: [PostMedia]
    let postTitle: String

    @Environment(\.openURL) private var openURL

    var body: some View {
        let images = media.filter { $0.type == "image" }
        let videos = media.filter { $0.type == "video" }

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
                .onTapGesture {
                    if let url = URL(string: vid.url) {
                        openURL(url)
                    }
                }
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

    @Environment(\.openURL) private var openURL

    var body: some View {
        if embed.type == "quote" {
            quoteView
        } else {
            linkCardView
        }
    }

    private var providerColor: Color {
        switch embed.provider {
        case "Twitter": return .blue
        case "YouTube": return .red
        case "Instagram": return .pink
        case "Bluesky": return .blue
        case "Reddit": return .orange
        case "TikTok": return .primary
        default: return .secondary
        }
    }

    private var quoteView: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Provider + author row
            HStack(spacing: 6) {
                if let avatarUrl = embed.authorAvatarUrl, let url = URL(string: avatarUrl) {
                    AsyncImage(url: url) { image in
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .clipShape(Circle())
                    } placeholder: {
                        Circle().fill(.quaternary)
                    }
                    .frame(width: 20, height: 20)
                }

                if let author = embed.author {
                    Text(author)
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                if let provider = embed.provider {
                    Text(provider)
                        .font(.caption2)
                        .fontWeight(.semibold)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(providerColor.opacity(0.15))
                        .foregroundStyle(providerColor)
                        .clipShape(Capsule())
                }
            }

            if let title = embed.title, embed.text != nil {
                Text(title)
                    .font(.caption)
                    .fontWeight(.medium)
            }

            if let text = embed.text {
                Text(text)
                    .font(.subheadline)
                    .foregroundStyle(.primary.opacity(0.8))
                    .lineLimit(10)
            } else if let title = embed.title {
                Text(title)
                    .font(.subheadline)
                    .fontWeight(.medium)
            }

            if let imageUrl = embed.imageUrl, let url = URL(string: imageUrl) {
                AsyncImage(url: url) { image in
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                } placeholder: {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(.quaternary)
                        .aspectRatio(16/9, contentMode: .fit)
                }
                .frame(maxHeight: 300)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(providerColor.opacity(0.3), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .onTapGesture {
            if let urlStr = embed.url, let url = URL(string: urlStr) {
                openURL(url)
            }
        }
    }

    private var linkCardView: some View {
        VStack(alignment: .leading, spacing: 4) {
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

            if let imageUrl = embed.imageUrl, let url = URL(string: imageUrl) {
                AsyncImage(url: url) { image in
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                } placeholder: {
                    EmptyView()
                }
                .frame(maxHeight: 150)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3))
        .overlay(
            Rectangle()
                .fill(Color.purple.opacity(0.4))
                .frame(width: 3),
            alignment: .leading
        )
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .onTapGesture {
            if let urlStr = embed.url, let url = URL(string: urlStr) {
                openURL(url)
            }
        }
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
                    avatarUrl: nil, score: 142, subreddit: "swift", numComments: 23,
                    videoId: nil, channel: nil, channelUrl: nil, duration: nil,
                    viewCount: nil, publishedText: nil, guildName: nil, channelName: nil,
                    replyToMessageId: nil, repostedBy: nil, rootUri: nil, parentUri: nil
                ),
                media: [], links: [],
                comments: [PostComment(author: "commenter", body: "Great post!", score: 10)],
                embeds: []
            )
        ]
    ))
    .environment(AppState())
}
