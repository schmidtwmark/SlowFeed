import SwiftUI
#if os(iOS)
import SafariServices
#endif

/// User preference for how post URLs open: the in-app SFSafariViewController
/// (iOS) or hand off to the system browser. macOS only has the system
/// browser, so the choice is effectively iOS-only — `openPostURL` honors
/// the preference where it has options and silently falls back to the
/// system on macOS.
enum BrowserPreference: String, Codable, CaseIterable, Identifiable {
    case inApp
    case safari

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .inApp: return "In-App Browser"
        case .safari: return "Safari"
        }
    }
}

#if os(iOS)
/// Holds the URL currently being displayed in the in-app Safari sheet.
/// Wrapping the URL gives us `Identifiable` for `.sheet(item:)`, which
/// makes presenting / dismissing race-free.
struct SafariSheetTarget: Identifiable, Equatable {
    let url: URL
    var id: URL { url }
}

/// `UIViewControllerRepresentable` wrapper around `SFSafariViewController`
/// for in-app web browsing. Reader-mode controls and Done-button live in
/// the bundled chrome — we don't need to add anything around it.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let controller = SFSafariViewController(url: url)
        controller.dismissButtonStyle = .done
        return controller
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
#endif
