import SwiftUI

struct MainView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        NavigationSplitView {
            DigestSidebar()
        } detail: {
            if appState.showingSavedPosts {
                SavedPostsView()
            } else {
                DigestDetailView()
            }
        }
        .toolbar {
            #if os(macOS)
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { await appState.refreshDigests() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(appState.isRefreshing)
                .help("Refresh digest list")
            }

            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { try? await appState.triggerPoll() }
                } label: {
                    Image(systemName: "arrow.triangle.2.circlepath")
                }
                .help("Trigger new poll from sources")
            }
            #endif
        }
        #if os(macOS)
        .frame(minWidth: 800, minHeight: 500)
        #endif
    }
}

// MARK: - Sidebar (Digest Timeline grouped by poll run)

struct DigestSidebar: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        VStack(spacing: 0) {
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
                ForEach(groupedDigests) { group in
                    Section(isExpanded: Binding(
                        get: { appState.expandedGroups.contains(group.id) },
                        set: { expanded in
                            if expanded {
                                appState.expandedGroups.insert(group.id)
                            } else {
                                appState.expandedGroups.remove(group.id)
                            }
                        }
                    )) {
                        ForEach(group.digests) { digest in
                            DigestRow(digest: digest)
                                .tag(digest.id)
                        }
                    } header: {
                        HStack {
                            Text(group.label)
                                .font(.subheadline)
                                .fontWeight(.semibold)

                            Spacer()

                            Text("\(group.totalPosts) posts")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
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

    // MARK: - Grouping Logic

    private var groupedDigests: [DigestGroup] {
        let calendar = Calendar.current

        // Group digests by poll run ID, falling back to hour-based grouping
        var groups: [String: [DigestSummary]] = [:]
        var groupDates: [String: Date] = [:]

        for digest in appState.digests {
            let groupKey: String
            if let pollRunId = digest.pollRunId {
                groupKey = "run_\(pollRunId)"
            } else {
                // Fall back to grouping by hour
                let components = calendar.dateComponents([.year, .month, .day, .hour], from: digest.publishedAt)
                groupKey = "time_\(components.year!)_\(components.month!)_\(components.day!)_\(components.hour!)"
            }

            groups[groupKey, default: []].append(digest)
            // Use earliest date in group for sorting
            if let existing = groupDates[groupKey] {
                groupDates[groupKey] = max(existing, digest.publishedAt)
            } else {
                groupDates[groupKey] = digest.publishedAt
            }
        }

        return groups.map { key, digests in
            let date = groupDates[key] ?? Date()
            return DigestGroup(
                id: key,
                date: date,
                label: formatGroupLabel(date: date),
                digests: digests.sorted { $0.source.rawValue < $1.source.rawValue },
                totalPosts: digests.reduce(0) { $0 + $1.postCount }
            )
        }
        .sorted { $0.date > $1.date }
    }

    private func formatGroupLabel(date: Date) -> String {
        let calendar = Calendar.current
        let timeStr = date.formatted(date: .omitted, time: .shortened)

        if calendar.isDateInToday(date) {
            return "Today \(timeStr)"
        } else if calendar.isDateInYesterday(date) {
            return "Yesterday \(timeStr)"
        } else {
            let dayStr = date.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
            return "\(dayStr) \(timeStr)"
        }
    }
}

struct DigestGroup: Identifiable {
    let id: String
    let date: Date
    let label: String
    let digests: [DigestSummary]
    let totalPosts: Int
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
                Text(digest.source.displayName)
                    .font(.subheadline)
                    .fontWeight(digest.isRead ? .regular : .semibold)

                Text("\(digest.postCount) posts")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

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
}

// MARK: - Source Filter Toolbar

struct SourceToolbar: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        HStack(spacing: 0) {
            SourceFilterButton(label: "All", icon: "square.stack.3d.up", isSelected: appState.selectedSource == nil && !appState.showingSavedPosts) {
                appState.showingSavedPosts = false
                Task { await appState.selectSource(nil) }
            }

            ForEach(appState.sources, id: \.id) { source in
                if source.enabled, let sourceType = SourceType(rawValue: source.id) {
                    SourceFilterButton(
                        label: sourceType.displayName,
                        icon: sourceType.iconName,
                        isSelected: appState.selectedSource == sourceType && !appState.showingSavedPosts
                    ) {
                        appState.showingSavedPosts = false
                        Task { await appState.selectSource(sourceType) }
                    }
                }
            }

            SourceFilterButton(label: "Saved", icon: "bookmark.fill", isSelected: appState.showingSavedPosts) {
                appState.showingSavedPosts = true
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
        ZStack {
            if let digest = appState.currentDigest {
                DigestView(digest: digest)
                    .id(digest.id)
            } else if appState.isLoading {
                ProgressView("Loading...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
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

            // Overlay loading indicator when switching digests
            if appState.digestLoading {
                VStack {
                    Spacer()
                    ProgressView()
                        .controlSize(.large)
                        .padding()
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            // Error overlay
            if let error = appState.digestError {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.largeTitle)
                        .foregroundStyle(.red)
                    Text("Failed to load digest")
                        .font(.headline)
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .textSelection(.enabled)
                        .padding(.horizontal)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.ultraThinMaterial)
            }
        }
    }
}

#Preview {
    MainView()
        .environment(AppState())
}
