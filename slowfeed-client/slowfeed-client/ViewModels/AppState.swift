import Foundation
import SwiftUI
import os.log

private let logger = Logger(subsystem: "com.markschmidt.slowfeed-client", category: "AppState")

enum AppScreen {
    case serverSetup
    case authentication
    case main
}

enum KeyboardFocusPane {
    case digests
    case posts
}

/// Top-level tabs. Declared here (rather than nested in MainView) so any
/// screen can steer tab selection through AppState.
enum SlowfeedTab: String {
    case digests, search, saved, network, settings
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

    /// Which top-level tab is showing. Owned here rather than by MainView so
    /// other screens can steer navigation — tapping a search result has to
    /// bring the user back to the Digests tab to see where it landed.
    var selectedTab: SlowfeedTab = .digests

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

    /// When true, media on posts whose `metadata.nsfw == true` is rendered
    /// blurred with a tap-to-reveal overlay. Defaults to true. Stored in
    /// `UserDefaults` so it persists across launches.
    var blurNSFW: Bool = true {
        didSet {
            UserDefaults.standard.set(blurNSFW, forKey: "blurNSFW")
        }
    }

    /// Where post URLs open by default — the in-app SFSafariViewController
    /// (iOS only; macOS always opens Safari) or the system browser.
    /// `PostView`'s long-press menu always offers both options regardless
    /// of this setting.
    var browserPreference: BrowserPreference = .inApp {
        didSet {
            UserDefaults.standard.set(browserPreference.rawValue, forKey: "browserPreference")
        }
    }

    /// How the header image (first `<img>` from the RSS HTML) renders on
    /// each RSS post card — a compact thumbnail next to the title, or
    /// a full-width hero. User-configurable in App Settings.
    var rssImageStyle: RSSImageStyle = .full {
        didSet {
            UserDefaults.standard.set(rssImageStyle.rawValue, forKey: "rssImageStyle")
        }
    }

    /// One-shot "scroll to this post when the digest finishes loading"
    /// signal. Set by SearchView before calling `navigateToDigest` so
    /// that tapping a search result lands on the matching post inside
    /// the digest. Cleared by DigestView once it consumes it.
    var pendingScrollPostId: String?

    // Digest state
    var digests: [DigestSummary] = []
    var currentDigest: Digest?
    var selectedSource: SourceType?
    var currentDigestIndex: Int = 0
    var expandedGroups: Set<String> = []
    var isRefreshing = false

    // Keyboard navigation
    var keyboardFocusPane: KeyboardFocusPane = .posts
    var focusedPostId: String?

    /// Flat list of digest IDs in sidebar render order (groups by poll run, sorted by date desc, source asc within group).
    var renderedDigestIds: [String] {
        let calendar = Calendar.current
        var groups: [String: [DigestSummary]] = [:]
        var groupDates: [String: Date] = [:]

        for digest in digests {
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

        return groups.map { (key: $0.key, date: groupDates[$0.key] ?? Date(), digests: $0.value.sorted { $0.source.rawValue < $1.source.rawValue }) }
            .sorted { $0.date > $1.date }
            .flatMap { $0.digests.map(\.id) }
    }

    // Digest cache
    private var digestCache: [String: Digest] = [:]
    private var preloadTask: Task<Void, Never>?
    private var scrollPositionTask: Task<Void, Never>?

    // Saved posts
    var savedPostIds: Set<String> = []
    var savedPostGroups: [SavedPostGroup] = []

    // Sources
    var sources: [SourceInfo] = []

    // Loading states
    var isLoading = false
    var digestLoading = false
    var digestError: String?
    var error: String?

    // Config
    var config: AppConfig?

    init() {
        serverURL = UserDefaults.standard.string(forKey: "serverURL") ?? ""
        sessionId = UserDefaults.standard.string(forKey: "sessionId")
        // Default `blurNSFW` to true when never set; otherwise honor the saved value.
        if UserDefaults.standard.object(forKey: "blurNSFW") == nil {
            blurNSFW = true
        } else {
            blurNSFW = UserDefaults.standard.bool(forKey: "blurNSFW")
        }

        if let raw = UserDefaults.standard.string(forKey: "browserPreference"),
           let pref = BrowserPreference(rawValue: raw) {
            browserPreference = pref
        }

        if let raw = UserDefaults.standard.string(forKey: "rssImageStyle"),
           let style = RSSImageStyle(rawValue: raw) {
            rssImageStyle = style
        }

        if let sessionId {
            apiClient.setSession(sessionId)
        }

        setupServices()

        apiClient.onUnauthorized = { [weak self] in
            guard let self, self.currentScreen == .main else { return }
            self.currentScreen = .authentication
            self.sessionId = nil
        }
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

            // Load saved post IDs in background
            Task { await loadSavedPostIds() }
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
                // Preserve local read state across refresh. Progress saves
                // are debounced fire-and-forget, so a refresh can race
                // ahead of the server — without this, a refresh issued
                // right after reading would resurrect digests as unread /
                // less-read and prevent groups from auto-collapsing.
                // Progress is monotonic, so keep the max of local vs server.
                let local: [String: (progress: Double, readAt: Date?)] =
                    Dictionary(uniqueKeysWithValues: digests.map { ($0.id, ($0.readProgress, $0.readAt)) })
                digests = loadedDigests.map { d in
                    guard let prev = local[d.id] else { return d }
                    let mergedProgress = max(d.readProgress, prev.progress)
                    let mergedReadAt = d.readAt ?? prev.readAt
                    if mergedProgress == d.readProgress && mergedReadAt == d.readAt { return d }
                    return d.withReadState(progress: mergedProgress, readAt: mergedReadAt)
                }
                digestCache = [:]
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
        // Opening a digest no longer marks it read — that now happens
        // when the user scrolls to the end (see recordReadProgress).
        // Return cached if available.
        if let cached = digestCache[id] {
            await MainActor.run {
                currentDigest = cached
                digestLoading = false
                digestError = nil
            }
            warmLinkifyCache(for: cached)
            preloadNearby()
            return
        }

        await MainActor.run {
            digestLoading = true
            digestError = nil
        }

        do {
            let digest = try await apiClient.getDigest(id: id)
            digestCache[id] = digest

            await MainActor.run {
                currentDigest = digest
                digestLoading = false
            }

            warmLinkifyCache(for: digest)
            preloadNearby()
        } catch {
            logger.error("Failed to load digest \(id): \(error.localizedDescription)")
            await MainActor.run {
                self.digestError = "\(error)"
                digestLoading = false
            }
        }
    }

    /// Pre-compute link detection for every text field in a digest off the
    /// main thread, so post views render from the linkify cache instead of
    /// running NSDataDetector inline during layout — a measured scroll-hang
    /// source on long threads. Strings are gathered on the main actor (cheap
    /// tree walk) and the expensive detection runs detached.
    private func warmLinkifyCache(for digest: Digest) {
        guard let posts = digest.posts else { return }
        var strings: [String] = []
        func collect(_ post: DigestPost) {
            if let c = post.content, !c.isEmpty { strings.append(c) }
            if let quoted = post.quotedPost { collect(quoted) }
            if let replies = post.replies { replies.forEach(collect) }
            if let comments = post.comments { for cm in comments { strings.append(cm.body) } }
        }
        posts.forEach(collect)
        guard !strings.isEmpty else { return }
        Task.detached(priority: .utility) {
            String.warmLinkifyCache(strings)
        }
    }

    /// Preload digests adjacent to the current index
    private func preloadNearby() {
        preloadTask?.cancel()
        preloadTask = Task {
            let indices = [
                currentDigestIndex - 1,
                currentDigestIndex + 1,
                currentDigestIndex - 2,
                currentDigestIndex + 2,
            ]
            for i in indices {
                guard !Task.isCancelled else { return }
                guard i >= 0 && i < digests.count else { continue }
                let digestId = digests[i].id
                if digestCache[digestId] != nil { continue }
                do {
                    let digest = try await apiClient.getDigest(id: digestId)
                    digestCache[digestId] = digest
                } catch {
                    logger.debug("Preload failed for \(digestId): \(error.localizedDescription)")
                }
            }
        }
    }

    // MARK: - Read Progress

    /// Furthest read fraction persisted to the server per digest, so the
    /// debounced PUT only fires on meaningful forward movement.
    @ObservationIgnored private var lastSavedReadProgress: [String: Double] = [:]
    @ObservationIgnored private var readProgressTask: Task<Void, Never>?
    /// Furthest read fraction observed *this session*, kept off the observed
    /// `digests` array so the cheap per-frame threshold check during scroll
    /// doesn't trigger any view updates.
    @ObservationIgnored private var liveReadProgress: [String: Double] = [:]

    /// Record how far through a digest the user has scrolled (0–1).
    ///
    /// This is called from `.onScrollGeometryChange`, i.e. many times per
    /// second while scrolling. Mutating the `@Observable digests` array here
    /// invalidates the whole sidebar (which sorts + groups every digest), so
    /// doing it per frame caused scroll stutter — only ever when scrolling
    /// *down*, since progress is monotonic. We therefore update the observed
    /// `digests` entry only when progress crosses a coarse 5% bucket or the
    /// digest becomes fully read; the per-frame work is just a dictionary
    /// write + comparison.
    @MainActor
    func recordReadProgress(digestId: String, progress: Double) {
        let clamped = min(max(progress, 0), 1)

        let prevLive = liveReadProgress[digestId] ?? 0
        let merged = max(prevLive, clamped)
        guard merged > prevLive else {
            // No forward movement (scrolling up / holding) — nothing to do.
            maybePersistReadProgress(digestId: digestId, clamped: clamped)
            return
        }
        liveReadProgress[digestId] = merged

        // Only touch the observed array on a 5% bucket boundary or completion.
        let crossedBucket = floor(merged * 20) > floor(prevLive * 20)
        let justCompleted = merged >= 0.999 && prevLive < 0.999
        if crossedBucket || justCompleted,
           let idx = digests.firstIndex(where: { $0.id == digestId }) {
            let existing = digests[idx]
            let newProgress = max(existing.readProgress, merged)
            let newReadAt = merged >= 0.999 ? (existing.readAt ?? Date()) : existing.readAt
            if newProgress > existing.readProgress + 0.0001 || newReadAt != existing.readAt {
                digests[idx] = existing.withReadState(progress: newProgress, readAt: newReadAt)
            }
        }

        maybePersistReadProgress(digestId: digestId, clamped: clamped)
    }

    /// Debounced server save of the furthest read fraction; coarse so it
    /// fires a handful of times per digest, not per frame.
    private func maybePersistReadProgress(digestId: String, clamped: Double) {
        let prior = lastSavedReadProgress[digestId] ?? 0
        guard clamped >= 1.0 || clamped > prior + 0.02 else { return }
        let toSave = max(prior, clamped)
        lastSavedReadProgress[digestId] = toSave

        readProgressTask?.cancel()
        readProgressTask = Task {
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled else { return }
            try? await apiClient.updateReadProgress(digestId: digestId, progress: toSave)
        }
    }

    // MARK: - Scroll Position

    /// Debounced save of scroll position to server
    func saveScrollPosition(digestId: String, postId: String) {
        scrollPositionTask?.cancel()
        scrollPositionTask = Task {
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            try? await apiClient.updateScrollPosition(digestId: digestId, postId: postId)
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

    func navigateToDigest(id: String) async {
        guard let idx = digests.firstIndex(where: { $0.id == id }) else { return }
        await navigateToDigest(at: idx)
    }

    /// All digests in the same poll-run group as the current digest,
    /// ordered by source name. Used by `SourceTabBar` to render one
    /// tab per sibling source at the bottom of the digest view on iOS.
    var siblingDigestsInGroup: [DigestSummary] {
        guard let currentId = currentDigest?.id,
              let current = digests.first(where: { $0.id == currentId }),
              let pollRunId = current.pollRunId else {
            return []
        }
        return digests
            .filter { $0.pollRunId == pollRunId }
            .sorted { $0.source.rawValue < $1.source.rawValue }
    }

    /// Sibling digests in the same poll-run group as the current digest,
    /// ordered by source name. Used by `DigestHeader`'s prev/next nav
    /// buttons so the user can jump between Reddit / Bluesky / etc.
    /// within the same poll without going back to the sidebar.
    var siblingDigests: (prev: DigestSummary?, next: DigestSummary?) {
        guard let currentId = currentDigest?.id,
              let currentSummary = digests.first(where: { $0.id == currentId }) else {
            return (nil, nil)
        }
        let pool: [DigestSummary]
        if let pollRunId = currentSummary.pollRunId {
            pool = digests
                .filter { $0.pollRunId == pollRunId }
                .sorted { $0.source.rawValue < $1.source.rawValue }
        } else {
            // Legacy / fallback: there's no group concept, so no siblings.
            return (nil, nil)
        }
        guard let idx = pool.firstIndex(where: { $0.id == currentId }) else {
            return (nil, nil)
        }
        let prev = idx > 0 ? pool[idx - 1] : nil
        let next = idx < pool.count - 1 ? pool[idx + 1] : nil
        return (prev, next)
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

    /// Navigate to the next digest in rendered (visual) order.
    func navigateToNextRenderedDigest() async {
        let order = renderedDigestIds
        guard let currentId = currentDigest?.id,
              let currentIdx = order.firstIndex(of: currentId),
              currentIdx + 1 < order.count else { return }
        let nextId = order[currentIdx + 1]
        if let flatIdx = digests.firstIndex(where: { $0.id == nextId }) {
            await navigateToDigest(at: flatIdx)
        }
    }

    /// Navigate to the previous digest in rendered (visual) order.
    func navigateToPreviousRenderedDigest() async {
        let order = renderedDigestIds
        guard let currentId = currentDigest?.id,
              let currentIdx = order.firstIndex(of: currentId),
              currentIdx > 0 else { return }
        let prevId = order[currentIdx - 1]
        if let flatIdx = digests.firstIndex(where: { $0.id == prevId }) {
            await navigateToDigest(at: flatIdx)
        }
    }

    /// Rendered digest group boundaries (list of first digest ID in each group, in rendered order).
    private var renderedGroupFirstIds: [String] {
        let calendar = Calendar.current
        var groups: [String: [DigestSummary]] = [:]
        var groupDates: [String: Date] = [:]

        for digest in digests {
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

        return groups.map { (key: $0.key, date: groupDates[$0.key] ?? Date(), digests: $0.value.sorted { $0.source.rawValue < $1.source.rawValue }) }
            .sorted { $0.date > $1.date }
            .compactMap { $0.digests.first?.id }
    }

    /// Navigate to the first digest of the next group in rendered order.
    func navigateToNextRenderedGroup() async {
        let groupStarts = renderedGroupFirstIds
        let order = renderedDigestIds
        guard let currentId = currentDigest?.id,
              let currentIdx = order.firstIndex(of: currentId) else { return }

        // Find the next group start that comes after the current position
        for startId in groupStarts {
            guard let startIdx = order.firstIndex(of: startId) else { continue }
            if startIdx > currentIdx {
                if let flatIdx = digests.firstIndex(where: { $0.id == startId }) {
                    await navigateToDigest(at: flatIdx)
                }
                return
            }
        }
    }

    /// Navigate to the first digest of the previous group in rendered order.
    func navigateToPreviousRenderedGroup() async {
        let groupStarts = renderedGroupFirstIds
        let order = renderedDigestIds
        guard let currentId = currentDigest?.id,
              let currentIdx = order.firstIndex(of: currentId) else { return }

        // Find the previous group start that comes before the current position
        for startId in groupStarts.reversed() {
            guard let startIdx = order.firstIndex(of: startId) else { continue }
            if startIdx < currentIdx {
                if let flatIdx = digests.firstIndex(where: { $0.id == startId }) {
                    await navigateToDigest(at: flatIdx)
                }
                return
            }
        }
    }

    // MARK: - Saved Posts

    func loadSavedPostIds() async {
        do {
            let ids = try await apiClient.getSavedPostIds()
            await MainActor.run { savedPostIds = ids }
        } catch {
            logger.error("Failed to load saved post IDs: \(error.localizedDescription)")
        }
    }

    func loadSavedPosts() async {
        do {
            let groups = try await apiClient.getSavedPosts()
            await MainActor.run { savedPostGroups = groups }
        } catch {
            logger.error("Failed to load saved posts: \(error.localizedDescription)")
            await MainActor.run { self.error = error.localizedDescription }
        }
    }

    func toggleSavePost(_ post: DigestPost, source: SourceType, digestId: String?) async {
        let postId = post.postId
        let wasSaved = savedPostIds.contains(postId)

        // Optimistic update
        await MainActor.run {
            if wasSaved {
                savedPostIds.remove(postId)
            } else {
                savedPostIds.insert(postId)
            }
        }

        do {
            if wasSaved {
                try await apiClient.unsavePost(postId: postId)
                // Remove from local groups
                await MainActor.run {
                    for i in savedPostGroups.indices {
                        savedPostGroups[i] = SavedPostGroup(
                            source: savedPostGroups[i].source,
                            posts: savedPostGroups[i].posts.filter { $0.postId != postId }
                        )
                    }
                    savedPostGroups.removeAll { $0.posts.isEmpty }
                }
            } else {
                try await apiClient.savePost(post, source: source, digestId: digestId)
            }
        } catch {
            // Revert optimistic update
            logger.error("Failed to \(wasSaved ? "unsave" : "save") post: \(error.localizedDescription)")
            await MainActor.run {
                if wasSaved {
                    savedPostIds.insert(postId)
                } else {
                    savedPostIds.remove(postId)
                }
            }
        }
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

    var isPolling = false
    var pollStatusMessage: String?

    func triggerPoll(source: SourceType? = nil) async throws {
        await MainActor.run {
            isPolling = true
            pollStatusMessage = "Starting poll..."
        }

        do {
            try await apiClient.triggerPoll(source: source)

            // Poll completed — the server endpoint blocks until done
            await MainActor.run {
                pollStatusMessage = "Loading new content..."
            }

            digestCache = [:] // Clear cache since new digests were created
            await refreshDigests()

            // Auto-select the first (newest) digest
            if !digests.isEmpty {
                await navigateToDigest(at: 0)
            }

            await MainActor.run {
                isPolling = false
                pollStatusMessage = nil
            }
        } catch {
            await MainActor.run {
                isPolling = false
                pollStatusMessage = nil
                self.error = error.localizedDescription
            }
            throw error
        }
    }

    // MARK: - Sidebar Groups

    /// Walk every digest, partition by sidebar group key, and update
    /// `expandedGroups` so that:
    ///   - groups with at least one unread digest are expanded
    ///   - groups where every digest is read are collapsed
    /// Called after `refreshDigests()` so the user's eye lands on what's new.
    func expandDigestGroups() {
        let calendar = Calendar.current
        // Per-group: true until proven otherwise that all member digests are read.
        var groupAllRead: [String: Bool] = [:]

        for digest in digests {
            let groupKey: String
            if let pollRunId = digest.pollRunId {
                groupKey = "run_\(pollRunId)"
            } else {
                let components = calendar.dateComponents([.year, .month, .day, .hour], from: digest.publishedAt)
                groupKey = "time_\(components.year!)_\(components.month!)_\(components.day!)_\(components.hour!)"
            }
            groupAllRead[groupKey] = (groupAllRead[groupKey] ?? true) && digest.isRead
        }

        // Build the new set first, then assign once. A single property write
        // (with animation) reliably nudges Section(isExpanded:) bindings to
        // re-read; piecewise insert/remove on the live Set sometimes does not.
        var newExpanded = expandedGroups
        for (groupKey, allRead) in groupAllRead {
            if allRead {
                newExpanded.remove(groupKey)
            } else {
                newExpanded.insert(groupKey)
            }
        }
        if newExpanded != expandedGroups {
            withAnimation { expandedGroups = newExpanded }
        }
    }
}
