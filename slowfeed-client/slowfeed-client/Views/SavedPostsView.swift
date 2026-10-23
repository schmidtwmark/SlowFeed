import SwiftUI

struct SavedPostsView: View {
    @Environment(AppState.self) private var appState
    @Namespace private var imageNamespace
    @State private var viewerImages: [PostMedia] = []
    @State private var viewerIndex: Int = 0
    @State private var showViewer = false

    private func openImageViewer(images: [PostMedia], index: Int) {
        viewerImages = images
        viewerIndex = index
        withAnimation(.spring(duration: 0.4, bounce: 0.15)) { showViewer = true }
    }

    var body: some View {
        ZStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text("Saved Posts")
                            .font(.title2)
                            .fontWeight(.semibold)
                        Spacer()
                        Text("\(totalCount) saved")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding()

                    Divider()

                    if appState.savedPostGroups.isEmpty {
                        ContentUnavailableView(
                            "No Saved Posts",
                            systemImage: "bookmark",
                            description: Text("Long-press or right-click a post and choose \"Save for Later\" to save it here.")
                        )
                        .padding(.top, 40)
                    } else {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(chronologicalPosts) { saved in
                                HStack {
                                    SourceBadge(source: saved.source)
                                    Spacer()
                                    if let savedAt = saved.post.savedAt {
                                        Text("Saved \(savedAt.formatted(.relative(presentation: .named)))")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                .padding(.horizontal)
                                .padding(.top, 8)

                                if saved.source == .bluesky {
                                    // Includes its own trailing Divider
                                    BlueskyThreadedView(posts: [saved.post], source: saved.source, digestId: nil, imageNamespace: imageNamespace, onSelectImage: openImageViewer)
                                } else {
                                    PostView(post: saved.post, source: saved.source, digestId: nil, imageNamespace: imageNamespace, onSelectImage: openImageViewer)
                                    Divider()
                                }
                            }
                        }
                    }
                }
            }
            .allowsHitTesting(!showViewer)

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
        .task {
            await appState.loadSavedPosts()
        }
    }

    private struct SavedPost: Identifiable {
        let source: SourceType
        let post: DigestPost
        var id: String { post.postId }
    }

    /// All saved posts across sources, most recently saved first. The server
    /// groups by source (each group already newest-first), so merge and re-sort.
    private var chronologicalPosts: [SavedPost] {
        appState.savedPostGroups
            .flatMap { group in group.posts.map { SavedPost(source: group.source, post: $0) } }
            .sorted { ($0.post.savedAt ?? .distantPast) > ($1.post.savedAt ?? .distantPast) }
    }

    private var totalCount: Int {
        appState.savedPostGroups.reduce(0) { $0 + $1.posts.count }
    }
}
