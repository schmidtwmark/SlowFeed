import SwiftUI

struct MainView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        NavigationSplitView {
            DigestSidebar()
        } detail: {
            DigestDetailView()
        }
        .toolbar {
            #if os(macOS)
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task {
                        try? await appState.triggerPoll()
                    }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help("Refresh feeds")
            }
            #endif
        }
        #if os(macOS)
        .frame(minWidth: 800, minHeight: 500)
        #endif
    }
}

// MARK: - Sidebar (Digest Timeline)

struct DigestSidebar: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        VStack(spacing: 0) {
            // Digest list
            List(selection: Binding(
                get: { appState.currentDigest?.id },
                set: { id in
                    if let id, let index = appState.digests.firstIndex(where: { $0.id == id }) {
                        Task {
                            await appState.navigateToDigest(at: index)
                        }
                    }
                }
            )) {
                ForEach(appState.digests) { digest in
                    DigestRow(digest: digest)
                        .tag(digest.id)
                }
            }
            .listStyle(.sidebar)

            Divider()

            // Source filter toolbar at bottom
            SourceToolbar()
        }
        .navigationTitle("Slowfeed")
        #if os(iOS)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink {
                    SettingsView()
                } label: {
                    Image(systemName: "gear")
                }
            }

            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task {
                        try? await appState.triggerPoll()
                    }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
            }
        }
        #endif
    }
}

struct DigestRow: View {
    let digest: DigestSummary

    var body: some View {
        HStack(spacing: 10) {
            // Source color indicator
            Circle()
                .fill(sourceColor)
                .frame(width: 8, height: 8)

            VStack(alignment: .leading, spacing: 2) {
                Text(digest.title)
                    .font(.subheadline)
                    .fontWeight(digest.isRead ? .regular : .semibold)
                    .lineLimit(2)

                HStack(spacing: 8) {
                    Text(digest.source.displayName)
                        .font(.caption)
                        .foregroundStyle(sourceColor)

                    Text("\(digest.postCount) posts")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Spacer()

                    Text(formattedDate)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if !digest.isRead {
                Circle()
                    .fill(.blue)
                    .frame(width: 8, height: 8)
            }
        }
        .padding(.vertical, 2)
    }

    private var sourceColor: Color {
        switch digest.source {
        case .reddit: return .orange
        case .bluesky: return .blue
        case .youtube: return .red
        case .discord: return .purple
        }
    }

    private var formattedDate: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(digest.publishedAt) {
            return digest.publishedAt.formatted(date: .omitted, time: .shortened)
        } else if calendar.isDateInYesterday(digest.publishedAt) {
            return "Yesterday"
        } else {
            return digest.publishedAt.formatted(.dateTime.month(.abbreviated).day())
        }
    }
}

// MARK: - Source Filter Toolbar

struct SourceToolbar: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        HStack(spacing: 0) {
            SourceFilterButton(label: "All", icon: "square.stack.3d.up", isSelected: appState.selectedSource == nil) {
                Task { await appState.selectSource(nil) }
            }

            ForEach(appState.sources, id: \.id) { source in
                if source.enabled, let sourceType = SourceType(rawValue: source.id) {
                    SourceFilterButton(
                        label: sourceType.displayName,
                        icon: sourceType.iconName,
                        isSelected: appState.selectedSource == sourceType
                    ) {
                        Task { await appState.selectSource(sourceType) }
                    }
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(.ultraThinMaterial)
    }
}

struct SourceFilterButton: View {
    let label: String
    let icon: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Image(systemName: icon)
                    .font(.system(size: 16))
                Text(label)
                    .font(.caption2)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
            .background(isSelected ? Color.accentColor.opacity(0.2) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Detail View

struct DigestDetailView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        if appState.isLoading && appState.currentDigest == nil {
            ProgressView("Loading...")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let digest = appState.currentDigest {
            DigestView(digest: digest)
        } else if appState.digests.isEmpty {
            ContentUnavailableView(
                "No Digests",
                systemImage: "doc.text",
                description: Text("No digests available. Try refreshing or check your source configuration.")
            )
        } else {
            ContentUnavailableView(
                "Select a Digest",
                systemImage: "doc.text",
                description: Text("Choose a digest from the sidebar")
            )
        }
    }
}

#Preview {
    MainView()
        .environment(AppState())
}
