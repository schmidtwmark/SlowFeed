import SwiftUI

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

            ScheduleSettingsView()
                .tabItem {
                    Label("Schedules", systemImage: "calendar.badge.clock")
                }

            ServerLogsView()
                .tabItem {
                    Label("Logs", systemImage: "doc.text")
                }

            PasskeySettingsView()
                .tabItem {
                    Label("Passkeys", systemImage: "key")
                }

            AccountSettingsView()
                .tabItem {
                    Label("Account", systemImage: "person")
                }

            AppSettingsView()
                .tabItem {
                    Label("App", systemImage: "wrench")
                }
        }
        .frame(width: 550, height: 450)
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

                Section("Server") {
                    NavigationLink {
                        ScheduleSettingsView()
                    } label: {
                        Label("Schedules", systemImage: "calendar.badge.clock")
                    }

                    NavigationLink {
                        ServerLogsView()
                    } label: {
                        Label("Server Logs", systemImage: "doc.text")
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

                Section {
                    NavigationLink {
                        AppSettingsView()
                    } label: {
                        Label("App", systemImage: "wrench")
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

    @State private var digestRetentionDays = 14
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
                    Stepper("Keep digests for \(digestRetentionDays) days", value: $digestRetentionDays, in: 1...90)
                } header: {
                    Text("Digest Retention")
                } footer: {
                    Text("Digests older than this are automatically deleted.")
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
        digestRetentionDays = config.feedTtlDays
    }

    private func save() {
        isSaving = true
        message = nil

        Task {
            do {
                try await appState.saveConfig([
                    "feed_ttl_days": digestRetentionDays
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

// MARK: - App Settings

struct AppSettingsView: View {
    @State private var httpLogger = HTTPLogger.shared

    var body: some View {
        Form {
            Section {
                Toggle("Network Logging", isOn: $httpLogger.isEnabled)

                if httpLogger.isEnabled {
                    HStack {
                        Text("Logged requests")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text("\(httpLogger.entries.count)")
                            .foregroundStyle(.secondary)
                    }

                    Button("Clear Log", role: .destructive) {
                        httpLogger.clear()
                    }
                    .disabled(httpLogger.entries.isEmpty)
                }
            } header: {
                Text("Debugging")
            } footer: {
                Text("When enabled, all HTTP requests are logged and viewable in the Network tab. This may use additional memory.")
            }
        }
        .formStyle(.grouped)
        .navigationTitle("App Settings")
    }
}

// MARK: - Schedule Settings

struct ScheduleSettingsView: View {
    @Environment(AppState.self) private var appState

    @State private var schedules: [PollSchedule] = []
    @State private var isLoading = true
    @State private var editingSchedule: PollSchedule?
    @State private var isCreating = false
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                if isLoading {
                    ProgressView()
                } else if schedules.isEmpty {
                    Text("No schedules configured")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(schedules) { schedule in
                        ScheduleRow(schedule: schedule, onEdit: {
                            editingSchedule = schedule
                        }, onRun: {
                            await runSchedule(schedule)
                        }, onDelete: {
                            await deleteSchedule(schedule)
                        })
                    }
                }
            } header: {
                Text("Poll Schedules")
            }

            if let error {
                Section {
                    Text(error)
                        .foregroundStyle(.red)
                }
            }

            Section {
                Button("New Schedule") {
                    isCreating = true
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Schedules")
        .task {
            await loadSchedules()
        }
        .sheet(isPresented: $isCreating) {
            ScheduleEditorView(schedule: nil) {
                await loadSchedules()
            }
        }
        .sheet(item: $editingSchedule) { schedule in
            ScheduleEditorView(schedule: schedule) {
                await loadSchedules()
            }
        }
    }

    private func loadSchedules() async {
        do {
            let loaded = try await appState.apiClient.getSchedules()
            await MainActor.run {
                schedules = loaded
                isLoading = false
                error = nil
            }
        } catch {
            await MainActor.run {
                self.error = error.localizedDescription
                isLoading = false
            }
        }
    }

    private func runSchedule(_ schedule: PollSchedule) async {
        do {
            try await appState.apiClient.runSchedule(id: schedule.id)
        } catch {
            await MainActor.run {
                self.error = error.localizedDescription
            }
        }
    }

    private func deleteSchedule(_ schedule: PollSchedule) async {
        do {
            try await appState.apiClient.deleteSchedule(id: schedule.id)
            await loadSchedules()
        } catch {
            await MainActor.run {
                self.error = error.localizedDescription
            }
        }
    }
}

struct ScheduleRow: View {
    let schedule: PollSchedule
    let onEdit: () -> Void
    let onRun: () async -> Void
    let onDelete: () async -> Void

    @State private var isRunning = false

    private static let dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(schedule.name)
                    .fontWeight(.medium)

                Spacer()

                if schedule.enabled {
                    Text("Active")
                        .font(.caption)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.green.opacity(0.2))
                        .foregroundStyle(.green)
                        .clipShape(Capsule())
                } else {
                    Text("Disabled")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            HStack(spacing: 4) {
                Text(schedule.daysOfWeek.sorted().map { Self.dayNames[$0] }.joined(separator: ", "))
                Text("at \(schedule.timeOfDay)")
                Text("(\(schedule.timezone))")
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            HStack(spacing: 4) {
                Text("Sources:")
                Text(schedule.sources.map(\.displayName).joined(separator: ", "))
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            HStack(spacing: 12) {
                Button("Edit") { onEdit() }
                    .buttonStyle(.borderless)

                Button {
                    isRunning = true
                    Task {
                        await onRun()
                        isRunning = false
                    }
                } label: {
                    if isRunning {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text("Run Now")
                    }
                }
                .buttonStyle(.borderless)
                .disabled(isRunning)

                Button("Delete", role: .destructive) {
                    Task { await onDelete() }
                }
                .buttonStyle(.borderless)
            }
            .font(.caption)
            .padding(.top, 2)
        }
        .padding(.vertical, 4)
    }
}

struct ScheduleEditorView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    let schedule: PollSchedule?
    let onSave: () async -> Void

    @State private var name = ""
    @State private var timeOfDay = "08:00"
    @State private var timezone = TimeZone.current.identifier
    @State private var selectedDays: Set<Int> = [1, 2, 3, 4, 5] // Mon-Fri
    @State private var selectedSources: Set<SourceType> = [.reddit, .bluesky]
    @State private var enabled = true
    @State private var isSaving = false
    @State private var error: String?

    private static let dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                    TextField("Time (HH:MM)", text: $timeOfDay)
                    TextField("Timezone", text: $timezone)
                    Toggle("Enabled", isOn: $enabled)
                }

                Section("Days") {
                    ForEach(0..<7, id: \.self) { day in
                        Toggle(Self.dayNames[day], isOn: Binding(
                            get: { selectedDays.contains(day) },
                            set: { isOn in
                                if isOn { selectedDays.insert(day) }
                                else { selectedDays.remove(day) }
                            }
                        ))
                    }
                }

                Section("Sources") {
                    ForEach(SourceType.allCases) { source in
                        Toggle(source.displayName, isOn: Binding(
                            get: { selectedSources.contains(source) },
                            set: { isOn in
                                if isOn { selectedSources.insert(source) }
                                else { selectedSources.remove(source) }
                            }
                        ))
                    }
                }

                if let error {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(schedule == nil ? "New Schedule" : "Edit Schedule")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(isSaving || name.isEmpty)
                }
            }
        }
        .onAppear {
            if let schedule {
                name = schedule.name
                timeOfDay = schedule.timeOfDay
                timezone = schedule.timezone
                selectedDays = Set(schedule.daysOfWeek)
                selectedSources = Set(schedule.sources)
                enabled = schedule.enabled
            }
        }
        #if os(macOS)
        .frame(minWidth: 400, minHeight: 500)
        #endif
    }

    private func save() {
        isSaving = true
        error = nil

        let input = ScheduleInput(
            name: name,
            days_of_week: selectedDays.sorted(),
            time_of_day: timeOfDay,
            timezone: timezone,
            sources: selectedSources.sorted { $0.rawValue < $1.rawValue },
            enabled: enabled
        )

        Task {
            do {
                if let schedule {
                    _ = try await appState.apiClient.updateSchedule(id: schedule.id, input)
                } else {
                    _ = try await appState.apiClient.createSchedule(input)
                }
                await onSave()
                await MainActor.run { dismiss() }
            } catch {
                await MainActor.run {
                    self.error = error.localizedDescription
                    isSaving = false
                }
            }
        }
    }
}

// MARK: - Server Logs

struct ServerLogsView: View {
    @Environment(AppState.self) private var appState

    @State private var logs: [LogEntry] = []
    @State private var isLoading = true
    @State private var autoRefresh = true

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Toggle("Auto-refresh", isOn: $autoRefresh)
                    .toggleStyle(.switch)
                    .controlSize(.small)

                Spacer()

                Button("Clear") {
                    Task {
                        try? await appState.apiClient.clearLogs()
                        await loadLogs()
                    }
                }
                .disabled(logs.isEmpty)

                Button {
                    Task { await loadLogs() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 8)

            Divider()

            if isLoading {
                Spacer()
                ProgressView()
                Spacer()
            } else if logs.isEmpty {
                Spacer()
                Text("No logs")
                    .foregroundStyle(.secondary)
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(logs) { entry in
                            LogEntryRow(entry: entry)
                        }
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 4)
                }
                .font(.system(.caption, design: .monospaced))
            }
        }
        .navigationTitle("Server Logs")
        .task {
            await loadLogs()
        }
        .task(id: autoRefresh) {
            guard autoRefresh else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled else { return }
                await loadLogs()
            }
        }
    }

    private func loadLogs() async {
        do {
            let loaded = try await appState.apiClient.getLogs(limit: 200)
            await MainActor.run {
                logs = loaded
                isLoading = false
            }
        } catch {
            await MainActor.run {
                isLoading = false
            }
        }
    }
}

struct LogEntryRow: View {
    let entry: LogEntry

    private var levelColor: Color {
        switch entry.level.lowercased() {
        case "error": return .red
        case "warn": return .orange
        case "info": return .blue
        case "debug": return .secondary
        default: return .primary
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Text(entry.level.uppercased())
                .foregroundStyle(levelColor)
                .frame(width: 44, alignment: .leading)

            Text(formatTimestamp(entry.timestamp))
                .foregroundStyle(.secondary)
                .frame(width: 70, alignment: .leading)

            Text(entry.message)
                .foregroundStyle(.primary)
                .textSelection(.enabled)
        }
        .padding(.vertical, 1)
    }

    private func formatTimestamp(_ ts: String) -> String {
        // Show just HH:MM:SS from ISO timestamp
        if let tIndex = ts.firstIndex(of: "T"),
           let dotIndex = ts.firstIndex(of: ".") ?? ts.firstIndex(of: "Z") {
            return String(ts[ts.index(after: tIndex)..<dotIndex])
        }
        return ts
    }
}

#Preview {
    SettingsView()
        .environment(AppState())
}
