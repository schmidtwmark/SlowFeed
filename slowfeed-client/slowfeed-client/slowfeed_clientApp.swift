import SwiftUI

@main
struct SlowfeedApp: App {
    @State private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(appState)
        }
        #if os(macOS)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Refresh Feeds") {
                    Task {
                        try? await appState.triggerPoll()
                    }
                }
                .keyboardShortcut("r", modifiers: .command)
            }

            CommandGroup(replacing: .newItem) {
                // Remove new window command
            }
        }
        #endif

        #if os(macOS)
        Settings {
            SettingsView()
                .environment(appState)
        }
        #endif
    }
}
