import SwiftUI

struct SavedPostsView: View {
    @Environment(AppState.self) private var appState
    @Namespace private var imageNamespace
    @State private var viewerURLs: [URL] = []
    @State private var viewerIndex: Int = 0
    @State private var showViewer = false

    private func openImageViewer(urls: [URL], index: Int) {
        viewerURLs = urls
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
                            ForEach(appState.savedPostGroups) { group in
                                HStack {
                                    SourceBadge(source: group.source)
                                    Text("\(group.posts.count) post\(group.posts.count == 1 ? "" : "s")")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    Spacer()
                                }
                                .padding(.horizontal)
                                .padding(.vertical, 8)
                                .background(.quaternary.opacity(0.3))

                                if group.source == .bluesky {
                                    BlueskyThreadedView(posts: group.posts, source: group.source, digestId: nil, imageNamespace: imageNamespace, onSelectImage: openImageViewer)
                                } else {
                                    ForEach(group.posts) { post in
                                        PostView(post: post, source: group.source, digestId: nil, imageNamespace: imageNamespace, onSelectImage: openImageViewer)
                                        Divider()
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .allowsHitTesting(!showViewer)

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
        .task {
            await appState.loadSavedPosts()
        }
    }

    private var totalCount: Int {
        appState.savedPostGroups.reduce(0) { $0 + $1.posts.count }
    }
}
