import SwiftUI

struct ServerSetupView: View {
    @Environment(AppState.self) private var appState

    @State private var serverURL = ""
    @State private var isConnecting = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            // Logo/Title
            VStack(spacing: 8) {
                Image(systemName: "dot.radiowaves.up.forward")
                    .font(.system(size: 64))
                    .foregroundStyle(.tint)

                Text("Slowfeed")
                    .font(.largeTitle)
                    .fontWeight(.bold)

                Text("Connect to your Slowfeed server")
                    .foregroundStyle(.secondary)
            }

            Spacer()

            // Server URL Input
            VStack(alignment: .leading, spacing: 8) {
                Text("Server URL")
                    .font(.headline)

                TextField("https://your-server.up.railway.app", text: $serverURL)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.URL)
                    #if os(iOS)
                    .keyboardType(.URL)
                    .autocapitalization(.none)
                    #endif
                    .autocorrectionDisabled()
                    .onSubmit {
                        connect()
                    }

                Text("Enter the full URL of your Slowfeed instance")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: 400)

            // Error Message
            if let errorMessage {
                Text(errorMessage)
                    .foregroundStyle(.red)
                    .font(.callout)
            }

            // Connect Button
            Button(action: connect) {
                if isConnecting {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Text("Connect")
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(serverURL.isEmpty || isConnecting)

            Spacer()
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear {
            serverURL = appState.serverURL
        }
    }

    private func connect() {
        guard !serverURL.isEmpty else { return }

        // Ensure URL has a scheme
        var urlString = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if !urlString.hasPrefix("http://") && !urlString.hasPrefix("https://") {
            urlString = "https://" + urlString
        }

        isConnecting = true
        errorMessage = nil

        Task {
            do {
                try await appState.connectToServer(url: urlString)
            } catch {
                await MainActor.run {
                    errorMessage = error.localizedDescription
                    isConnecting = false
                }
            }
        }
    }
}

#Preview {
    ServerSetupView()
        .environment(AppState())
}
