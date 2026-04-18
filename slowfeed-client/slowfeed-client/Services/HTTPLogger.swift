import Foundation
import os.log

@Observable
final class HTTPLogger {
    static let shared = HTTPLogger()

    /// `os.Logger` is thread-safe and safe to access across isolation domains;
    /// declaring it `nonisolated` here silences the Swift 6 isolation warning
    /// that fires when we log inside `Task.detached` below.
    nonisolated private static let logger = Logger(
        subsystem: "com.markschmidt.slowfeed-client",
        category: "HTTPLogger"
    )

    var entries: [HTTPLogEntry] = []
    var isEnabled: Bool {
        didSet { UserDefaults.standard.set(isEnabled, forKey: "httpLoggingEnabled") }
    }

    /// URL is Sendable and the computation has no actor-bound state, so we
    /// mark the accessor `nonisolated` and evaluate it lazily as a `static let`.
    /// This lets `Task.detached` read it without crossing an actor boundary.
    nonisolated private static let storageURL: URL = {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("com.markschmidt.slowfeed-client", isDirectory: true)
            .appendingPathComponent("http_logs.json")
    }()

    private init() {
        // Default to enabled if never set
        if UserDefaults.standard.object(forKey: "httpLoggingEnabled") == nil {
            isEnabled = true
        } else {
            isEnabled = UserDefaults.standard.bool(forKey: "httpLoggingEnabled")
        }
        loadFromDisk()
    }

    func log(
        method: String,
        url: URL,
        requestHeaders: [String: String],
        requestBody: Data?,
        responseStatus: Int,
        responseHeaders: [AnyHashable: Any],
        responseBody: Data?,
        duration: TimeInterval,
        error: String? = nil
    ) {
        let entry = HTTPLogEntry(
            id: UUID(),
            timestamp: Date(),
            method: method,
            url: url.absoluteString,
            requestHeaders: requestHeaders,
            requestBody: formatBody(requestBody),
            responseStatus: responseStatus,
            responseHeaders: formatHeaders(responseHeaders),
            responseBody: formatBody(responseBody),
            duration: duration,
            error: error
        )

        Task { @MainActor in
            entries.insert(entry, at: 0)
            // Keep max 200 entries
            if entries.count > 200 {
                entries = Array(entries.prefix(200))
            }
            saveToDisk()
        }

        Self.logger.debug("\(method) \(url.absoluteString) → \(responseStatus) (\(String(format: "%.0f", duration * 1000))ms)")
    }

    @MainActor
    func clear() {
        entries.removeAll()
        saveToDisk()
    }

    private func saveToDisk() {
        let entriesToSave = entries
        Task.detached(priority: .utility) {
            do {
                let encoder = JSONEncoder()
                encoder.dateEncodingStrategy = .iso8601
                let data = try encoder.encode(entriesToSave)
                let url = Self.storageURL
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try data.write(to: url, options: .atomic)
            } catch {
                Self.logger.error("Failed to save HTTP logs: \(error.localizedDescription)")
            }
        }
    }

    private func loadFromDisk() {
        let url = Self.storageURL
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        do {
            let data = try Data(contentsOf: url)
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            entries = try decoder.decode([HTTPLogEntry].self, from: data)
        } catch {
            Self.logger.error("Failed to load HTTP logs: \(error.localizedDescription)")
        }
    }

    private func formatBody(_ data: Data?) -> String? {
        guard let data, !data.isEmpty else { return nil }
        // Try pretty-printing JSON
        if let json = try? JSONSerialization.jsonObject(with: data),
           let pretty = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]),
           let string = String(data: pretty, encoding: .utf8) {
            return string
        }
        // Fall back to raw string
        return String(data: data, encoding: .utf8) ?? "(\(data.count) bytes, binary)"
    }

    private func formatHeaders(_ headers: [AnyHashable: Any]) -> [String: String] {
        var result: [String: String] = [:]
        for (key, value) in headers {
            result["\(key)"] = "\(value)"
        }
        return result
    }
}

struct HTTPLogEntry: Identifiable, Codable {
    let id: UUID
    let timestamp: Date
    let method: String
    let url: String
    let requestHeaders: [String: String]
    let requestBody: String?
    let responseStatus: Int
    let responseHeaders: [String: String]
    let responseBody: String?
    let duration: TimeInterval
    let error: String?

    var statusColor: String {
        switch responseStatus {
        case 200..<300: return "green"
        case 400..<500: return "orange"
        case 500...: return "red"
        default: return "gray"
        }
    }

    var isSuccess: Bool { (200..<300).contains(responseStatus) }
    var isError: Bool { responseStatus >= 400 || error != nil }
}
