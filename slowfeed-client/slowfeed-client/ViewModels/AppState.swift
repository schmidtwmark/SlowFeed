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

    // Sources
    var sources: [SourceInfo] = []

    // Loading states
    var isLoading = false
    var error: String?

    // Config
    var config: AppConfig?

    init() {
        // Restore saved state
        serverURL = UserDefaults.standard.string(forKey: "serverURL") ?? ""
        sessionId = UserDefaults.standard.string(forKey: "sessionId")

        if let sessionId {
            apiClient.setSession(sessionId)
        }

        setupServices()
    }

    // MARK: - Initialization

    func initialize() async {
        // If we have a saved server URL, try to connect
        if !serverURL.isEmpty {
            do {
                try apiClient.configure(serverURL: serverURL)

                // Check if we have a valid session
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

                // No valid session, go to authentication
                _ = try await authService.checkSetupStatus()
                await MainActor.run {
                    currentScreen = .authentication
                }
            } catch {
                // Server not reachable or invalid, show setup
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

        // Check if we can reach the server
        _ = try await authService.checkSetupStatus()

        await MainActor.run {
            currentScreen = .authentication
        }
    }

    // MARK: - Authentication

    func registerPasskey(name: String?) async throws {
        try await authService.registerPasskey(name: name)
        sessionId = apiClient.sessionId

        await MainActor.run {
            currentScreen = .main
        }
        await loadInitialData()
    }

    func loginWithPasskey() async throws {
        try await authService.authenticateWithPasskey()
        sessionId = apiClient.sessionId

        await MainActor.run {
            currentScreen = .main
        }
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

                // Load the first digest if available
                if !digests.isEmpty {
                    currentDigestIndex = 0
                }
            }

            // Load the current digest content
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

    func refreshDigests() async {
        do {
            let loadedDigests = try await apiClient.getDigests(source: selectedSource)
            await MainActor.run {
                digests = loadedDigests
            }
        } catch {
            await MainActor.run {
                self.error = error.localizedDescription
            }
        }
    }

    func loadDigest(id: String) async {
        await MainActor.run { isLoading = true }

        do {
            let digest = try await apiClient.getDigest(id: id)
            await MainActor.run {
                currentDigest = digest
                isLoading = false
            }

            // Mark as read
            try? await apiClient.markAsRead(digestId: id)

            // Update the digest in the list
            await MainActor.run {
                if let index = digests.firstIndex(where: { $0.id == id }) {
                    let existing = digests[index]
                    // Create new summary with readAt set
                    digests[index] = DigestSummary(
                        id: existing.id,
                        source: existing.source,
                        title: existing.title,
                        postCount: existing.postCount,
                        publishedAt: existing.publishedAt,
                        readAt: Date()
                    )
                }
            }
        } catch {
            await MainActor.run {
                self.error = error.localizedDescription
                isLoading = false
            }
        }
    }

    // MARK: - Navigation

    func selectSource(_ source: SourceType?) async {
        await MainActor.run {
            selectedSource = source
            currentDigestIndex = 0
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
        logger.info("Loading config from server...")
        do {
            let loadedConfig = try await apiClient.getConfig()
            logger.info("Config loaded successfully: blueskyEnabled=\(loadedConfig.blueskyEnabled), redditEnabled=\(loadedConfig.redditEnabled), youtubeEnabled=\(loadedConfig.youtubeEnabled), discordEnabled=\(loadedConfig.discordEnabled)")
            await MainActor.run {
                config = loadedConfig
            }
        } catch {
            logger.error("Failed to load config: \(error.localizedDescription)")
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
        await refreshDigests()
    }
}
