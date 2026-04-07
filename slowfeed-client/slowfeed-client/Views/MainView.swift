import SwiftUI

struct MainView: View {
    @Environment(AppState.self) private var appState
    @State private var selectedTab: AppTab = .digests

    @State private var httpLogger = HTTPLogger.shared

    enum AppTab: String {
        case digests, saved, network, settings
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

    var body: some View {
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
            // Status row
            Section {
                HStack(spacing: 8) {
                    if appState.isRefreshing {
                        ProgressView()
                            .controlSize(.small)
                        Text("Refreshing...")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if let lastDate = appState.digests.first?.publishedAt {
                        Image(systemName: "checkmark.circle")
                            .font(.caption)
                            .foregroundStyle(.green)
                        Text("Last: \(lastDate.formatted(.relative(presentation: .named)))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text("\(appState.digests.count) digests")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .listRowBackground(Color.clear)
            }

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
        #if os(macOS)
        .tint(.secondary)
        #endif
        .navigationTitle("Slowfeed")
        .refreshable {
            await appState.refreshDigests()
        }
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
    @State private var debugJSON: String?

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

    private var sourceColor: Color {
        switch digest.source {
        case .reddit: return .orange
        case .bluesky: return .blue
        case .youtube: return .red
        case .discord: return .purple
        }
    }
}

// MARK: - Detail View

struct DigestDetailView: View {
    @Environment(AppState.self) private var appState
    @State private var showPollConfirmation = false

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
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showPollConfirmation = true
                } label: {
                    Label("Fetch New Content", systemImage: "arrow.trianglehead.2.counterclockwise.rotate.90")
                }
                .disabled(appState.isPolling)
            }
        }
        .confirmationDialog("Fetch New Content", isPresented: $showPollConfirmation) {
            Button("Fetch Now") {
                Task {
                    try? await appState.triggerPoll()
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Are you sure you want to fetch new content from all sources? This will poll Reddit, Bluesky, YouTube, and any other enabled sources.")
        }
    }
}

#Preview {
    MainView()
        .environment(AppState())
}
