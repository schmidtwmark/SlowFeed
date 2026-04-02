import Foundation
import os.log

private let logger = Logger(subsystem: "com.markschmidt.slowfeed-client", category: "APIClient")

enum APIError: LocalizedError {
    case invalidURL
    case noData
    case decodingError(Error)
    case serverError(String)
    case unauthorized
    case networkError(Error)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid server URL"
        case .noData:
            return "No data received from server"
        case .decodingError(let error):
            return "Failed to parse response: \(error.localizedDescription)"
        case .serverError(let message):
            return message
        case .unauthorized:
            return "Authentication required"
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        }
    }
}

@Observable
final class APIClient {
    private(set) var baseURL: URL?
    private(set) var sessionId: String?

    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let dateString = try container.decode(String.self)

            // Try ISO8601 with fractional seconds
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: dateString) {
                return date
            }

            // Try without fractional seconds
            formatter.formatOptions = [.withInternetDateTime]
            if let date = formatter.date(from: dateString) {
                return date
            }

            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid date format")
        }
        return decoder
    }()

    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    // MARK: - Configuration

    func configure(serverURL: String) throws {
        guard let url = URL(string: serverURL) else {
            throw APIError.invalidURL
        }
        self.baseURL = url
    }

    func setSession(_ sessionId: String?) {
        self.sessionId = sessionId
    }

    var isConfigured: Bool {
        baseURL != nil
    }

    var isAuthenticated: Bool {
        sessionId != nil
    }

    // MARK: - Generic Request

    private func request<T: Decodable>(
        _ endpoint: String,
        method: String = "GET",
        body: Data? = nil
    ) async throws -> T {
        guard let baseURL else {
            throw APIError.invalidURL
        }

        guard let url = URL(string: endpoint, relativeTo: baseURL) else {
            throw APIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if let sessionId {
            request.setValue(sessionId, forHTTPHeaderField: "X-Session-Id")
        }

        if let body {
            request.httpBody = body
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                throw APIError.networkError(NSError(domain: "Invalid response", code: 0))
            }

            if httpResponse.statusCode == 401 {
                throw APIError.unauthorized
            }

            if httpResponse.statusCode >= 400 {
                if let errorResponse = try? decoder.decode(ErrorResponse.self, from: data) {
                    throw APIError.serverError(errorResponse.error)
                }
                throw APIError.serverError("Server error: \(httpResponse.statusCode)")
            }

            do {
                return try decoder.decode(T.self, from: data)
            } catch {
                throw APIError.decodingError(error)
            }
        } catch let error as APIError {
            throw error
        } catch {
            throw APIError.networkError(error)
        }
    }

    private func requestVoid(
        _ endpoint: String,
        method: String = "GET",
        body: Data? = nil
    ) async throws {
        let _: SuccessResponse = try await request(endpoint, method: method, body: body)
    }

    // MARK: - Auth Endpoints

    func checkSetupStatus() async throws -> SetupStatus {
        try await request("/api/auth/setup-status")
    }

    func checkAuthStatus() async throws -> Bool {
        struct AuthStatus: Decodable {
            let authenticated: Bool
        }
        let status: AuthStatus = try await request("/api/auth/status")
        return status.authenticated
    }

    // MARK: - Digest Endpoints

    func getDigests(source: SourceType? = nil) async throws -> [DigestSummary] {
        var endpoint = "/api/digests"
        if let source {
            endpoint += "?source=\(source.rawValue)"
        }
        return try await request(endpoint)
    }

    func getDigest(id: String) async throws -> Digest {
        try await request("/api/digests/\(id)?format=json")
    }

    func markAsRead(digestId: String) async throws {
        try await requestVoid("/api/digests/\(digestId)/read", method: "POST")
    }

    func markAsUnread(digestId: String) async throws {
        try await requestVoid("/api/digests/\(digestId)/read", method: "DELETE")
    }

    // MARK: - Source Endpoints

    func getSources() async throws -> [SourceInfo] {
        try await request("/api/sources")
    }

    // MARK: - Config Endpoints

    func getConfig() async throws -> AppConfig {
        guard let baseURL else {
            throw APIError.invalidURL
        }

        guard let url = URL(string: "/api/config", relativeTo: baseURL) else {
            throw APIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if let sessionId {
            request.setValue(sessionId, forHTTPHeaderField: "X-Session-Id")
        }

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.networkError(NSError(domain: "Invalid response", code: 0))
        }

        if httpResponse.statusCode == 401 {
            throw APIError.unauthorized
        }

        if httpResponse.statusCode >= 400 {
            if let errorResponse = try? decoder.decode(ErrorResponse.self, from: data) {
                throw APIError.serverError(errorResponse.error)
            }
            throw APIError.serverError("Server error: \(httpResponse.statusCode)")
        }

        // Log the raw response for debugging
        if let jsonString = String(data: data, encoding: .utf8) {
            logger.debug("Config response: \(jsonString)")
        }

        do {
            return try decoder.decode(AppConfig.self, from: data)
        } catch {
            logger.error("Failed to decode config: \(error.localizedDescription)")
            throw APIError.decodingError(error)
        }
    }

    func updateConfig(_ updates: [String: Any]) async throws {
        let jsonData = try JSONSerialization.data(withJSONObject: updates)
        try await requestVoid("/api/config", method: "POST", body: jsonData)
    }

    // MARK: - Schedule Endpoints

    func getSchedules() async throws -> [PollSchedule] {
        try await request("/api/schedules")
    }

    // MARK: - Passkey Endpoints

    func getPasskeys() async throws -> [PasskeyCredential] {
        try await request("/api/passkeys")
    }

    func deletePasskey(id: String) async throws {
        try await requestVoid("/api/passkeys/\(id)", method: "DELETE")
    }

    func renamePasskey(id: String, name: String) async throws {
        let body = try encoder.encode(["name": name])
        try await requestVoid("/api/passkeys/\(id)", method: "PATCH", body: body)
    }

    // MARK: - Poll Endpoints

    func triggerPoll(source: SourceType? = nil) async throws {
        var endpoint = "/api/poll"
        if let source {
            endpoint += "?source=\(source.rawValue)"
        }
        try await requestVoid(endpoint, method: "POST")
    }

    // MARK: - Stats

    func getStats() async throws -> [String: Any] {
        // Return raw JSON for flexibility
        guard let baseURL else {
            throw APIError.invalidURL
        }

        guard let url = URL(string: "/api/stats", relativeTo: baseURL) else {
            throw APIError.invalidURL
        }

        var request = URLRequest(url: url)
        if let sessionId {
            request.setValue(sessionId, forHTTPHeaderField: "X-Session-Id")
        }

        let (data, _) = try await URLSession.shared.data(for: request)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw APIError.decodingError(NSError(domain: "Invalid JSON", code: 0))
        }
        return json
    }
}
