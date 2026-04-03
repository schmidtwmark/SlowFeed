import SwiftUI

struct SavedPostsView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // Header
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
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(appState.savedPostGroups) { group in
                            // Source section header
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

                            // Posts
                            if group.source == .bluesky {
                                BlueskyThreadedView(posts: group.posts, source: group.source, digestId: nil)
                            } else {
                                ForEach(group.posts) { post in
                                    PostView(post: post, source: group.source, digestId: nil)
                                    Divider()
                                }
                            }
                        }
                    }
                }
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
