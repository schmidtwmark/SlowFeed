import SwiftUI
import AVKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// MARK: - Conditional View Modifier

extension View {
    /// Applies `transform` only when `condition` is true. Used by thumbnail
    /// views to conditionally attach `matchedGeometryEffect`.
    @ViewBuilder
    func `if`<Content: View>(_ condition: Bool, transform: (Self) -> Content) -> some View {
        if condition { transform(self) } else { self }
    }
}

// MARK: - Cached Image Loader (replaces AsyncImage for reliability)

private final class ImageCache {
    static let shared = ImageCache()
    private let cache = NSCache<NSURL, PlatformImage>()

    init() {
        cache.countLimit = 300
    }

    func image(for url: URL) -> PlatformImage? {
        cache.object(forKey: url as NSURL)
    }

    func store(_ image: PlatformImage, for url: URL) {
        cache.setObject(image, forKey: url as NSURL)
    }
}

#if os(macOS)
private typealias PlatformImage = NSImage
#else
private typealias PlatformImage = UIImage
#endif

struct CachedImage<Placeholder: View>: View {
    let url: URL?
    let placeholder: () -> Placeholder

    @State private var image: PlatformImage?
    @State private var failed = false

    init(url: URL?, @ViewBuilder placeholder: @escaping () -> Placeholder) {
        self.url = url
        self.placeholder = placeholder
    }

    var body: some View {
        Group {
            if let image {
                #if os(macOS)
                Image(nsImage: image)
                    .resizable()
                #else
                Image(uiImage: image)
                    .resizable()
                #endif
            } else if failed {
                placeholder()
            } else {
                placeholder()
                    .onAppear { loadImage() }
            }
        }
    }

    private func loadImage() {
        guard let url else { failed = true; return }

        // Check cache first
        if let cached = ImageCache.shared.image(for: url) {
            self.image = cached
            return
        }

        Task {
            do {
                let (data, _) = try await URLSession.shared.data(from: url)
                if let loaded = PlatformImage(data: data) {
                    ImageCache.shared.store(loaded, for: url)
                    await MainActor.run { self.image = loaded }
                } else {
                    await MainActor.run { self.failed = true }
                }
            } catch {
                await MainActor.run { self.failed = true }
            }
        }
    }
}

struct DigestView: View {
    let digest: Digest

    @Environment(AppState.self) private var appState
    @Environment(\.openURL) private var openURL
    @FocusState private var isFocused: Bool
    @Namespace private var imageNamespace
    @State private var viewerImages: [PostMedia] = []
    @State private var viewerIndex: Int = 0
    @State private var showViewer = false
    @State private var debugJSON: String?
    @State private var scrolledPostId: String?

    /// Whether this source carries threaded replies (Bluesky + Mastodon).
    private var isThreadedSource: Bool {
        digest.source == .bluesky || digest.source == .mastodon
    }

    /// All post IDs in order (including thread replies for threaded sources).
    private var allPostIds: [String] {
        guard let posts = digest.posts else { return [] }
        if isThreadedSource {
            return posts.flatMap { flattenThread($0) }.map(\.post.postId)
        } else {
            return posts.map(\.postId)
        }
    }

    /// Top-level post IDs only (skips thread replies). Used for shift+nav and iOS skip button.
    private var topLevelPostIds: [String] {
        guard let posts = digest.posts else { return [] }
        if isThreadedSource {
            return posts.flatMap { flattenThread($0) }.filter(\.isThreadRoot).map(\.post.postId)
        } else {
            return posts.map(\.postId)
        }
    }

    private func openImageViewer(images: [PostMedia], index: Int) {
        viewerImages = images
        viewerIndex = index
        withAnimation(.spring(duration: 0.4, bounce: 0.15)) { showViewer = true }
    }

    var body: some View {
        ZStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        DigestHeader(digest: digest)
                            .padding()
                            .contextMenu {
                                Button {
                                    debugJSON = prettyJSON(digest)
                                } label: {
                                    Label("Show Raw JSON", systemImage: "curlybraces")
                                }
                            }

                        Divider()

                        if let posts = digest.posts, !posts.isEmpty {
                            VStack(alignment: .leading, spacing: 0) {
                                if digest.source == .bluesky || digest.source == .mastodon {
                                    // Threaded rendering: flattened post tree
                                    // with depth indicators. Mastodon uses the
                                    // same shape since `buildThreadTree` on
                                    // the server produces `replies` chains.
                                    BlueskyThreadedView(posts: posts, source: digest.source, digestId: digest.id, imageNamespace: imageNamespace, onSelectImage: openImageViewer)
                                } else if digest.source == .reddit || digest.source == .discord {
                                    GroupedPostsView(posts: posts, source: digest.source, digestId: digest.id, imageNamespace: imageNamespace, onSelectImage: openImageViewer)
                                } else {
                                    ForEach(posts) { post in
                                        PostView(post: post, source: digest.source, digestId: digest.id, imageNamespace: imageNamespace, onSelectImage: openImageViewer)
                                            .id(post.postId)
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
                .scrollPosition(id: $scrolledPostId, anchor: .top)
                .scrollIndicators(.hidden)
                .onChange(of: appState.focusedPostId) { _, newId in
                    guard let newId, appState.keyboardFocusPane == .posts else { return }
                    withAnimation(.easeInOut(duration: 0.2)) {
                        proxy.scrollTo(newId, anchor: .top)
                    }
                    appState.saveScrollPosition(digestId: digest.id, postId: newId)
                }
                .onAppear {
                    // Restore saved scroll position on initial load
                    if let savedPostId = digest.lastReadPostId, allPostIds.contains(savedPostId) {
                        appState.focusedPostId = savedPostId
                        proxy.scrollTo(savedPostId, anchor: .top)
                    }
                }
            }
            .allowsHitTesting(!showViewer)

            // Floating skip button (iOS)
            #if os(iOS)
            if !showViewer, let posts = digest.posts, !posts.isEmpty {
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        Button {
                            navigateTopLevelPost(direction: 1)
                        } label: {
                            Image(systemName: "chevron.down")
                                .font(.title3)
                                .fontWeight(.semibold)
                                .foregroundStyle(.white)
                                .frame(width: 48, height: 48)
                                .background(.thinMaterial.opacity(0.9), in: Circle())
                                .shadow(color: .black.opacity(0.2), radius: 4, y: 2)
                        }
                        .simultaneousGesture(
                            LongPressGesture(minimumDuration: 0.4).onEnded { _ in
                                navigateTopLevelPost(direction: -1)
                            }
                        )
                    }
                    .padding(.trailing, 20)
                    .padding(.bottom, 20)
                }
            }
            #endif

            if showViewer {
                ImageViewerOverlay(
                    images: viewerImages,
                    currentIndex: $viewerIndex,
                    namespace: imageNamespace,
                    onDismiss: {
                        withAnimation(.spring(duration: 0.4, bounce: 0.15)) { showViewer = false }
                    }
                )
            }
        }
        .focusable()
        .focused($isFocused)
        .focusEffectDisabled()
        #if os(macOS)
        .onKeyPress { keyPress in
            if showViewer { return .ignored }
            return handleKeyPress(keyPress)
        }
        #endif
        .onAppear { isFocused = true }
        .onChange(of: digest.id) {
            appState.focusedPostId = nil
            // Restore saved scroll position
            if let savedPostId = digest.lastReadPostId, allPostIds.contains(savedPostId) {
                appState.focusedPostId = savedPostId
            }
        }
        // Sync scroll position → focused post when user scrolls with mouse
        .onChange(of: scrolledPostId) { _, newId in
            handleScrollChange(newId)
        }
        .sheet(item: $debugJSON) { json in
            DebugJSONView(title: "Digest JSON", json: json)
        }
        .navigationTitle(digest.source.displayName)
        #if os(macOS)
        .navigationSubtitle(digest.publishedAt.formatted(date: .abbreviated, time: .shortened))
        #else
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    #if os(macOS)
    private func handleKeyPress(_ keyPress: KeyPress) -> KeyPress.Result {
        let shift = keyPress.modifiers.contains(.shift)

        switch keyPress.key {
        case .downArrow, "j":
            if appState.keyboardFocusPane == .posts {
                // Shift: skip to next top-level post (skip thread replies)
                // Normal: navigate all posts including replies
                return navigatePost(direction: 1, skipThreadReplies: shift)
            } else {
                // Shift: skip to next digest group
                if shift {
                    Task { await appState.navigateToNextRenderedGroup() }
                } else {
                    Task { await appState.navigateToNextRenderedDigest() }
                }
                return .handled
            }
        case .upArrow, "k":
            if appState.keyboardFocusPane == .posts {
                return navigatePost(direction: -1, skipThreadReplies: shift)
            } else {
                if shift {
                    Task { await appState.navigateToPreviousRenderedGroup() }
                } else {
                    Task { await appState.navigateToPreviousRenderedDigest() }
                }
                return .handled
            }
        case .leftArrow, "h":
            appState.keyboardFocusPane = .digests
            return .handled
        case .rightArrow, "l":
            appState.keyboardFocusPane = .posts
            if appState.focusedPostId == nil, let first = allPostIds.first {
                appState.focusedPostId = first
            }
            return .handled
        default:
            return .ignored
        }
    }

    private func navigatePost(direction: Int, skipThreadReplies: Bool) -> KeyPress.Result {
        let ids = skipThreadReplies ? topLevelPostIds : allPostIds
        guard !ids.isEmpty else { return .ignored }

        // If no post focused yet, start from whatever is currently visible
        guard let currentId = appState.focusedPostId else {
            if let visible = scrolledPostId, ids.contains(visible) {
                appState.focusedPostId = visible
            } else {
                appState.focusedPostId = direction > 0 ? ids.first : ids.last
            }
            return .handled
        }

        // Find current position in the target list
        if let currentIdx = ids.firstIndex(of: currentId) {
            let newIdx = currentIdx + direction
            guard newIdx >= 0, newIdx < ids.count else { return .ignored }
            appState.focusedPostId = ids[newIdx]
        } else {
            // Current post is a reply and we're in skip mode — find the nearest top-level post
            let all = allPostIds
            guard let allIdx = all.firstIndex(of: currentId) else { return .ignored }
            if direction > 0 {
                // Find next top-level post after current position
                if let next = ids.first(where: { topId in
                    guard let topIdx = all.firstIndex(of: topId) else { return false }
                    return topIdx > allIdx
                }) {
                    appState.focusedPostId = next
                } else { return .ignored }
            } else {
                // Find previous top-level post before current position
                if let prev = ids.last(where: { topId in
                    guard let topIdx = all.firstIndex(of: topId) else { return false }
                    return topIdx < allIdx
                }) {
                    appState.focusedPostId = prev
                } else { return .ignored }
            }
        }
        return .handled
    }
    #endif

    /// Navigate to next/previous top-level post (used by iOS floating button)
    func navigateTopLevelPost(direction: Int) {
        let ids = topLevelPostIds
        guard !ids.isEmpty else { return }

        guard let currentId = appState.focusedPostId ?? scrolledPostId else {
            appState.focusedPostId = direction > 0 ? ids.first : ids.last
            return
        }

        // Find nearest top-level post in the given direction
        let all = allPostIds
        if let currentIdx = all.firstIndex(of: currentId) {
            if direction > 0 {
                if let next = ids.first(where: { topId in
                    guard let topIdx = all.firstIndex(of: topId) else { return false }
                    return topIdx > currentIdx
                }) {
                    appState.focusedPostId = next
                }
            } else {
                if let prev = ids.last(where: { topId in
                    guard let topIdx = all.firstIndex(of: topId) else { return false }
                    return topIdx < currentIdx
                }) {
                    appState.focusedPostId = prev
                }
            }
        } else {
            appState.focusedPostId = direction > 0 ? ids.first : ids.last
        }
    }

    private func handleScrollChange(_ newId: String?) {
        guard appState.keyboardFocusPane == .posts, let newId else { return }
        if allPostIds.contains(newId) {
            appState.focusedPostId = newId
            appState.saveScrollPosition(digestId: digest.id, postId: newId)
        }
    }
}

// MARK: - Digest Header

struct DigestHeader: View {
    let digest: Digest

    var body: some View {
        Text(digest.publishedAt.formatted(date: .abbreviated, time: .shortened))
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
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
        case .mastodon: return .indigo
        }
    }
}

// MARK: - Grouped Posts View (Reddit by subreddit, Discord by channel)

private struct PostGroup: Identifiable {
    let name: String
    let posts: [DigestPost]
    var id: String { name }
}

struct GroupedPostsView: View {
    let posts: [DigestPost]
    var source: SourceType
    var digestId: String?
    var imageNamespace: Namespace.ID?
    var onSelectImage: (([PostMedia], Int) -> Void)?

    private var groups: [PostGroup] {
        var groupMap: [(key: String, posts: [DigestPost])] = []
        var seen: [String: Int] = [:]

        for post in posts {
            let groupName: String
            if source == .reddit {
                groupName = post.metadata?.subreddit.map { "r/\($0)" } ?? "Other"
            } else {
                // Discord: group by channel name
                groupName = post.metadata?.channelName ?? "General"
            }

            if let idx = seen[groupName] {
                groupMap[idx].posts.append(post)
            } else {
                seen[groupName] = groupMap.count
                groupMap.append((key: groupName, posts: [post]))
            }
        }

        return groupMap.map { PostGroup(name: $0.key, posts: source == .discord ? $0.posts.sorted { ($0.publishedAt ?? .distantPast) < ($1.publishedAt ?? .distantPast) } : $0.posts) }
    }

    var body: some View {
        // The grouping still matters for ordering (posts from the same
        // subreddit/channel stay adjacent), but no visible header — each post
        // already carries its own chip in the header, so a label row on top
        // was just noise.
        ForEach(groups) { group in
            ForEach(group.posts) { post in
                PostView(post: post, source: source, digestId: digestId, imageNamespace: imageNamespace, onSelectImage: onSelectImage)
                    .id(post.postId)
                Divider()
            }
        }
    }
}

// MARK: - Bluesky Threaded View

/// A flattened entry from a post tree, carrying depth info for indentation.
private struct FlatThreadItem: Identifiable {
    let post: DigestPost
    let depth: Int
    let isThreadRoot: Bool  // true for top-level posts (depth 0)
    var id: String { "\(post.postId)_\(depth)" }
}

/// Flattens a post tree into an ordered list with depth markers.
private func flattenThread(_ post: DigestPost, depth: Int = 0, maxDepth: Int = 6, isRoot: Bool = true) -> [FlatThreadItem] {
    guard depth <= maxDepth else { return [] }
    var items = [FlatThreadItem(post: post, depth: depth, isThreadRoot: isRoot)]
    if let replies = post.replies {
        for reply in replies {
            items.append(contentsOf: flattenThread(reply, depth: depth + 1, maxDepth: maxDepth, isRoot: false))
        }
    }
    return items
}

struct BlueskyThreadedView: View {
    let posts: [DigestPost]
    var source: SourceType = .bluesky
    var digestId: String?
    var imageNamespace: Namespace.ID?
    var onSelectImage: (([PostMedia], Int) -> Void)?

    private var flatItems: [FlatThreadItem] {
        posts.flatMap { flattenThread($0) }
    }

    var body: some View {
        ForEach(flatItems) { item in
            if item.isThreadRoot && item.post.postId != flatItems.first?.post.postId {
                Divider()
            }
            BlueskyFlatPostRow(item: item, source: source, digestId: digestId, imageNamespace: imageNamespace, onSelectImage: onSelectImage)
                .id(item.post.postId)
        }
        Divider()
    }
}

/// Renders a single post row with depth-based indentation (non-recursive).
private struct BlueskyFlatPostRow: View {
    let item: FlatThreadItem
    var source: SourceType = .bluesky
    var digestId: String?
    var imageNamespace: Namespace.ID?
    var onSelectImage: (([PostMedia], Int) -> Void)?

    var body: some View {
        HStack(spacing: 0) {
            if item.depth > 0 {
                ForEach(0..<min(item.depth, 4), id: \.self) { _ in
                    Rectangle()
                        .fill(Color.secondary.opacity(0.3))
                        .frame(width: 2)
                        .padding(.horizontal, 8)
                }
            }
            VStack(alignment: .leading, spacing: 0) {
                PostView(post: item.post, source: source, digestId: digestId, imageNamespace: imageNamespace, onSelectImage: onSelectImage, quotedPost: item.post.quotedPost)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Inline quoted post rendered as a bubble
struct QuotedPostBubble: View {
    let post: DigestPost
    var depth: Int = 0
    var imageNamespace: Namespace.ID?
    var onSelectImage: (([PostMedia], Int) -> Void)?

    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Author
            HStack(spacing: 6) {
                if let avatarUrl = post.metadata?.avatarUrl, let url = URL(string: avatarUrl) {
                    CachedImage(url: url) { Circle().fill(.quaternary) }
                        .aspectRatio(contentMode: .fill)
                        .clipShape(Circle())
                        .frame(width: 20, height: 20)
                }
                if let displayName = post.metadata?.displayName, !displayName.isEmpty {
                    Text(displayName)
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(.primary)
                    if let author = post.author {
                        Text(author)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                } else if let author = post.author {
                    Text(author)
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if let date = post.publishedAt {
                    Text(date.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            // Content
            if let content = post.content, !content.isEmpty {
                Text(content)
                    .font(.subheadline)
                    .foregroundStyle(.primary.opacity(0.8))
                    .lineLimit(8)
            }

            // Media
            if let media = post.media, !media.isEmpty {
                MediaView(media: media, postTitle: post.title, imageNamespace: imageNamespace, onSelectImage: onSelectImage)
            }

            // Nested quoted post (cap at 2 levels)
            if let nested = post.quotedPost, depth < 2 {
                QuotedPostBubble(post: nested, depth: depth + 1, imageNamespace: imageNamespace, onSelectImage: onSelectImage)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.secondary.opacity(0.3), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .onTapGesture {
            if let urlStr = post.url, let url = URL(string: urlStr) {
                openURL(url)
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
                    CachedImage(url: url) { EmptyView() }
                        .aspectRatio(contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
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
                    CachedImage(url: url) { Circle().fill(.quaternary) }
                        .aspectRatio(contentMode: .fill)
                        .clipShape(Circle())
                        .frame(width: 20, height: 20)
                }

                if let author = embed.author {
                    Text(author)
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                if let date = embed.publishedAt {
                    Text(date.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }

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
                CachedImage(url: url) {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(.quaternary)
                        .aspectRatio(16/9, contentMode: .fit)
                }
                .aspectRatio(contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 6))
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
                CachedImage(url: url) { EmptyView() }
                    .aspectRatio(contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 4))
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

// MARK: - Debug JSON View

extension String: @retroactive Identifiable {
    public var id: String { self }
}

func prettyJSON<T: Encodable>(_ value: T) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    encoder.dateEncodingStrategy = .iso8601
    guard let data = try? encoder.encode(value),
          let string = String(data: data, encoding: .utf8) else {
        return "Failed to encode"
    }
    return string
}

struct DebugJSONView: View {
    let title: String
    let json: String

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(json)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(title)
            #if !os(macOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        #if os(macOS)
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(json, forType: .string)
                        #else
                        UIPasteboard.general.string = json
                        #endif
                    } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                    }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 500, minHeight: 400)
        #endif
    }
}

