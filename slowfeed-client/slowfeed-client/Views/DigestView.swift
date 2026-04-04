import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

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
}

// MARK: - Media View

struct MediaView: View {
    let media: [PostMedia]
    let postTitle: String

    @Environment(\.openURL) private var openURL
    @State private var selectedImageURL: URL?

    private var images: [PostMedia] { media.filter { $0.type == "image" } }
    private var videos: [PostMedia] { media.filter { $0.type == "video" } }
    private var allImageURLs: [URL] { images.compactMap { URL(string: $0.url) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !images.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(images, id: \.url) { img in
                            if let url = URL(string: img.url) {
                                CachedImage(url: url) {
                                    RoundedRectangle(cornerRadius: 8)
                                        .fill(.quaternary)
                                        .frame(width: 200, height: 150)
                                }
                                .aspectRatio(contentMode: .fit)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                                .frame(maxHeight: 300)
                                .onTapGesture {
                                    selectedImageURL = url
                                }
                                .contextMenu {
                                    mediaContextMenu(for: img)
                                }
                            }
                        }
                    }
                }
            }

            ForEach(videos, id: \.url) { vid in
                if let thumbUrl = vid.thumbnailUrl, let url = URL(string: thumbUrl) {
                    CachedImage(url: url) {
                        RoundedRectangle(cornerRadius: 8)
                            .fill(.quaternary)
                            .aspectRatio(16/9, contentMode: .fit)
                    }
                    .aspectRatio(contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(alignment: .center) {
                        Image(systemName: "play.circle.fill")
                            .font(.system(size: 44))
                            .foregroundStyle(.white.opacity(0.9))
                    }
                    .frame(maxHeight: 250)
                    .onTapGesture {
                        if let url = URL(string: vid.url) {
                            openURL(url)
                        }
                    }
                    .contextMenu {
                        mediaContextMenu(for: vid)
                    }
                }
            }
        }
        #if os(iOS)
        .fullScreenCover(item: $selectedImageURL) { url in
            ImageViewer(url: url, allImageURLs: allImageURLs)
        }
        #else
        .sheet(item: $selectedImageURL) { url in
            ImageViewer(url: url, allImageURLs: allImageURLs)
                .frame(minWidth: 600, minHeight: 400)
        }
        #endif
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

// Make URL work with fullScreenCover's item binding
extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}

// MARK: - Fullscreen Image Viewer

struct ImageViewer: View {
    let url: URL
    let allImageURLs: [URL]

    @Environment(\.dismiss) private var dismiss
    @State private var currentIndex: Int = 0
    @State private var scale: CGFloat = 1.0

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if allImageURLs.count > 1 {
                // Gallery with arrow navigation
                ZStack {
                    imageContent(url: allImageURLs[currentIndex])

                    // Navigation arrows
                    HStack {
                        if currentIndex > 0 {
                            Button {
                                withAnimation { currentIndex -= 1 }
                            } label: {
                                Image(systemName: "chevron.left.circle.fill")
                                    .font(.title)
                                    .foregroundStyle(.white.opacity(0.7))
                            }
                            .buttonStyle(.plain)
                            .padding(.leading)
                        }

                        Spacer()

                        if currentIndex < allImageURLs.count - 1 {
                            Button {
                                withAnimation { currentIndex += 1 }
                            } label: {
                                Image(systemName: "chevron.right.circle.fill")
                                    .font(.title)
                                    .foregroundStyle(.white.opacity(0.7))
                            }
                            .buttonStyle(.plain)
                            .padding(.trailing)
                        }
                    }
                }
            } else {
                imageContent(url: url)
            }

            // Close button + counter
            VStack {
                HStack {
                    Spacer()
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.title)
                            .foregroundStyle(.white.opacity(0.8))
                            .padding()
                    }
                    .buttonStyle(.plain)
                }
                Spacer()

                if allImageURLs.count > 1 {
                    Text("\(currentIndex + 1) / \(allImageURLs.count)")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.7))
                        .padding(.bottom, 8)
                }
            }
        }
        .focusable()
        .onAppear {
            if let idx = allImageURLs.firstIndex(of: url) {
                currentIndex = idx
            }
        }
        #if os(macOS)
        .onKeyPress(.escape) {
            dismiss()
            return .handled
        }
        .onKeyPress(.leftArrow) {
            if currentIndex > 0 { withAnimation { currentIndex -= 1 } }
            return .handled
        }
        .onKeyPress(.rightArrow) {
            if currentIndex < allImageURLs.count - 1 { withAnimation { currentIndex += 1 } }
            return .handled
        }
        #endif
    }

    @ViewBuilder
    private func imageContent(url: URL) -> some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                image
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .scaleEffect(scale)
                    .gesture(
                        MagnifyGesture()
                            .onChanged { value in
                                scale = max(0.5, value.magnification)
                            }
                            .onEnded { _ in
                                if scale < 1.0 {
                                    withAnimation(.spring(duration: 0.3)) { scale = 1.0 }
                                }
                            }
                    )
                    .onTapGesture(count: 2) {
                        withAnimation(.spring(duration: 0.3)) {
                            scale = scale > 1.5 ? 1.0 : 3.0
                        }
                    }
                    .onTapGesture(count: 1) {
                        dismiss()
                    }
            case .failure:
                VStack {
                    Image(systemName: "photo")
                        .font(.largeTitle)
                        .foregroundStyle(.white.opacity(0.5))
                    Text("Failed to load image")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.5))
                }
            default:
                ProgressView()
                    .tint(.white)
            }
        }
        .padding()
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
