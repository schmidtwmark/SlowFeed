import SwiftUI

/// Full-text search across the user's entire post archive. Lives in
/// its own tab on the main TabView. The search bar is `.searchable`
/// (system styling); a horizontal pill row above the results lets
/// the user scope to one source (or `All`). Tapping a result
/// navigates into the parent digest.
struct SearchView: View {
    @Environment(AppState.self) private var appState

    @State private var query: String = ""
    @State private var debouncedQuery: String = ""
    @State private var sourceFilter: SourceType?
    @State private var results: [PostSearchResult] = []
    @State private var isLoading: Bool = false
    @State private var error: String?
    @State private var searchTask: Task<Void, Never>?

    var body: some View {
        List {
            Section {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        SourceFilterPill(title: "All", isActive: sourceFilter == nil) {
                            sourceFilter = nil
                        }
                        ForEach(SourceType.allCases) { source in
                            SourceFilterPill(
                                title: source.displayName,
                                systemImage: sourceIcon(for: source),
                                isActive: sourceFilter == source
                            ) {
                                sourceFilter = (sourceFilter == source) ? nil : source
                            }
                        }
                    }
                    .padding(.horizontal, 4)
                    .padding(.vertical, 2)
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }

            if debouncedQuery.count < 2 {
                Section {
                    ContentUnavailableView(
                        "Search Posts",
                        systemImage: "magnifyingglass",
                        description: Text("Find posts across every digest by title, author, or body text.")
                    )
                }
                .listRowBackground(Color.clear)
            } else if isLoading && results.isEmpty {
                Section {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                }
            } else if let error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
            } else if results.isEmpty {
                Section {
                    ContentUnavailableView.search(text: debouncedQuery)
                }
                .listRowBackground(Color.clear)
            } else {
                Section {
                    ForEach(results) { result in
                        Button {
                            // Set the pending scroll target *before*
                            // navigating so DigestView picks it up on
                            // appear / digest.id change.
                            appState.pendingScrollPostId = result.postId
                            Task {
                                await appState.navigateToDigest(id: result.digestId)
                            }
                        } label: {
                            SearchResultRow(result: result)
                        }
                        .buttonStyle(.plain)
                    }
                } footer: {
                    if results.count >= 100 {
                        Text("Showing the 100 most recent matches. Refine your query for more.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        #if os(macOS)
        .searchable(text: $query, prompt: "Search posts")
        #else
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                    prompt: "Search posts")
        #endif
        .onChange(of: query) { _, _ in scheduleSearch() }
        .onChange(of: sourceFilter) { _, _ in runSearch(immediate: true) }
        .navigationTitle("Search")
        #if !os(macOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    /// Debounce 250ms so we don't fire a query per keystroke.
    private func scheduleSearch() {
        searchTask?.cancel()
        let snapshot = query
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                debouncedQuery = snapshot
                runSearch(immediate: false)
            }
        }
    }

    private func runSearch(immediate: Bool) {
        if immediate { debouncedQuery = query }
        let trimmed = debouncedQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else {
            results = []
            error = nil
            isLoading = false
            return
        }
        isLoading = true
        error = nil
        let source = sourceFilter
        Task {
            do {
                let hits = try await appState.apiClient.searchPosts(query: trimmed, source: source)
                await MainActor.run {
                    // Drop stale results if the query has changed since
                    // we started this fetch.
                    guard trimmed == debouncedQuery.trimmingCharacters(in: .whitespacesAndNewlines),
                          source == sourceFilter else { return }
                    results = hits
                    isLoading = false
                }
            } catch {
                await MainActor.run {
                    self.error = error.localizedDescription
                    self.results = []
                    self.isLoading = false
                }
            }
        }
    }

    private func sourceIcon(for source: SourceType) -> String {
        switch source {
        case .reddit: return "bubble.left.and.bubble.right.fill"
        case .bluesky: return "cloud.fill"
        case .youtube: return "play.rectangle.fill"
        case .discord: return "message.fill"
        case .mastodon: return "at"
        case .rss: return "dot.radiowaves.left.and.right"
        }
    }
}

private struct SourceFilterPill: View {
    let title: String
    var systemImage: String? = nil
    let isActive: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.caption)
                }
                Text(title)
                    .font(.subheadline)
                    .fontWeight(isActive ? .semibold : .regular)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background {
                Capsule(style: .continuous)
                    .fill(isActive ? Color.accentColor.opacity(0.2) : Color.secondary.opacity(0.12))
            }
            .foregroundStyle(isActive ? Color.accentColor : Color.primary)
        }
        .buttonStyle(.plain)
    }
}

private struct SearchResultRow: View {
    let result: PostSearchResult

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: sourceIcon)
                .font(.body)
                .foregroundStyle(sourceColor)
                .frame(width: 22)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(result.title)
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .lineLimit(2)
                if !result.snippet.isEmpty {
                    Text(result.snippet)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
                HStack(spacing: 6) {
                    if let author = result.author, !author.isEmpty {
                        Text(author)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Text(result.publishedAt.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var sourceIcon: String {
        switch result.source {
        case .reddit: return "bubble.left.and.bubble.right.fill"
        case .bluesky: return "cloud.fill"
        case .youtube: return "play.rectangle.fill"
        case .discord: return "message.fill"
        case .mastodon: return "at"
        case .rss: return "dot.radiowaves.left.and.right"
        }
    }

    private var sourceColor: Color {
        switch result.source {
        case .reddit: return .orange
        case .bluesky: return .blue
        case .youtube: return .red
        case .discord: return .purple
        case .mastodon: return .indigo
        case .rss: return .yellow
        }
    }
}
