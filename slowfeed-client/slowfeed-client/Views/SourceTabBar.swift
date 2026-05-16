import SwiftUI

#if !os(macOS)
/// iOS-only bottom tab bar that takes over the safe area inset when the
/// user is reading a digest. One tab per sibling source digest in the
/// same poll-run group; tapping a tab cross-fades to that source's
/// digest while keeping the user in the same poll run.
///
/// Styled to mimic the system tab bar: thin material background with a
/// hairline divider on top, source icons centered above their labels,
/// active tab tinted accent.
struct SourceTabBar: View {
    let siblings: [DigestSummary]
    let currentId: String
    let onSelect: (String) -> Void

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 0) {
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
            .padding(.top, 6)
            .padding(.bottom, 2)
        }
        .background(.bar)
    }
}

private struct SourceTabBarItem: View {
    let sibling: DigestSummary
    let isActive: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Image(systemName: sourceIcon)
                    .font(.title3)
                    .symbolRenderingMode(.hierarchical)
                Text(sibling.source.displayName)
                    .font(.caption2)
                    .lineLimit(1)
            }
            .foregroundStyle(foreground)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Switch to \(sibling.source.displayName)")
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
