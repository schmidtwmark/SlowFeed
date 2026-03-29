import AuthenticationServices
import Foundation
import os.log

#if os(macOS)
import AppKit
#else
import UIKit
#endif

private let logger = Logger(subsystem: "com.markschmidt.slowfeed-client", category: "AuthService")

enum AuthError: LocalizedError {
    case notConfigured
    case invalidChallenge
    case authenticationFailed(String)
    case registrationFailed(String)
    case cancelled

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Server not configured"
        case .invalidChallenge:
            return "Invalid authentication challenge"
        case .authenticationFailed(let message):
            return "Authentication failed: \(message)"
        case .registrationFailed(let message):
            return "Registration failed: \(message)"
        case .cancelled:
            return "Authentication cancelled"
        }
    }
}

@Observable
final class AuthService: NSObject {
    private let apiClient: APIClient

    private var authContinuation: CheckedContinuation<ASAuthorizationCredential, Error>?

    var isAuthenticated: Bool {
        apiClient.isAuthenticated
    }

    init(apiClient: APIClient) {
        self.apiClient = apiClient
        super.init()
    }

    // MARK: - Setup Status

    func checkSetupStatus() async throws -> Bool {
        let status = try await apiClient.checkSetupStatus()
        return status.setupComplete
    }

    func checkAuthStatus() async throws -> Bool {
        guard apiClient.sessionId != nil else { return false }
        return try await apiClient.checkAuthStatus()
    }

    // MARK: - Passkey Registration

    func registerPasskey(name: String?) async throws {
        guard let baseURL = apiClient.baseURL else {
            logger.error("Registration failed: server not configured")
            throw AuthError.notConfigured
        }

        logger.info("Starting passkey registration with server: \(baseURL.absoluteString)")

        // 1. Start registration on server
        let startResponse: RegistrationStartResponse
        do {
            startResponse = try await startRegistration()
            logger.info("Registration start response received, challengeId: \(startResponse.challengeId)")
        } catch {
            logger.error("Failed to start registration: \(error.localizedDescription)")
            throw error
        }

        // 2. Get RP ID from server URL
        let rpId = baseURL.host ?? "localhost"
        logger.info("Using RP ID: \(rpId)")

        // 3. Create platform key registration request
        let challenge = Data(base64URLEncoded: startResponse.options.challenge) ?? Data()
        let userIdData = Data(base64URLEncoded: startResponse.options.user.id) ?? Data()

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let registrationRequest = provider.createCredentialRegistrationRequest(
            challenge: challenge,
            name: startResponse.options.user.name,
            userID: userIdData
        )

        // 4. Perform the registration
        let credential: ASAuthorizationCredential
        do {
            credential = try await performAuthorization(with: registrationRequest)
            logger.info("Authorization completed successfully")
        } catch {
            logger.error("Authorization failed: \(String(describing: error))")
            throw error
        }

        guard let registration = credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration else {
            logger.error("Invalid credential type received")
            throw AuthError.registrationFailed("Invalid credential type")
        }

        // 5. Send response to server
        do {
            try await finishRegistration(
                challengeId: startResponse.challengeId,
                credential: registration,
                name: name
            )
            logger.info("Registration completed successfully")
        } catch {
            logger.error("Failed to finish registration: \(error.localizedDescription)")
            throw error
        }
    }

    // MARK: - Passkey Authentication

    func authenticateWithPasskey() async throws {
        guard let baseURL = apiClient.baseURL else {
            logger.error("Authentication failed: server not configured")
            throw AuthError.notConfigured
        }

        logger.info("Starting passkey authentication with server: \(baseURL.absoluteString)")

        // 1. Start authentication on server
        let startResponse: AuthenticationStartResponse
        do {
            startResponse = try await startAuthentication()
            logger.info("Authentication start response received, challengeId: \(startResponse.challengeId)")
        } catch {
            logger.error("Failed to start authentication: \(error.localizedDescription)")
            throw error
        }

        // 2. Get RP ID from server URL
        let rpId = baseURL.host ?? "localhost"
        logger.info("Using RP ID: \(rpId)")

        // 3. Create platform key assertion request
        let challenge = Data(base64URLEncoded: startResponse.options.challenge) ?? Data()

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let assertionRequest = provider.createCredentialAssertionRequest(challenge: challenge)

        // Add allowed credentials if provided
        if let allowCredentials = startResponse.options.allowCredentials {
            logger.info("Allowing \(allowCredentials.count) credentials")
            assertionRequest.allowedCredentials = allowCredentials.compactMap { cred in
                guard let credId = Data(base64URLEncoded: cred.id) else { return nil }
                return ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: credId)
            }
        }

        // 4. Perform the authentication
        let credential: ASAuthorizationCredential
        do {
            credential = try await performAuthorization(with: assertionRequest)
            logger.info("Authorization completed successfully")
        } catch {
            logger.error("Authorization failed: \(String(describing: error))")
            throw error
        }

        guard let assertion = credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            logger.error("Invalid credential type received")
            throw AuthError.authenticationFailed("Invalid credential type")
        }

        // 5. Send response to server
        do {
            try await finishAuthentication(
                challengeId: startResponse.challengeId,
                credential: assertion
            )
            logger.info("Authentication completed successfully")
        } catch {
            logger.error("Failed to finish authentication: \(error.localizedDescription)")
            throw error
        }
    }

    // MARK: - Logout

    func logout() async throws {
        guard let baseURL = apiClient.baseURL else { return }

        var request = URLRequest(url: baseURL.appendingPathComponent("/api/logout"))
        request.httpMethod = "POST"
        if let sessionId = apiClient.sessionId {
            request.setValue(sessionId, forHTTPHeaderField: "X-Session-Id")
        }

        _ = try? await URLSession.shared.data(for: request)
        apiClient.setSession(nil)
    }

    // MARK: - Private Helpers

    private func performAuthorization(with request: ASAuthorizationRequest) async throws -> ASAuthorizationCredential {
        try await withCheckedThrowingContinuation { continuation in
            self.authContinuation = continuation

            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    // MARK: - Server Communication

    private struct RegistrationStartResponse: Decodable {
        let options: RegistrationOptions
        let challengeId: String
    }

    private struct RegistrationOptions: Decodable {
        let challenge: String
        let user: UserInfo
        let rp: RelyingParty

        struct UserInfo: Decodable {
            let id: String
            let name: String
            let displayName: String
        }

        struct RelyingParty: Decodable {
            let name: String
            let id: String
        }
    }

    private struct AuthenticationStartResponse: Decodable {
        let options: AuthenticationOptions
        let challengeId: String
    }

    private struct AuthenticationOptions: Decodable {
        let challenge: String
        let allowCredentials: [CredentialDescriptor]?
        let rpId: String?

        struct CredentialDescriptor: Decodable {
            let id: String
            let type: String
        }
    }

    private func startRegistration() async throws -> RegistrationStartResponse {
        guard let baseURL = apiClient.baseURL else {
            throw AuthError.notConfigured
        }

        var request = URLRequest(url: baseURL.appendingPathComponent("/api/auth/register/start"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let sessionId = apiClient.sessionId {
            request.setValue(sessionId, forHTTPHeaderField: "X-Session-Id")
        }

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw AuthError.registrationFailed("Server error")
        }

        return try JSONDecoder().decode(RegistrationStartResponse.self, from: data)
    }

    private func finishRegistration(
        challengeId: String,
        credential: ASAuthorizationPlatformPublicKeyCredentialRegistration,
        name: String?
    ) async throws {
        guard let baseURL = apiClient.baseURL else {
            throw AuthError.notConfigured
        }

        // Build the response matching what the server expects
        let response: [String: Any] = [
            "challengeId": challengeId,
            "name": name ?? "",
            "response": [
                "id": credential.credentialID.base64URLEncodedString(),
                "rawId": credential.credentialID.base64URLEncodedString(),
                "type": "public-key",
                "response": [
                    "clientDataJSON": credential.rawClientDataJSON.base64URLEncodedString(),
                    "attestationObject": credential.rawAttestationObject?.base64URLEncodedString() ?? ""
                ],
                "clientExtensionResults": [:] as [String: Any]
            ] as [String: Any]
        ]

        var request = URLRequest(url: baseURL.appendingPathComponent("/api/auth/register/finish"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: response)

        let (data, httpResponse) = try await URLSession.shared.data(for: request)

        guard let http = httpResponse as? HTTPURLResponse, http.statusCode == 200 else {
            if let error = try? JSONDecoder().decode(ErrorResponse.self, from: data) {
                throw AuthError.registrationFailed(error.error)
            }
            throw AuthError.registrationFailed("Server error")
        }

        // Parse session ID from response
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let sessionId = json["sessionId"] as? String {
            apiClient.setSession(sessionId)
        }
    }

    private func startAuthentication() async throws -> AuthenticationStartResponse {
        guard let baseURL = apiClient.baseURL else {
            throw AuthError.notConfigured
        }

        var request = URLRequest(url: baseURL.appendingPathComponent("/api/auth/login/start"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            if let error = try? JSONDecoder().decode(ErrorResponse.self, from: data) {
                throw AuthError.authenticationFailed(error.error)
            }
            throw AuthError.authenticationFailed("Server error")
        }

        return try JSONDecoder().decode(AuthenticationStartResponse.self, from: data)
    }

    private func finishAuthentication(
        challengeId: String,
        credential: ASAuthorizationPlatformPublicKeyCredentialAssertion
    ) async throws {
        guard let baseURL = apiClient.baseURL else {
            throw AuthError.notConfigured
        }

        // Build the response matching what the server expects
        let response: [String: Any] = [
            "challengeId": challengeId,
            "response": [
                "id": credential.credentialID.base64URLEncodedString(),
                "rawId": credential.credentialID.base64URLEncodedString(),
                "type": "public-key",
                "response": [
                    "clientDataJSON": credential.rawClientDataJSON.base64URLEncodedString(),
                    "authenticatorData": credential.rawAuthenticatorData.base64URLEncodedString(),
                    "signature": credential.signature.base64URLEncodedString(),
                    "userHandle": credential.userID.base64URLEncodedString()
                ],
                "clientExtensionResults": [:] as [String: Any]
            ] as [String: Any]
        ]

        var request = URLRequest(url: baseURL.appendingPathComponent("/api/auth/login/finish"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: response)

        let (data, httpResponse) = try await URLSession.shared.data(for: request)

        guard let http = httpResponse as? HTTPURLResponse, http.statusCode == 200 else {
            if let error = try? JSONDecoder().decode(ErrorResponse.self, from: data) {
                throw AuthError.authenticationFailed(error.error)
            }
            throw AuthError.authenticationFailed("Server error")
        }

        // Parse session ID from response
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let sessionId = json["sessionId"] as? String {
            apiClient.setSession(sessionId)
        }
    }
}

// MARK: - ASAuthorizationControllerDelegate

extension AuthService: ASAuthorizationControllerDelegate {
    nonisolated func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        Task { @MainActor in
            authContinuation?.resume(returning: authorization.credential)
            authContinuation = nil
        }
    }

    nonisolated func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        Task { @MainActor in
            if let authError = error as? ASAuthorizationError,
               authError.code == .canceled {
                authContinuation?.resume(throwing: AuthError.cancelled)
            } else {
                authContinuation?.resume(throwing: error)
            }
            authContinuation = nil
        }
    }
}

// MARK: - ASAuthorizationControllerPresentationContextProviding

extension AuthService: ASAuthorizationControllerPresentationContextProviding {
    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        #if os(macOS)
        return NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first!
        #else
        return UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow } ?? UIWindow()
        #endif
    }
}

// MARK: - Data Extensions

extension Data {
    init?(base64URLEncoded string: String) {
        var base64 = string
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")

        // Add padding if needed
        while base64.count % 4 != 0 {
            base64.append("=")
        }

        self.init(base64Encoded: base64)
    }

    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
