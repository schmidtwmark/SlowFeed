import SwiftUI
import AVKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// MARK: - Conditional View Modifier

private extension View {
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
    @State private var viewerURLs: [URL] = []
    @State private var viewerIndex: Int = 0
    @State private var showViewer = false
    @State private var debugJSON: String?
    @State private var scrolledPostId: String?

    /// All post IDs in order (including thread replies for Bluesky).
    private var allPostIds: [String] {
        guard let posts = digest.posts else { return [] }
        if digest.source == .bluesky {
            return posts.flatMap { flattenThread($0) }.map(\.post.postId)
        } else {
            return posts.map(\.postId)
        }
    }

    /// Top-level post IDs only (skips thread replies). Used for shift+nav and iOS skip button.
    private var topLevelPostIds: [String] {
        guard let posts = digest.posts else { return [] }
        if digest.source == .bluesky {
            return posts.flatMap { flattenThread($0) }.filter(\.isThreadRoot).map(\.post.postId)
        } else {
            return posts.map(\.postId)
        }
    }

    private func openImageViewer(urls: [URL], index: Int) {
        viewerURLs = urls
        viewerIndex = index
        withAnimation(.spring(duration: 0.4, bounce: 0.15)) { showViewer = true }
    }

    var body: some View {
        ZStack {
            ScrollViewReader { proxy in
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
                                if digest.source == .bluesky {
                                    BlueskyThreadedView(posts: posts, source: digest.source, digestId: digest.id, imageNamespace: imageNamespace, onSelectImage: openImageViewer)
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
                    imageURLs: viewerURLs,
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
        }
        // Sync scroll position → focused post when user scrolls with mouse
        .onChange(of: scrolledPostId) { _, newId in
            guard appState.keyboardFocusPane == .posts, let newId else { return }
            if allPostIds.contains(newId) {
                appState.focusedPostId = newId
            }
        }
        .sheet(item: $debugJSON) { json in
            DebugJSONView(title: "Digest JSON", json: json)
        }
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

        // If no post focused yet, start from the first/last
        guard let currentId = appState.focusedPostId else {
            appState.focusedPostId = direction > 0 ? ids.first : ids.last
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
    var onSelectImage: (([URL], Int) -> Void)?

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
            if !item.isThreadRoot {
                Divider()
                    .padding(.leading, CGFloat(min(item.depth, 4)) * 18)
            }
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
    var onSelectImage: (([URL], Int) -> Void)?

    var body: some View {
        HStack(spacing: 0) {
            if item.depth > 0 {
                ForEach(0..<min(item.depth, 4), id: \.self) { _ in
                    Rectangle()
                        .fill(Color.blue.opacity(0.3))
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
    var onSelectImage: (([URL], Int) -> Void)?

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
                if let author = post.author {
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

// MARK: - Post View

struct PostView: View {
    let post: DigestPost
    var source: SourceType = .reddit
    var digestId: String?
    var imageNamespace: Namespace.ID?
    var onSelectImage: (([URL], Int) -> Void)?
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

    /// Strip legacy "r/subreddit: " prefix from Reddit titles
    private var displayTitle: String {
        post.title.replacingOccurrences(of: #"^r/\w+:\s*"#, with: "", options: .regularExpression)
    }

    /// True if the title just repeats the author + content
    private var titleIsDuplicate: Bool {
        guard let content = post.content, !content.isEmpty else { return false }
        let titleLower = displayTitle.lowercased()
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
                    CachedImage(url: url) {
                        Circle().fill(.quaternary)
                    }
                    .aspectRatio(contentMode: .fill)
                    .clipShape(Circle())
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
                Text(displayTitle)
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
                MediaView(media: media, postTitle: post.title, imageNamespace: imageNamespace, onSelectImage: onSelectImage)
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

            // Inline quoted post
            if let quoted = quotedPost {
                QuotedPostBubble(post: quoted, imageNamespace: imageNamespace, onSelectImage: onSelectImage)
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
        .background(appState.focusedPostId == post.postId && appState.keyboardFocusPane == .posts
                     ? Color.accentColor.opacity(0.08)
                     : Color.clear)
        .overlay(alignment: .leading) {
            if appState.focusedPostId == post.postId && appState.keyboardFocusPane == .posts {
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
        .sheet(item: $debugJSON) { json in
            DebugJSONView(title: "Post JSON", json: json)
        }
    }
}

// MARK: - Media View

struct MediaView: View {
    let media: [PostMedia]
    let postTitle: String
    var imageNamespace: Namespace.ID?
    var onSelectImage: (([URL], Int) -> Void)?

    @Environment(\.openURL) private var openURL

    private var images: [PostMedia] { media.filter { $0.type == "image" } }
    private var videos: [PostMedia] { media.filter { $0.type == "video" } }
    private var allImageURLs: [URL] { images.compactMap { URL(string: $0.url) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if images.count == 1, let img = images.first, let url = URL(string: img.url) {
                imageThumb(url: url, index: 0)
                    .frame(maxWidth: 600)
                    .contextMenu { mediaContextMenu(for: img) }
            } else if images.count > 1 {
                GeometryReader { geo in
                    let itemWidth = min(geo.size.width - 24, 600.0)
                    ScrollView(.horizontal, showsIndicators: false) {
                        LazyHStack(spacing: 12) {
                            ForEach(Array(images.enumerated()), id: \.offset) { index, img in
                                if let url = URL(string: img.url) {
                                    imageThumb(url: url, index: index)
                                        .frame(width: itemWidth, height: min(itemWidth * 0.75, 400))
                                        .contextMenu { mediaContextMenu(for: img) }
                                }
                            }
                        }
                        .scrollTargetLayout()
                        .padding(.horizontal, 12)
                    }
                    .scrollTargetBehavior(.viewAligned)
                }
                .frame(height: min(400, 300))

                // Gallery counter
                Text("\(images.count) images")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            ForEach(videos, id: \.url) { vid in
                InlineVideoPlayer(media: vid)
                    .frame(maxWidth: 600)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .contextMenu { mediaContextMenu(for: vid) }
            }
        }
    }

    @ViewBuilder
    private func imageThumb(url: URL, index: Int) -> some View {
        CachedImage(url: url) {
            RoundedRectangle(cornerRadius: 8)
                .fill(.quaternary)
                .aspectRatio(4/3, contentMode: .fit)
        }
        .aspectRatio(contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .if(imageNamespace != nil) { view in
            view.matchedGeometryEffect(id: url.absoluteString, in: imageNamespace!)
        }
        .onTapGesture { onSelectImage?(allImageURLs, index) }
    }

    @ViewBuilder
    private func mediaContextMenu(for media: PostMedia) -> some View {
        Button {
            Task { await copyMedia(media) }
        } label: {
            Label("Copy Media", systemImage: "photo.on.rectangle")
        }

        Button {
            Task { await shareMedia(media) }
        } label: {
            Label("Share Media", systemImage: "square.and.arrow.up")
        }
    }

    private func downloadMedia(_ media: PostMedia) async -> Data? {
        guard let url = URL(string: media.url) else { return nil }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            return data
        } catch {
            return nil
        }
    }

    private func fileExtension(for media: PostMedia) -> String {
        let urlExt = URL(string: media.url)?.pathExtension ?? ""
        if !urlExt.isEmpty { return urlExt }
        switch media.type {
        case "video": return "mp4"
        case "image": return "jpg"
        default: return "bin"
        }
    }

    private func writeTempFile(data: Data, media: PostMedia) -> URL {
        let ext = fileExtension(for: media)
        let filename = "slowfeed_media_\(UUID().uuidString.prefix(8)).\(ext)"
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        try? data.write(to: tempURL)
        return tempURL
    }

    private func copyMedia(_ media: PostMedia) async {
        guard let data = await downloadMedia(media) else { return }
        let isImage = media.type == "image"
        let tempFileURL = writeTempFile(data: data, media: media)

        await MainActor.run {
            #if os(macOS)
            let pb = NSPasteboard.general
            pb.clearContents()
            if isImage, let image = NSImage(data: data) {
                pb.writeObjects([image])
            } else {
                pb.writeObjects([tempFileURL as NSURL])
            }
            #else
            if isImage, let image = UIImage(data: data) {
                UIPasteboard.general.image = image
            } else {
                UIPasteboard.general.url = tempFileURL
            }
            #endif
        }
    }

    private func shareMedia(_ media: PostMedia) async {
        guard let data = await downloadMedia(media) else { return }
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

// MARK: - Inline Video Player

#if os(macOS)
struct NativePlayerView: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.player = player
        view.controlsStyle = .inline
        view.showsFullScreenToggleButton = true
        return view
    }

    func updateNSView(_ nsView: AVPlayerView, context: Context) {
        nsView.player = player
    }
}
#endif

struct InlineVideoPlayer: View {
    let media: PostMedia

    @State private var player: AVPlayer?
    @State private var audioPlayer: AVPlayer?

    /// Whether the audio URL is actually a separate track (not the same as video)
    private var hasSeparateAudio: Bool {
        guard let audioUrl = media.audioUrl else { return false }
        return audioUrl != media.url
    }

    var body: some View {
        ZStack {
            if let player {
                #if os(macOS)
                NativePlayerView(player: player)
                    .aspectRatio(16/9, contentMode: .fit)
                    .onDisappear { stopPlayback() }
                #else
                VideoPlayer(player: player)
                    .aspectRatio(16/9, contentMode: .fit)
                    .onDisappear { stopPlayback() }
                #endif
            } else {
                // Thumbnail with play button
                ZStack {
                    if let thumbUrl = media.thumbnailUrl, let url = URL(string: thumbUrl) {
                        CachedImage(url: url) {
                            RoundedRectangle(cornerRadius: 8)
                                .fill(.quaternary)
                                .aspectRatio(16/9, contentMode: .fit)
                        }
                        .aspectRatio(contentMode: .fit)
                    } else {
                        RoundedRectangle(cornerRadius: 8)
                            .fill(.quaternary)
                            .aspectRatio(16/9, contentMode: .fit)
                    }

                    Image(systemName: "play.circle.fill")
                        .font(.system(size: 52))
                        .foregroundStyle(.white.opacity(0.9))
                        .shadow(radius: 4)
                }
                .onTapGesture { startPlayback() }
            }
        }
    }

    private func startPlayback() {
        guard let videoURL = URL(string: media.url) else { return }

        let mainPlayer = AVPlayer(url: videoURL)

        if hasSeparateAudio, let audioURL = URL(string: media.audioUrl!) {
            // Reddit DASH: separate audio track
            let separateAudioPlayer = AVPlayer(url: audioURL)
            mainPlayer.play()
            separateAudioPlayer.play()
            self.audioPlayer = separateAudioPlayer

            // Loop both on end
            NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime,
                object: mainPlayer.currentItem,
                queue: .main
            ) { _ in
                mainPlayer.seek(to: .zero)
                separateAudioPlayer.seek(to: .zero)
                mainPlayer.play()
                separateAudioPlayer.play()
            }
        } else {
            // CMAF or standard video — audio is embedded
            mainPlayer.play()
        }

        self.player = mainPlayer
    }

    private func stopPlayback() {
        player?.pause()
        audioPlayer?.pause()
    }
}

// MARK: - Fullscreen Image Viewer Overlay

struct ImageViewerOverlay: View {
    let imageURLs: [URL]
    @Binding var currentIndex: Int
    let namespace: Namespace.ID
    let onDismiss: () -> Void

    // Pan & zoom
    @State private var scale: CGFloat = 1.0
    @State private var lastScale: CGFloat = 1.0
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    // Swipe-to-dismiss
    @State private var dismissDrag: CGSize = .zero
    @State private var backgroundOpacity: Double = 1.0
    @FocusState private var isFocused: Bool

    private var safeIndex: Int {
        guard !imageURLs.isEmpty else { return 0 }
        return min(max(currentIndex, 0), imageURLs.count - 1)
    }
    private var currentURL: URL? {
        guard !imageURLs.isEmpty else { return nil }
        return imageURLs[safeIndex]
    }
    private var isDraggingToDismiss: Bool { scale <= 1.0 && dismissDrag != .zero }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                Color.black
                    .opacity(backgroundOpacity)
                    .ignoresSafeArea()
                    .onTapGesture { onDismiss() }

                // The image with matched geometry for animation
                CachedImage(url: currentURL) {
                    ProgressView().tint(.white)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .aspectRatio(contentMode: .fit)
                .matchedGeometryEffect(id: currentURL?.absoluteString ?? "", in: namespace)
                .scaleEffect(scale)
                .offset(
                    x: offset.width + (isDraggingToDismiss ? dismissDrag.width * 0.3 : 0),
                    y: offset.height + (isDraggingToDismiss ? dismissDrag.height : 0)
                )
                .scaleEffect(isDraggingToDismiss ? max(0.7, 1.0 - abs(dismissDrag.height) / 1000) : 1.0)
                .gesture(combinedGesture(containerSize: geo.size))
                .onTapGesture(count: 2) { location in
                    withAnimation(.spring(duration: 0.3)) {
                        if scale > 1.5 {
                            resetZoom()
                        } else {
                            let newScale: CGFloat = 3.0
                            let cx = geo.size.width / 2, cy = geo.size.height / 2
                            scale = newScale; lastScale = newScale
                            offset = CGSize(width: (cx - location.x) * (newScale - 1),
                                            height: (cy - location.y) * (newScale - 1))
                            lastOffset = offset
                        }
                    }
                }

                // Gallery arrows
                if imageURLs.count > 1 {
                    HStack {
                        if currentIndex > 0 {
                            navButton(systemName: "chevron.left.circle.fill") {
                                resetZoom()
                                withAnimation(.easeInOut(duration: 0.25)) { currentIndex -= 1 }
                            }
                            .padding(.leading, 16)
                        }
                        Spacer()
                        if currentIndex < imageURLs.count - 1 {
                            navButton(systemName: "chevron.right.circle.fill") {
                                resetZoom()
                                withAnimation(.easeInOut(duration: 0.25)) { currentIndex += 1 }
                            }
                            .padding(.trailing, 16)
                        }
                    }
                }

                // Chrome: close button + counter
                VStack {
                    HStack {
                        Spacer()
                        Button(action: onDismiss) {
                            Image(systemName: "xmark.circle.fill")
                                .font(.title)
                                .foregroundStyle(.white.opacity(0.8))
                                .padding()
                        }
                        .buttonStyle(.plain)
                    }
                    Spacer()
                    if imageURLs.count > 1 {
                        Text("\(currentIndex + 1) / \(imageURLs.count)")
                            .font(.caption).fontWeight(.medium)
                            .foregroundStyle(.white.opacity(0.8))
                            .padding(.horizontal, 12).padding(.vertical, 4)
                            .background(.black.opacity(0.4), in: Capsule())
                            .padding(.bottom, 12)
                    }
                }
                .opacity(backgroundOpacity)
            }
        }
        .focusable()
        .focused($isFocused)
        .onAppear { isFocused = true }
        #if os(macOS)
        .onKeyPress(.escape) { onDismiss(); return .handled }
        .onKeyPress(.leftArrow) {
            if currentIndex > 0 { resetZoom(); withAnimation { currentIndex -= 1 } }
            return .handled
        }
        .onKeyPress(.rightArrow) {
            if currentIndex < imageURLs.count - 1 { resetZoom(); withAnimation { currentIndex += 1 } }
            return .handled
        }
        #endif
    }

    private func navButton(systemName: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.largeTitle)
                .foregroundStyle(.white.opacity(0.7))
        }
        .buttonStyle(.plain)
    }

    private func resetZoom() {
        scale = 1.0; lastScale = 1.0
        offset = .zero; lastOffset = .zero
    }

    // MARK: - Simultaneous pinch + pan gesture (Photos-style)

    private func combinedGesture(containerSize: CGSize) -> some Gesture {
        SimultaneousGesture(
            MagnifyGesture(),
            DragGesture()
        )
        .onChanged { value in
            // Pinch
            if let magnification = value.first?.magnification {
                scale = max(0.5, min(lastScale * magnification, 10.0))
            }
            // Drag
            if let translation = value.second?.translation {
                if scale > 1.01 {
                    // Pan within zoomed image
                    offset = CGSize(
                        width: lastOffset.width + translation.width / scale,
                        height: lastOffset.height + translation.height / scale
                    )
                } else if value.first == nil {
                    // Only dragging (no pinch) at 1x → swipe to dismiss
                    dismissDrag = translation
                    let progress = min(abs(translation.height) / 300, 1.0)
                    backgroundOpacity = Double(1.0 - progress * 0.6)
                }
            }
        }
        .onEnded { value in
            // Finalize pinch
            lastScale = scale
            if scale < 1.0 {
                withAnimation(.spring(duration: 0.3)) { resetZoom() }
            }
            // Finalize drag
            if scale > 1.01 {
                lastOffset = offset
            } else if dismissDrag != .zero {
                let vy = value.second?.velocity.height ?? 0
                if abs(dismissDrag.height) > 120 || abs(vy) > 800 {
                    onDismiss()
                } else {
                    withAnimation(.spring(duration: 0.3)) {
                        dismissDrag = .zero
                        backgroundOpacity = 1.0
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

private func prettyJSON<T: Encodable>(_ value: T) -> String {
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

