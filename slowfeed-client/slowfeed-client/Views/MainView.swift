import SwiftUI

struct MainView: View {
    @Environment(AppState.self) private var appState
    @State private var selectedTab: AppTab = .digests

    @State private var httpLogger = HTTPLogger.shared

    enum AppTab: String {
        case digests, search, saved, network, settings
    }

    var body: some View {
        TabView(selection: $selectedTab) {
            SwiftUI.Tab("Digests", systemImage: "doc.text.fill", value: AppTab.digests) {
                NavigationSplitView {
                    DigestSidebar()
                } detail: {
                    DigestDetailView()
                }
                #if os(macOS)
                .frame(minWidth: 800, minHeight: 500)
                #endif
            }

            SwiftUI.Tab("Search", systemImage: "magnifyingglass", value: AppTab.search) {
                NavigationStack {
                    SearchView()
                }
            }

            SwiftUI.Tab("Saved", systemImage: "bookmark.fill", value: AppTab.saved) {
                NavigationStack {
                    SavedPostsView()
                        .navigationTitle("Saved")
                        #if !os(macOS)
                        .navigationBarTitleDisplayMode(.inline)
                        #endif
                }
            }

            if httpLogger.isEnabled {
                SwiftUI.Tab("Network", systemImage: "network", value: AppTab.network) {
                    NavigationStack {
                        HTTPLogView()
                            .navigationTitle("Network")
                            #if !os(macOS)
                            .navigationBarTitleDisplayMode(.inline)
                            #endif
                    }
                }
            }

            #if !os(macOS)
            SwiftUI.Tab("Settings", systemImage: "gear", value: AppTab.settings) {
                NavigationStack {
                    SettingsView()
                        .navigationTitle("Settings")
                        .navigationBarTitleDisplayMode(.inline)
                }
            }
            #endif
        }
        #if os(iOS)
        .tabViewStyle(.sidebarAdaptable)
        #endif
    }
}

// MARK: - Sidebar (Digest Timeline grouped by poll run)

struct DigestSidebar: View {
    @Environment(AppState.self) private var appState
    @State private var selection: String?

    var body: some View {
        List(selection: $selection) {
            ForEach(dateSections) { dateSection in
                Section {
                    ForEach(dateSection.groups) { group in
                        // Header row — looks like one of the digest rows
                        // below it and tapping it expands or collapses
                        // that group's source rows. No Section chrome
                        // around the poll-run group itself: the header
                        // IS a first-class row in the list.
                        GroupHeaderRow(
                            group: group,
                            isExpanded: appState.expandedGroups.contains(group.id),
                            toggle: { toggleExpansion(group.id) }
                        )

                        if appState.expandedGroups.contains(group.id) {
                            ForEach(group.digests) { digest in
                                DigestRow(digest: digest, isSelected: appState.currentDigest?.id == digest.id)
                                    .tag(digest.id)
                            }
                        }
                    }
                } header: {
                    Text(dateSection.label)
                }
            }
        }
        .listStyle(.sidebar)
        #if os(macOS)
        .navigationTitle("Slowfeed")
        .navigationSubtitle(lastUpdatedText)
        #else
        .navigationTitle("Slowfeed")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text("Slowfeed")
                        .font(.headline)
                    if !lastUpdatedText.isEmpty {
                        Text(lastUpdatedText)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        #endif
        .refreshable {
            await appState.refreshDigests()
        }
        .onChange(of: selection) { _, id in
            // Re-navigate on every selection change, even when it matches
            // `currentDigest?.id` — on iPhone compact, `NavigationSplitView`
            // clears the List's selection on pop, so a re-tap of the same
            // row is a real nil → id transition and should re-push the
            // detail. A stale `id == currentDigest?.id` guard here is what
            // produced MAR-30.
            guard let id,
                  let index = appState.digests.firstIndex(where: { $0.id == id }) else { return }
            appState.keyboardFocusPane = .posts
            Task { await appState.navigateToDigest(at: index) }
        }
        .onChange(of: appState.currentDigest?.id) { _, id in
            // Keep the List's selection in sync when navigation is driven
            // from elsewhere (keyboard shortcuts, auto-select on load, …).
            if selection != id { selection = id }
        }
    }

    private func toggleExpansion(_ groupId: String) {
        withAnimation {
            if appState.expandedGroups.contains(groupId) {
                appState.expandedGroups.remove(groupId)
            } else {
                appState.expandedGroups.insert(groupId)
            }
        }
    }

    private var lastUpdatedText: String {
        if appState.isRefreshing {
            return "Refreshing..."
        } else if let lastDate = appState.digests.first?.publishedAt {
            return "Last: \(lastDate.formatted(.relative(presentation: .named)))"
        }
        return ""
    }

    // MARK: - Grouping Logic

    private var groupedDigests: [DigestGroup] {
        let calendar = Calendar.current

        // Group digests by poll run ID, falling back to hour-based grouping.
        var groups: [String: [DigestSummary]] = [:]
        var groupDates: [String: Date] = [:]

        for digest in appState.digests {
            let groupKey: String
            if let pollRunId = digest.pollRunId {
                groupKey = "run_\(pollRunId)"
            } else {
                let components = calendar.dateComponents([.year, .month, .day, .hour], from: digest.publishedAt)
                groupKey = "time_\(components.year!)_\(components.month!)_\(components.day!)_\(components.hour!)"
            }

            groups[groupKey, default: []].append(digest)
            if let existing = groupDates[groupKey] {
                groupDates[groupKey] = max(existing, digest.publishedAt)
            } else {
                groupDates[groupKey] = digest.publishedAt
            }
        }

        return groups.map { key, digests in
            let date = groupDates[key] ?? Date()
            // Use the schedule name captured at poll-run time as the row
            // label; fall back to the time-of-day for legacy digests with
            // no name. The wider date Section header already shows the day.
            let pollRunName = digests
                .compactMap(\.pollRunName)
                .first { !$0.isEmpty }
            let label = pollRunName ?? date.formatted(date: .omitted, time: .shortened)
            return DigestGroup(
                id: key,
                date: date,
                label: label,
                digests: digests.sorted { $0.source.rawValue < $1.source.rawValue },
                totalPosts: digests.reduce(0) { $0 + $1.postCount }
            )
        }
        .sorted { $0.date > $1.date }
    }

    /// Top-level date buckets that wrap poll-run groups. The sidebar
    /// renders one Section per day (Today / Yesterday / Wed Apr 30),
    /// containing that day's poll-run groups in reverse-chron order.
    private var dateSections: [DateSection] {
        let calendar = Calendar.current
        var bucketed: [Date: [DigestGroup]] = [:]
        for group in groupedDigests {
            let day = calendar.startOfDay(for: group.date)
            bucketed[day, default: []].append(group)
        }
        return bucketed.map { day, groups in
            DateSection(
                id: ISO8601DateFormatter().string(from: day),
                date: day,
                label: formatDateSectionLabel(date: day),
                groups: groups.sorted { $0.date > $1.date }
            )
        }
        .sorted { $0.date > $1.date }
    }

    private func formatDateSectionLabel(date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
    }
}

struct DateSection: Identifiable {
    let id: String
    let date: Date
    let label: String
    let groups: [DigestGroup]
}

struct DigestGroup: Identifiable {
    let id: String
    let date: Date
    let label: String
    let digests: [DigestSummary]
    let totalPosts: Int

    var hasUnread: Bool { digests.contains { !$0.isRead } }
}

/// First-class row that doubles as the section header for a poll-run
/// group. Tap toggles the group's expansion. Visually mirrors
/// `DigestRow`'s shape (icon + label + trailing post count) so the
/// sidebar reads as a flat list of rows where some rows happen to
/// have children underneath them.
struct GroupHeaderRow: View {
    let group: DigestGroup
    let isExpanded: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(group.label)
                        .fontWeight(group.hasUnread ? .semibold : .regular)
                        .foregroundStyle(group.hasUnread ? .primary : .secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)

                    Text("\(group.totalPosts) post\(group.totalPosts == 1 ? "" : "s")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 8)

                // Trailing chevron, vertically centered against the
                // two-line title/subtitle stack thanks to the HStack's
                // default centerY alignment.
                Image(systemName: "chevron.right")
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    .animation(.easeInOut(duration: 0.18), value: isExpanded)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct DigestRow: View {
    let digest: DigestSummary
    var isSelected: Bool = false
    @State private var debugJSON: String?

    var body: some View {
        HStack(spacing: 12) {
            // Per-source SF Symbol. The icon grays from the top down as the
            // user reads: fully colored = unread, fully gray = finished,
            // partially gray = read that far through. Replaces the old
            // binary colored/gray indicator.
            sourceIconView
                .font(.body)
                .frame(width: 22)

            Text(digest.source.displayName)
                .font(.subheadline)
                .fontWeight(digest.isRead ? .regular : .semibold)
                .foregroundStyle(digest.isRead ? .secondary : .primary)

            Spacer()

            Text("\(digest.postCount) posts")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .contextMenu {
            Button {
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                encoder.dateEncodingStrategy = .iso8601
                if let data = try? encoder.encode(digest),
                   let string = String(data: data, encoding: .utf8) {
                    debugJSON = string
                }
            } label: {
                Label("Show Raw JSON", systemImage: "curlybraces")
            }
        }
        .sheet(item: $debugJSON) { json in
            DebugJSONView(title: "Digest Summary", json: json)
        }
    }

    /// Source icon that grays from the top down in proportion to how far
    /// the user has read. A colored base with a gray copy masked to the
    /// top `readProgress` fraction layered over it.
    private var sourceIconView: some View {
        Image(systemName: sourceIcon)
            .foregroundStyle(sourceColor)
            .overlay {
                Image(systemName: sourceIcon)
                    .foregroundStyle(.secondary)
                    .mask(alignment: .top) {
                        GeometryReader { geo in
                            // Fully-read digests (read_at set) always show
                            // fully gray, even if read_progress predates this
                            // feature and is still 0.
                            let fraction = digest.isRead ? 1.0 : digest.readProgress
                            Rectangle()
                                .frame(height: geo.size.height * fraction)
                        }
                    }
            }
    }

    /// Match the icons used in the Settings source tabs so source identity
    /// is consistent across the app.
    private var sourceIcon: String {
        switch digest.source {
        case .reddit: return "bubble.left.and.bubble.right.fill"
        case .bluesky: return "cloud.fill"
        case .youtube: return "play.rectangle.fill"
        case .discord: return "message.fill"
        case .mastodon: return "at"
        case .rss: return "dot.radiowaves.left.and.right"
        }
    }

    private var sourceColor: Color {
        switch digest.source {
        case .reddit: return .orange
        case .bluesky: return .blue
        case .youtube: return .red
        case .discord: return .purple
        case .mastodon: return .indigo
        case .rss: return .yellow
        }
    }
}

// MARK: - Detail View

struct DigestDetailView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        ZStack {
            if let digest = appState.currentDigest {
                // NavigationStack so PostView can push RSSReaderView via
                // .navigationDestination. NavigationSplitView's detail
                // pane doesn't supply one on its own.
                NavigationStack {
                    DigestView(digest: digest)
                        .id(digest.id)
                        // Cross-fade when the user picks a different
                        // source from the SourceTabBar so the swap
                        // feels smooth instead of a hard cut. The
                        // .animation modifier on the enclosing ZStack
                        // drives the transition when currentDigest.id
                        // changes (set inside an async Task by
                        // navigateToDigest).
                        .transition(.opacity)
                }
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

            // Poll progress overlay
            if appState.isPolling {
                VStack(spacing: 12) {
                    ProgressView()
                        .controlSize(.large)
                    Text(appState.pollStatusMessage ?? "Fetching new content...")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(24)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
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
        // Drives the .transition(.opacity) on DigestView when the user
        // switches sources via the bottom SourceTabBar — without this
        // anchor, the id change happens outside any animation context
        // and the swap is a hard cut.
        .animation(.easeInOut(duration: 0.18), value: appState.currentDigest?.id)
    }
}

#Preview {
    MainView()
        .environment(AppState())
}
