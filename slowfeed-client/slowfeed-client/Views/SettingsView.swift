import SwiftUI

#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct SettingsView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        #if os(macOS)
        TabView {
            GeneralSettingsView()
                .tabItem {
                    Label("General", systemImage: "gear")
                }

            SourceSettingsView(source: .reddit)
                .tabItem {
                    Label("Reddit", systemImage: "bubble.left.and.bubble.right")
                }

            SourceSettingsView(source: .bluesky)
                .tabItem {
                    Label("Bluesky", systemImage: "cloud")
                }

            SourceSettingsView(source: .youtube)
                .tabItem {
                    Label("YouTube", systemImage: "play.rectangle")
                }

            SourceSettingsView(source: .discord)
                .tabItem {
                    Label("Discord", systemImage: "message")
                }

            PasskeySettingsView()
                .tabItem {
                    Label("Passkeys", systemImage: "key")
                }

            AccountSettingsView()
                .tabItem {
                    Label("Account", systemImage: "person")
                }
        }
        .frame(width: 500, height: 400)
        .task {
            await appState.loadConfig()
        }
        #else
        NavigationStack {
            List {
                Section {
                    NavigationLink {
                        GeneralSettingsView()
                    } label: {
                        Label("General", systemImage: "gear")
                    }
                }

                Section("Sources") {
                    NavigationLink {
                        SourceSettingsView(source: .reddit)
                    } label: {
                        Label("Reddit", systemImage: "bubble.left.and.bubble.right")
                    }

                    NavigationLink {
                        SourceSettingsView(source: .bluesky)
                    } label: {
                        Label("Bluesky", systemImage: "cloud")
                    }

                    NavigationLink {
                        SourceSettingsView(source: .youtube)
                    } label: {
                        Label("YouTube", systemImage: "play.rectangle")
                    }

                    NavigationLink {
                        SourceSettingsView(source: .discord)
                    } label: {
                        Label("Discord", systemImage: "message")
                    }
                }

                Section {
                    NavigationLink {
                        PasskeySettingsView()
                    } label: {
                        Label("Passkeys", systemImage: "key")
                    }

                    NavigationLink {
                        AccountSettingsView()
                    } label: {
                        Label("Account", systemImage: "person")
                    }
                }
            }
            .navigationTitle("Settings")
            .task {
                await appState.loadConfig()
            }
        }
        #endif
    }
}

// MARK: - General Settings

struct GeneralSettingsView: View {
    @Environment(AppState.self) private var appState

    @State private var feedTitle = ""
    @State private var feedTtlDays = 14
    @State private var feedToken = ""
    @State private var isSaving = false
    @State private var message: String?
    @State private var hasLoaded = false

    var body: some View {
        Form {
            if appState.config == nil {
                Section {
                    ProgressView("Loading configuration...")
                }
            } else {
                Section {
                    TextField("Feed Title", text: $feedTitle)

                    Stepper("Feed TTL: \(feedTtlDays) days", value: $feedTtlDays, in: 1...90)
                } header: {
                    Text("Feed Settings")
                }

                Section {
                    HStack {
                        TextField("Token", text: .constant(feedToken))
                            .textSelection(.enabled)
                            #if os(macOS)
                            .textFieldStyle(.plain)
                            #endif

                        Button("Copy") {
                            #if os(macOS)
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(feedToken, forType: .string)
                            #else
                            UIPasteboard.general.string = feedToken
                            #endif
                        }
                    }

                    Text("Add ?token=\(feedToken) to your feed URLs")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } header: {
                    Text("Feed Token")
                }

                Section {
                    Button("Save") {
                        save()
                    }
                    .disabled(isSaving)

                    if let message {
                        Text(message)
                            .foregroundStyle(message.contains("Error") ? .red : .green)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("General")
        .onChange(of: appState.config) { _, newConfig in
            if newConfig != nil && !hasLoaded {
                loadConfig()
                hasLoaded = true
            }
        }
        .onAppear {
            if appState.config != nil {
                loadConfig()
                hasLoaded = true
            }
        }
    }

    private func loadConfig() {
        guard let config = appState.config else { return }
        feedTitle = config.feedTitle
        feedTtlDays = config.feedTtlDays
        feedToken = config.feedToken
    }

    private func save() {
        isSaving = true
        message = nil

        Task {
            do {
                try await appState.saveConfig([
                    "feed_title": feedTitle,
                    "feed_ttl_days": feedTtlDays
                ])
                await MainActor.run {
                    message = "Saved!"
                    isSaving = false
                }
            } catch {
                await MainActor.run {
                    message = "Error: \(error.localizedDescription)"
                    isSaving = false
                }
            }
        }
    }
}

// MARK: - Source Settings

struct SourceSettingsView: View {
    let source: SourceType

    @Environment(AppState.self) private var appState

    @State private var enabled = false
    @State private var topN = 20
    @State private var handle = ""
    @State private var appPassword = ""
    @State private var cookies = ""
    @State private var includeComments = false
    @State private var commentDepth = 3
    @State private var isSaving = false
    @State private var message: String?
    @State private var hasLoaded = false

    var body: some View {
        Form {
            if appState.config == nil {
                Section {
                    ProgressView("Loading configuration...")
                }
            } else {
                Section {
                    Toggle("Enabled", isOn: $enabled)
                }

                switch source {
                case .reddit:
                    redditSettings
                case .bluesky:
                    blueskySettings
                case .youtube:
                    youtubeSettings
                case .discord:
                    discordSettings
                }

                Section {
                    Button("Save") {
                        save()
                    }
                    .disabled(isSaving)

                    if let message {
                        Text(message)
                            .foregroundStyle(message.contains("Error") ? .red : .green)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(source.displayName)
        .onChange(of: appState.config) { _, newConfig in
            if newConfig != nil && !hasLoaded {
                loadConfig()
                hasLoaded = true
            }
        }
        .onAppear {
            if appState.config != nil {
                loadConfig()
                hasLoaded = true
            }
        }
    }

    @ViewBuilder
    private var redditSettings: some View {
        Section {
            Stepper("Top posts: \(topN)", value: $topN, in: 5...100, step: 5)

            Toggle("Include comments", isOn: $includeComments)

            if includeComments {
                Stepper("Comment depth: \(commentDepth)", value: $commentDepth, in: 1...10)
            }
        } header: {
            Text("Options")
        }

        Section {
            TextEditor(text: $cookies)
                .frame(minHeight: 100)

            Text("Paste your browser cookies for personalized feed")
                .font(.caption)
                .foregroundStyle(.secondary)
        } header: {
            Text("Cookies (Optional)")
        }
    }

    @ViewBuilder
    private var blueskySettings: some View {
        Section {
            TextField("Handle", text: $handle)
                .textContentType(.username)

            SecureField("App Password", text: $appPassword)

            Text("Generate an app password at bsky.app/settings/app-passwords")
                .font(.caption)
                .foregroundStyle(.secondary)
        } header: {
            Text("Authentication")
        }

        Section {
            Stepper("Top posts: \(topN)", value: $topN, in: 5...100, step: 5)
        } header: {
            Text("Options")
        }
    }

    @ViewBuilder
    private var youtubeSettings: some View {
        Section {
            TextEditor(text: $cookies)
                .frame(minHeight: 100)

            Text("Paste your YouTube browser cookies")
                .font(.caption)
                .foregroundStyle(.secondary)
        } header: {
            Text("Cookies")
        }
    }

    @ViewBuilder
    private var discordSettings: some View {
        Section {
            SecureField("Bot Token", text: $appPassword)
        } header: {
            Text("Authentication")
        }

        Section {
            Stepper("Messages per channel: \(topN)", value: $topN, in: 5...100, step: 5)
        } header: {
            Text("Options")
        }
    }

    private func loadConfig() {
        guard let config = appState.config else { return }

        switch source {
        case .reddit:
            enabled = config.redditEnabled
            topN = config.redditTopN
            cookies = config.redditCookies == "••••••••" ? "" : config.redditCookies
            includeComments = config.redditIncludeComments
            commentDepth = config.redditCommentDepth
        case .bluesky:
            enabled = config.blueskyEnabled
            handle = config.blueskyHandle
            appPassword = config.blueskyAppPassword == "••••••••" ? "" : config.blueskyAppPassword
            topN = config.blueskyTopN
        case .youtube:
            enabled = config.youtubeEnabled
            cookies = config.youtubeCookies == "••••••••" ? "" : config.youtubeCookies
        case .discord:
            enabled = config.discordEnabled
            appPassword = config.discordToken == "••••••••" ? "" : config.discordToken
            topN = config.discordTopN
        }
    }

    private func save() {
        isSaving = true
        message = nil

        var updates: [String: Any] = [:]

        switch source {
        case .reddit:
            updates["reddit_enabled"] = enabled
            updates["reddit_top_n"] = topN
            updates["reddit_include_comments"] = includeComments
            updates["reddit_comment_depth"] = commentDepth
            if !cookies.isEmpty {
                updates["reddit_cookies"] = cookies
            }
        case .bluesky:
            updates["bluesky_enabled"] = enabled
            updates["bluesky_handle"] = handle
            updates["bluesky_top_n"] = topN
            if !appPassword.isEmpty {
                updates["bluesky_app_password"] = appPassword
            }
        case .youtube:
            updates["youtube_enabled"] = enabled
            if !cookies.isEmpty {
                updates["youtube_cookies"] = cookies
            }
        case .discord:
            updates["discord_enabled"] = enabled
            updates["discord_top_n"] = topN
            if !appPassword.isEmpty {
                updates["discord_token"] = appPassword
            }
        }

        Task {
            do {
                try await appState.saveConfig(updates)
                await MainActor.run {
                    message = "Saved!"
                    isSaving = false
                }
            } catch {
                await MainActor.run {
                    message = "Error: \(error.localizedDescription)"
                    isSaving = false
                }
            }
        }
    }
}

// MARK: - Passkey Settings

struct PasskeySettingsView: View {
    @Environment(AppState.self) private var appState

    @State private var passkeys: [PasskeyCredential] = []
    @State private var isLoading = true
    @State private var newPasskeyName = ""
    @State private var isAddingPasskey = false

    var body: some View {
        Form {
            Section {
                if isLoading {
                    ProgressView()
                } else if passkeys.isEmpty {
                    Text("No passkeys registered")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(passkeys) { passkey in
                        PasskeyRow(passkey: passkey, canDelete: passkeys.count > 1) {
                            await loadPasskeys()
                        }
                    }
                }
            } header: {
                Text("Registered Passkeys")
            }

            Section {
                TextField("Passkey name (optional)", text: $newPasskeyName)

                Button {
                    addPasskey()
                } label: {
                    if isAddingPasskey {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text("Add Passkey")
                    }
                }
                .disabled(isAddingPasskey)
            } header: {
                Text("Add New Passkey")
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Passkeys")
        .task {
            await loadPasskeys()
        }
    }

    private func loadPasskeys() async {
        do {
            let loaded = try await appState.apiClient.getPasskeys()
            await MainActor.run {
                passkeys = loaded
                isLoading = false
            }
        } catch {
            await MainActor.run {
                isLoading = false
            }
        }
    }

    private func addPasskey() {
        isAddingPasskey = true

        Task {
            do {
                try await appState.registerPasskey(name: newPasskeyName.isEmpty ? nil : newPasskeyName)
                await MainActor.run {
                    newPasskeyName = ""
                    isAddingPasskey = false
                }
                await loadPasskeys()
            } catch {
                await MainActor.run {
                    isAddingPasskey = false
                }
            }
        }
    }
}

struct PasskeyRow: View {
    let passkey: PasskeyCredential
    let canDelete: Bool
    let onUpdate: () async -> Void

    @Environment(AppState.self) private var appState

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(passkey.name ?? "Unnamed Passkey")
                    .fontWeight(.medium)

                HStack(spacing: 8) {
                    Text(passkey.deviceType == "multiDevice" ? "Synced" : "This device")

                    if let lastUsed = passkey.lastUsedAt {
                        Text("Last used: \(lastUsed.formatted(date: .abbreviated, time: .omitted))")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Spacer()

            if canDelete {
                Button(role: .destructive) {
                    Task {
                        try? await appState.apiClient.deletePasskey(id: passkey.id)
                        await onUpdate()
                    }
                } label: {
                    Image(systemName: "trash")
                }
            }
        }
    }
}

// MARK: - Account Settings

struct AccountSettingsView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        Form {
            Section {
                LabeledContent("Server") {
                    Text(appState.serverURL)
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                Button("Change Server") {
                    appState.currentScreen = .serverSetup
                }

                Button("Sign Out", role: .destructive) {
                    Task {
                        await appState.logout()
                    }
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Account")
    }
}

#Preview {
    SettingsView()
        .environment(AppState())
}
