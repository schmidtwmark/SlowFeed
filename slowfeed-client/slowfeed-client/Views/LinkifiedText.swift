import Foundation
import SwiftUI

/// Boxes an `AttributedString` so it can live in an `NSCache` (which only
/// holds class instances). Nonisolated (the project defaults to MainActor
/// isolation) so the off-main cache-warming path can construct it; immutable
/// after init, hence Sendable.
private nonisolated final class LinkifiedBox: Sendable {
    let value: AttributedString
    init(_ value: AttributedString) { self.value = value }
}

extension String {
    /// One shared detector. Constructing `NSDataDetector` is itself expensive,
    /// and the old code built a new one on every call.
    ///
    /// `nonisolated`: the project defaults every declaration to MainActor
    /// isolation, but this machinery must be callable from the detached
    /// cache-warming task (that's its whole purpose). `NSDataDetector` is
    /// Sendable (immutable, thread-safe matching).
    private nonisolated static let linkDetector: NSDataDetector? =
        try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    /// Cache of computed results keyed by the source string. `NSDataDetector`
    /// scanning is costly and was running on every SwiftUI body evaluation
    /// (per post, per re-render) — the dominant main-thread cost while
    /// scrolling long Bluesky threads (confirmed in Instruments). Post text is
    /// immutable, so caching by content is safe. NSCache is thread-safe and
    /// self-evicting, so the cache can be warmed off the main thread.
    private nonisolated(unsafe) static let linkifyCache: NSCache<NSString, LinkifiedBox> = {
        let cache = NSCache<NSString, LinkifiedBox>()
        cache.countLimit = 4000
        return cache
    }()

    /// Returns an `AttributedString` with detected URLs marked as tappable
    /// links. Cheap on repeat calls (cache hit) — safe to call from a view
    /// body.
    nonisolated func linkified() -> AttributedString {
        let key = self as NSString
        if let cached = String.linkifyCache.object(forKey: key) {
            return cached.value
        }
        let result = String.computeLinkified(self)
        String.linkifyCache.setObject(LinkifiedBox(result), forKey: key)
        return result
    }

    /// Pre-compute and cache results for a batch of strings off the main
    /// thread (e.g. every post in a digest right after it loads), so the first
    /// render is cache hits instead of running the detector inline during
    /// layout.
    nonisolated static func warmLinkifyCache(_ strings: [String]) {
        for string in strings where !string.isEmpty {
            let key = string as NSString
            if linkifyCache.object(forKey: key) != nil { continue }
            linkifyCache.setObject(LinkifiedBox(computeLinkified(string)), forKey: key)
        }
    }

    private nonisolated static func computeLinkified(_ string: String) -> AttributedString {
        var attributed = AttributedString(string)
        guard !string.isEmpty, let detector = linkDetector else { return attributed }
        // A link needs a "." (domain) or ":" (scheme) somewhere — skip the
        // expensive scan for the many posts that have neither.
        guard string.contains(".") || string.contains(":") else { return attributed }

        let ns = string as NSString
        let matches = detector.matches(in: string, options: [],
                                       range: NSRange(location: 0, length: ns.length))
        for match in matches {
            guard let url = match.url,
                  let range = Range(match.range, in: string),
                  let attrRange = Range(range, in: attributed) else { continue }
            attributed[attrRange].link = url
        }
        return attributed
    }
}
