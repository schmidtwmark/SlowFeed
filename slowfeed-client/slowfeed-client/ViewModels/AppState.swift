import Foundation
import SwiftUI
import os.log

private let logger = Logger(subsystem: "com.markschmidt.slowfeed-client", category: "AppState")

enum AppScreen {
    case serverSetup
    case authentication
    case main
}

@Observable
final class AppState {
    // Services
    let apiClient = APIClient()
    private(set) var authService: AuthService!

    private func setupServices() {
        if authService == nil {
            authService = AuthService(apiClient: apiClient)
        }
    }

    // Navigation state
    var currentScreen: AppScreen = .serverSetup

    // Server configuration
    var serverURL: String = "" {
        didSet {
            UserDefaults.standard.set(serverURL, forKey: "serverURL")
        }
    }

    // Session persistence
    var sessionId: String? {
        didSet {
            if let sessionId {
                UserDefaults.standard.set(sessionId, forKey: "sessionId")
            } else {
                UserDefaults.standard.removeObject(forKey: "sessionId")
            }
        }
    }

    // Digest state
    var digests: [DigestSummary] = []
    var currentDigest: Digest?
    var selectedSource: SourceType?
    var currentDigestIndex: Int = 0
    var expandedGroups: Set<String> = []
    var isRefreshing = false

    // Digest cache
    private var digestCache: [String: Digest] = [:]

    // Sources
    var sources: [SourceInfo] = []

    // Loading states
    var isLoading = false
    var error: String?

    // Config
    var config: AppConfig?

    init() {
        serverURL = UserDefaults.standard.string(forKey: "serverURL") ?? ""
        sessionId = UserDefaults.standard.string(forKey: "sessionId")

        if let sessionId {
            apiClient.setSession(sessionId)
        }

        setupServices()
    }

    // MARK: - Initialization

    func initialize() async {
        if !serverURL.isEmpty {
            do {
                try apiClient.configure(serverURL: serverURL)

                if sessionId != nil {
                    let isValid = try await authService.checkAuthStatus()
                    if isValid {
                        await MainActor.run {
                            currentScreen = .main
                        }
                        await loadInitialData()
                        return
                    }
                }

                _ = try await authService.checkSetupStatus()
                await MainActor.run {
                    currentScreen = .authentication
                }
            } catch {
                await MainActor.run {
                    currentScreen = .serverSetup
                }
            }
        }
    }

    // MARK: - Server Setup

    func connectToServer(url: String) async throws {
        try apiClient.configure(serverURL: url)
        serverURL = url
        _ = try await authService.checkSetupStatus()
        await MainActor.run {
            currentScreen = .authentication
        }
    }

    // MARK: - Authentication

    func registerPasskey(name: String?) async throws {
        try await authService.registerPasskey(name: name)
        sessionId = apiClient.sessionId
        await MainActor.run { currentScreen = .main }
        await loadInitialData()
    }

    func loginWithPasskey() async throws {
        try await authService.authenticateWithPasskey()
        sessionId = apiClient.sessionId
        await MainActor.run { currentScreen = .main }
        await loadInitialData()
    }

    func logout() async {
        try? await authService.logout()
        sessionId = nil
        await MainActor.run {
            currentScreen = .authentication
            digests = []
            currentDigest = nil
            sources = []
            config = nil
            digestCache = [:]
        }
    }

    // MARK: - Data Loading

    func loadInitialData() async {
        await MainActor.run { isLoading = true }

        do {
            async let digestsTask = apiClient.getDigests(source: selectedSource)
            async let sourcesTask = apiClient.getSources()

            let (loadedDigests, loadedSources) = try await (digestsTask, sourcesTask)

            await MainActor.run {
                digests = loadedDigests
                sources = loadedSources
                isLoading = false
                expandDigestGroups()
            }

            if let firstDigest = digests.first {
                await loadDigest(id: firstDigest.id)
            }
        } catch {
            await MainActor.run {
                self.error = error.localizedDescription
                isLoading = false
            }
        }
    }

    /// Refresh the digest list from the server (no poll triggered)
    func refreshDigests() async {
        await MainActor.run { isRefreshing = true }
        do {
            let loadedDigests = try await apiClient.getDigests(source: selectedSource)
            await MainActor.run {
                digests = loadedDigests
                expandDigestGroups()
                isRefreshing = false
            }
        } catch {
            await MainActor.run {
                self.error = error.localizedDescription
                isRefreshing = false
            }
        }
    }

    func loadDigest(id: String) async {
        // Return cached if available
        if let cached = digestCache[id] {
            await MainActor.run {
                currentDigest = cached
            }
            // Mark as read in background
            Task { try? await apiClient.markAsRead(digestId: id) }
            await markReadInList(id: id)
            return
        }

        await MainActor.run { isLoading = true }

        do {
            let digest = try await apiClient.getDigest(id: id)
            digestCache[id] = digest

            await MainActor.run {
                currentDigest = digest
                isLoading = false
            }

            Task { try? await apiClient.markAsRead(digestId: id) }
            await markReadInList(id: id)
        } catch {
            await MainActor.run {
                self.error = error.localizedDescription
                isLoading = false
            }
        }
    }

    private func markReadInList(id: String) async {
        await MainActor.run {
            if let index = digests.firstIndex(where: { $0.id == id }), !digests[index].isRead {
                let existing = digests[index]
                digests[index] = DigestSummary(
                    id: existing.id,
                    source: existing.source,
                    title: existing.title,
                    postCount: existing.postCount,
                    pollRunId: existing.pollRunId,
                    publishedAt: existing.publishedAt,
                    readAt: Date()
                )
            }
        }
    }

    // MARK: - Navigation

    func selectSource(_ source: SourceType?) async {
        guard source != selectedSource else { return }
        await MainActor.run {
            selectedSource = source
            currentDigest = nil
        }
        await refreshDigests()

        if let firstDigest = digests.first {
            await loadDigest(id: firstDigest.id)
        }
    }

    func navigateToDigest(at index: Int) async {
        guard index >= 0 && index < digests.count else { return }

        await MainActor.run {
            currentDigestIndex = index
        }

        await loadDigest(id: digests[index].id)
    }

    func navigateToPreviousDigest() async {
        await navigateToDigest(at: currentDigestIndex + 1)
    }

    func navigateToNextDigest() async {
        await navigateToDigest(at: currentDigestIndex - 1)
    }

    var canNavigatePrevious: Bool {
        currentDigestIndex < digests.count - 1
    }

    var canNavigateNext: Bool {
        currentDigestIndex > 0
    }

    // MARK: - Config

    func loadConfig() async {
        do {
            let loadedConfig = try await apiClient.getConfig()
            await MainActor.run {
                config = loadedConfig
            }
        } catch {
            await MainActor.run {
                self.error = error.localizedDescription
            }
        }
    }

    func saveConfig(_ updates: [String: Any]) async throws {
        try await apiClient.updateConfig(updates)
        await loadConfig()
    }

    // MARK: - Polling

    func triggerPoll(source: SourceType? = nil) async throws {
        try await apiClient.triggerPoll(source: source)
        digestCache = [:] // Clear cache since new digests were created
        await refreshDigests()
    }

    // MARK: - Sidebar Groups

    func expandDigestGroups() {
        let calendar = Calendar.current
        for digest in digests {
            let groupKey: String
            if let pollRunId = digest.pollRunId {
                groupKey = "run_\(pollRunId)"
            } else {
                let components = calendar.dateComponents([.year, .month, .day, .hour], from: digest.publishedAt)
                groupKey = "time_\(components.year!)_\(components.month!)_\(components.day!)_\(components.hour!)"
            }
            expandedGroups.insert(groupKey)
        }
    }
}
