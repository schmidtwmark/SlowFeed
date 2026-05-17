import SwiftUI

#if !os(macOS)
/// Per-source switch bar mounted as the iOS TabView's bottom accessory
/// (via `.tabViewBottomAccessory` on MainView). One tab per sibling
/// source digest in the same poll-run group; tapping a tab cross-fades
/// to that source's digest while keeping the user in the same poll
/// run. The accessory inherits the TabView's floating Liquid-Glass
/// background, so this view ships content only — no bar chrome.
struct SourceTabBar: View {
    let siblings: [DigestSummary]
    let currentId: String
    let onSelect: (String) -> Void

    var body: some View {
        HStack(spacing: 4) {
            ForEach(siblings) { sibling in
                SourceTabBarItem(
                    sibling: sibling,
                    isActive: sibling.id == currentId
                ) {
                    guard sibling.id != currentId else { return }
                    onSelect(sibling.id)
                }
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 6)
        .background {
            // iOS 26 Liquid Glass capsule to match the system tab bar
            // visual that this view replaces. .background(.bar, in:)
            // is the system-tab-bar look on older iOS.
            Capsule(style: .continuous)
                .fill(.bar)
                .shadow(color: .black.opacity(0.18), radius: 8, y: 2)
        }
    }
}

private struct SourceTabBarItem: View {
    let sibling: DigestSummary
    let isActive: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: sourceIcon)
                .font(.title3)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(foreground)
                .frame(maxWidth: .infinity, minHeight: 36)
                .background {
                    // Subtle pill behind the active source so the tab
                    // bar reads at a glance even with icon-only labels.
                    if isActive {
                        Capsule(style: .continuous)
                            .fill(Color.accentColor.opacity(0.18))
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Switch to \(sibling.source.displayName)")
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    /// Active tab → accent color. Unread sibling → primary. Read
    /// sibling → secondary (subdued).
    private var foreground: Color {
        if isActive { return .accentColor }
        return sibling.isRead ? .secondary : .primary
    }

    private var sourceIcon: String {
        switch sibling.source {
        case .reddit: return "bubble.left.and.bubble.right.fill"
        case .bluesky: return "cloud.fill"
        case .youtube: return "play.rectangle.fill"
        case .discord: return "message.fill"
        case .mastodon: return "at"
        case .rss: return "dot.radiowaves.left.and.right"
        }
    }
}
#endif
