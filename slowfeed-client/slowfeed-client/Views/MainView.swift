import SwiftUI

struct MainView: View {
    @Environment(AppState.self) private var appState

    @State private var showingSettings = false

    var body: some View {
        NavigationSplitView {
            SourceSidebar()
        } detail: {
            DigestContentView()
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

struct SourceSidebar: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        List(selection: Binding(
            get: { appState.selectedSource },
            set: { source in
                Task {
                    await appState.selectSource(source)
                }
            }
        )) {
            Section {
                Label("All Sources", systemImage: "square.stack.3d.up")
                    .tag(nil as SourceType?)
            }

            Section("Sources") {
                ForEach(appState.sources, id: \.id) { source in
                    if source.enabled, let sourceType = SourceType(rawValue: source.id) {
                        Label(source.name, systemImage: sourceType.iconName)
                            .tag(sourceType as SourceType?)
                    }
                }
            }
        }
        .listStyle(.sidebar)
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
        }
        #endif
    }
}

struct DigestContentView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        VStack(spacing: 0) {
            // Main content
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
                    description: Text("Choose a digest from the timeline below")
                )
            }

            Divider()

            // Timeline bar
            TimelineBar()
        }
        .navigationTitle(appState.currentDigest?.title ?? "Slowfeed")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
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

#Preview {
    MainView()
        .environment(AppState())
}
