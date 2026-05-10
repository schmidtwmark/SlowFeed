import SwiftUI
#if !os(macOS)
import UniformTypeIdentifiers
#endif

/// Source-settings page for RSS. Unlike the other sources (which are a
/// single form), RSS surfaces:
///   - A top-level Enabled toggle (mirrors `config.rss_enabled`).
///   - A list of subscribed feeds (each row toggleable / deletable).
///   - "Add Feed" — sheet with a URL input.
///   - "Import OPML" — file picker that uploads the file as raw XML.
struct RSSSettingsView: View {
    @Environment(AppState.self) private var appState

    @State private var rssEnabled: Bool = false
    @State private var feeds: [RSSFeed] = []
    @State private var isLoading = false
    @State private var loadError: String?

    @State private var isAdding = false
    @State private var newFeedURL: String = ""
    @State private var newFeedError: String?
    @State private var isSubmitting = false
    @State private var isTesting = false
    @State private var testResult: RSSFeedTestResult?

    @State private var showImporter = false
    @State private var importMessage: String?

    @State private var savingEnabled = false

    var body: some View {
        Form {
            Section {
                Toggle("Enabled", isOn: Binding(
                    get: { rssEnabled },
                    set: { newValue in
                        rssEnabled = newValue
                        Task { await saveEnabled(newValue) }
                    }
                ))
            } footer: {
                Text("When enabled, scheduled polls will fetch new items from every feed below.")
            }

            Section {
                Button {
                    isAdding = true
                } label: {
                    Label("Add Feed", systemImage: "plus.circle")
                }

                Button {
                    showImporter = true
                } label: {
                    Label("Import OPML", systemImage: "square.and.arrow.down")
                }

                if let importMessage {
                    Text(importMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Subscriptions")
            }

            Section {
                if isLoading {
                    ProgressView()
                } else if feeds.isEmpty {
                    Text("No feeds yet. Add a feed URL above or import an OPML file.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(feeds) { feed in
                        FeedRow(
                            feed: feed,
                            onToggle: { newValue in Task { await setEnabled(feed.id, newValue) } }
                        )
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                Task { await delete(feed.id) }
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                }

                if let loadError {
                    Text(loadError)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            } header: {
                HStack {
                    Text("Feeds")
                    Spacer()
                    if !feeds.isEmpty {
                        Text("\(feeds.count)")
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("RSS")
        .task { await reload() }
        .onChange(of: appState.config) { _, newConfig in
            if let cfg = newConfig { rssEnabled = cfg.rssEnabled }
        }
        .sheet(isPresented: $isAdding) { addFeedSheet }
        #if !os(macOS)
        .fileImporter(
            isPresented: $showImporter,
            allowedContentTypes: [
                UTType(filenameExtension: "opml") ?? .xml,
                .xml,
                .text,
            ],
            allowsMultipleSelection: false
        ) { result in
            handleImporterResult(result)
        }
        #else
        .sheet(isPresented: $showImporter) {
            macOSImportPicker { url in
                showImporter = false
                Task { await importOPML(from: url) }
            }
            .frame(minWidth: 400, minHeight: 200)
        }
        #endif
    }

    // MARK: - Add feed sheet

    @ViewBuilder
    private var addFeedSheet: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://example.com/feed.xml", text: $newFeedURL)
                        #if !os(macOS)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        #endif
                        .onChange(of: newFeedURL) { _, _ in
                            // Clear stale preview when the URL changes.
                            testResult = nil
                        }

                    Button {
                        Task { await testNewFeed() }
                    } label: {
                        if isTesting {
                            HStack {
                                ProgressView().controlSize(.small)
                                Text("Testing…")
                            }
                        } else {
                            Label("Test Feed", systemImage: "wand.and.stars")
                        }
                    }
                    .disabled(isTesting || newFeedURL.trimmingCharacters(in: .whitespaces).isEmpty)
                } footer: {
                    Text("Paste an RSS or Atom feed URL. Tap Test to preview items before subscribing.")
                }

                if let newFeedError {
                    Section {
                        Text(newFeedError).foregroundStyle(.red).font(.caption)
                    }
                }

                if let testResult {
                    Section {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(testResult.title)
                                .font(.headline)
                            if let site = testResult.siteUrl, !site.isEmpty {
                                Text(site)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            if let desc = testResult.description, !desc.isEmpty {
                                Text(desc)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                            Text("\(testResult.itemCount) item\(testResult.itemCount == 1 ? "" : "s") in feed")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    } header: {
                        Text("Feed")
                    }

                    Section {
                        if testResult.items.isEmpty {
                            Text("No items in this feed.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(testResult.items) { item in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.title)
                                        .font(.subheadline)
                                        .fontWeight(.medium)
                                        .lineLimit(2)
                                    if !item.snippet.isEmpty {
                                        Text(item.snippet)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(3)
                                    }
                                    if let date = item.publishedAt {
                                        Text(date.formatted(date: .abbreviated, time: .shortened))
                                            .font(.caption2)
                                            .foregroundStyle(.tertiary)
                                    }
                                }
                                .padding(.vertical, 2)
                            }
                        }
                    } header: {
                        Text("Latest Items (Preview)")
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Add Feed")
            #if !os(macOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { closeAddSheet() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { Task { await submitNewFeed() } }
                        .disabled(isSubmitting || newFeedURL.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 360)
        #endif
    }

    private func testNewFeed() async {
        let trimmed = newFeedURL.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        isTesting = true
        newFeedError = nil
        testResult = nil
        defer { isTesting = false }
        do {
            let result = try await appState.apiClient.testRSSFeed(url: trimmed)
            await MainActor.run { testResult = result }
        } catch {
            await MainActor.run { newFeedError = error.localizedDescription }
        }
    }

    private func closeAddSheet() {
        isAdding = false
        newFeedURL = ""
        newFeedError = nil
        testResult = nil
    }

    private func submitNewFeed() async {
        let trimmed = newFeedURL.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            let added = try await appState.apiClient.addRSSFeed(url: trimmed)
            await MainActor.run {
                if !feeds.contains(where: { $0.id == added.id }) {
                    feeds.append(added)
                    feeds.sort { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
                }
                closeAddSheet()
            }
        } catch {
            await MainActor.run {
                newFeedError = error.localizedDescription
            }
        }
    }

    // MARK: - List ops

    private func reload() async {
        isLoading = true
        loadError = nil
        defer { isLoading = false }
        do {
            let result = try await appState.apiClient.listRSSFeeds()
            feeds = result.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
            if let cfg = appState.config { rssEnabled = cfg.rssEnabled }
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func setEnabled(_ id: Int, _ enabled: Bool) async {
        do {
            let updated = try await appState.apiClient.updateRSSFeed(id: id, enabled: enabled)
            await MainActor.run {
                if let idx = feeds.firstIndex(where: { $0.id == id }) {
                    feeds[idx] = updated
                }
            }
        } catch {
            // Revert by reloading
            await reload()
        }
    }

    private func delete(_ id: Int) async {
        do {
            try await appState.apiClient.deleteRSSFeed(id: id)
            await MainActor.run {
                feeds.removeAll { $0.id == id }
            }
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func saveEnabled(_ value: Bool) async {
        guard !savingEnabled else { return }
        savingEnabled = true
        defer { savingEnabled = false }
        do {
            try await appState.saveConfig(["rss_enabled": value])
        } catch {
            // Revert local toggle if the save failed.
            if let cfg = appState.config { rssEnabled = cfg.rssEnabled }
        }
    }

    // MARK: - OPML import

    #if !os(macOS)
    private func handleImporterResult(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }
            Task { await importOPML(from: url) }
        case .failure(let err):
            importMessage = "Import failed: \(err.localizedDescription)"
        }
    }
    #endif

    private func importOPML(from url: URL) async {
        // For security-scoped resources (iOS file picker) we have to claim
        // access before reading the bytes off disk.
        let needsAccess = url.startAccessingSecurityScopedResource()
        defer { if needsAccess { url.stopAccessingSecurityScopedResource() } }

        do {
            let data = try Data(contentsOf: url)
            let result = try await appState.apiClient.importOPML(data)
            importMessage = "Imported \(result.inserted) feed\(result.inserted == 1 ? "" : "s") (\(result.skipped) duplicate)."
            await reload()
        } catch {
            importMessage = "Import failed: \(error.localizedDescription)"
        }
    }
}

// MARK: - Feed row

private struct FeedRow: View {
    let feed: RSSFeed
    let onToggle: (Bool) -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(feed.title)
                    .font(.subheadline)
                    .fontWeight(.medium)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(feed.feedUrl)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            Toggle("", isOn: Binding(
                get: { feed.enabled },
                set: { onToggle($0) }
            ))
            .labelsHidden()
        }
    }
}

#if os(macOS)
import AppKit
import UniformTypeIdentifiers

/// Hosts an `NSOpenPanel` so the user can pick an OPML file. Presented inside
/// the Settings sheet flow on macOS.
private struct macOSImportPicker: View {
    var onPicked: (URL) -> Void

    var body: some View {
        VStack(spacing: 16) {
            Text("Choose an OPML file")
                .font(.headline)
            Button("Browse…") {
                let panel = NSOpenPanel()
                panel.allowsMultipleSelection = false
                panel.canChooseDirectories = false
                var types: [UTType] = [.xml, .text]
                if let opml = UTType(filenameExtension: "opml") {
                    types.append(opml)
                }
                panel.allowedContentTypes = types
                if panel.runModal() == .OK, let url = panel.url {
                    onPicked(url)
                }
            }
        }
        .padding(24)
    }
}
#endif
