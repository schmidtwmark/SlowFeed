import SwiftUI

struct AuthenticationView: View {
    @Environment(AppState.self) private var appState

    @State private var isSetupMode = false
    @State private var passkeyName = ""
    @State private var isAuthenticating = false
    @State private var errorMessage: String?
    @State private var hasCheckedSetup = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            // Logo/Title
            VStack(spacing: 8) {
                Image(systemName: "key.fill")
                    .font(.system(size: 64))
                    .foregroundStyle(.tint)

                Text("Slowfeed")
                    .font(.largeTitle)
                    .fontWeight(.bold)

                if isSetupMode {
                    Text("Create a passkey to secure your account")
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                } else {
                    Text("Sign in with your passkey")
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            // Setup Mode - Create Passkey
            if isSetupMode {
                VStack(spacing: 16) {
                    TextField("Passkey name (optional)", text: $passkeyName)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 300)

                    Button(action: createPasskey) {
                        HStack {
                            if isAuthenticating {
                                ProgressView()
                                    .controlSize(.small)
                            } else {
                                Image(systemName: "key.fill")
                                Text("Create Passkey")
                            }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(isAuthenticating)
                }
            } else {
                // Login Mode - Sign In
                Button(action: signIn) {
                    HStack {
                        if isAuthenticating {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "person.badge.key.fill")
                            Text("Sign in with Passkey")
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(isAuthenticating)
            }

            // Error Message
            if let errorMessage {
                Text(errorMessage)
                    .foregroundStyle(.red)
                    .font(.callout)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }

            Spacer()

            // Change Server Button
            Button("Change Server") {
                appState.currentScreen = .serverSetup
            }
            .foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task {
            await checkSetupStatus()
        }
    }

    private func checkSetupStatus() async {
        guard !hasCheckedSetup else { return }
        hasCheckedSetup = true

        do {
            let setupComplete = try await appState.authService.checkSetupStatus()
            await MainActor.run {
                isSetupMode = !setupComplete
            }
        } catch {
            // If we can't check, assume we need to authenticate
            await MainActor.run {
                isSetupMode = false
            }
        }
    }

    private func createPasskey() {
        isAuthenticating = true
        errorMessage = nil

        Task {
            do {
                try await appState.registerPasskey(name: passkeyName.isEmpty ? nil : passkeyName)
            } catch AuthError.cancelled {
                await MainActor.run {
                    isAuthenticating = false
                }
            } catch {
                await MainActor.run {
                    errorMessage = error.localizedDescription
                    isAuthenticating = false
                }
            }
        }
    }

    private func signIn() {
        isAuthenticating = true
        errorMessage = nil

        Task {
            do {
                try await appState.loginWithPasskey()
            } catch AuthError.cancelled {
                await MainActor.run {
                    isAuthenticating = false
                }
            } catch {
                await MainActor.run {
                    errorMessage = error.localizedDescription
                    isAuthenticating = false
                }
            }
        }
    }
}

#Preview {
    AuthenticationView()
        .environment(AppState())
}
