import SwiftUI

@main
struct SlowfeedApp: App {
    @State private var appState = AppState()
    @Environment(\.scenePhase) private var scenePhase


    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(appState)
                #if os(iOS)
                // Clear iOS's stale "ghost keyboard" inset (tab bar stuck
                // hoisted after app switching) whenever we return to the
                // foreground. Slight delay lets the scene finish settling
                // before we poke UIKit. See GhostKeyboardFix.
                .onChange(of: scenePhase) { _, newPhase in
                    guard newPhase == .active else { return }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        GhostKeyboardFix.run()
                    }
                }
                #endif
        }
        #if os(macOS)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Refresh") {
                    Task {
                        await appState.refreshDigests()
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
