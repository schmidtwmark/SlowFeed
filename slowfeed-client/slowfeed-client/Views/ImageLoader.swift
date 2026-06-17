import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Shared image loader that owns its downloads independently of any view's
/// lifecycle.
///
/// The previous loader ran `URLSession.data` directly inside each
/// `CachedImage`'s `.task`. In a long thread that mounts many images at
/// once, SwiftUI cancels/re-evaluates those tasks freely; the cancelled
/// `URLSession` call threw, the view caught it and latched `failed = true`,
/// and since `.task(id: url)` only re-runs when the URL changes, the image
/// stayed broken forever (the first image, already loaded, survived — hence
/// "only the first loads").
///
/// Here the actual fetch is an unstructured `Task` owned by this actor, so a
/// view scrolling away or re-rendering can't cancel it. Requests are deduped
/// by URL and capped at `maxConcurrent` so a 25-image thread doesn't fire 25
/// simultaneous CDN requests.
actor ImageLoader {
    static let shared = ImageLoader()

    private let maxConcurrent = 5
    private var activeCount = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var inFlight: [URL: Task<PlatformImage?, Never>] = [:]

    /// Returns the image for `url`, hitting the in-memory cache first, then
    /// joining an in-flight download, then starting a new one. Returns nil
    /// on a real failure (the caller just keeps showing its placeholder —
    /// there is no permanent failed state, so a later re-request retries).
    func image(for url: URL) async -> PlatformImage? {
        if let cached = await ImageCache.shared.image(for: url) { return cached }
        if let existing = inFlight[url] { return await existing.value }

        let task = Task<PlatformImage?, Never> { [weak self] in
            guard let self else { return nil }
            await self.acquireSlot()
            defer { Task { await self.releaseSlot() } }
            do {
                var request = URLRequest(url: url)
                request.timeoutInterval = 30
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse,
                      (200..<300).contains(http.statusCode),
                      let image = PlatformImage(data: data) else {
                    return nil
                }
                await ImageCache.shared.store(image, for: url)
                return image
            } catch {
                return nil
            }
        }
        inFlight[url] = task
        let result = await task.value
        inFlight[url] = nil
        return result
    }

    /// Simple async semaphore: take a slot if one's free, else suspend until
    /// `releaseSlot()` hands one over.
    private func acquireSlot() async {
        if activeCount < maxConcurrent {
            activeCount += 1
        } else {
            await withCheckedContinuation { waiters.append($0) }
            // Resumed by releaseSlot(), which hands its slot directly to us —
            // activeCount already accounts for it.
        }
    }

    private func releaseSlot() {
        if waiters.isEmpty {
            activeCount -= 1
        } else {
            // Pass the slot straight to the next waiter; activeCount unchanged.
            waiters.removeFirst().resume()
        }
    }
}
