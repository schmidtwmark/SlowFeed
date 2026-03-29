import SwiftUI

struct ContentView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        Group {
            switch appState.currentScreen {
            case .serverSetup:
                ServerSetupView()
            case .authentication:
                AuthenticationView()
            case .main:
                MainView()
            }
        }
        .task {
            await appState.initialize()
        }
    }
}

#Preview {
    ContentView()
        .environment(AppState())
}
