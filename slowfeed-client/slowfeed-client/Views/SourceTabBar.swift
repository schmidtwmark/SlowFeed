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
        HStack(spacing: 2) {
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
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background {
            // Match the system Liquid Glass tab bar look this view
            // is standing in for: continuous capsule + thin material
            // + a subtle shadow for separation from the post list
            // scrolling beneath it.
            Capsule(style: .continuous)
                .fill(.bar)
                .overlay {
                    Capsule(style: .continuous)
                        .strokeBorder(.separator.opacity(0.6), lineWidth: 0.5)
                }
                .shadow(color: .black.opacity(0.22), radius: 10, y: 3)
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
