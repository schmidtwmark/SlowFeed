import SwiftUI

struct TimelineBar: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        HStack(spacing: 12) {
            // Previous (older) button
            Button {
                Task {
                    await appState.navigateToPreviousDigest()
                }
            } label: {
                Image(systemName: "chevron.left")
            }
            .disabled(!appState.canNavigatePrevious)
            .help("Previous digest (older)")
            #if os(macOS)
            .keyboardShortcut(.leftArrow, modifiers: [])
            #endif

            // Timeline scroll
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Array(appState.digests.enumerated()), id: \.element.id) { index, digest in
                        TimelineItem(
                            digest: digest,
                            isSelected: index == appState.currentDigestIndex
                        ) {
                            Task {
                                await appState.navigateToDigest(at: index)
                            }
                        }
                    }
                }
                .padding(.horizontal, 4)
            }

            // Next (newer) button
            Button {
                Task {
                    await appState.navigateToNextDigest()
                }
            } label: {
                Image(systemName: "chevron.right")
            }
            .disabled(!appState.canNavigateNext)
            .help("Next digest (newer)")
            #if os(macOS)
            .keyboardShortcut(.rightArrow, modifiers: [])
            #endif
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }
}

struct TimelineItem: View {
    let digest: DigestSummary
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 4) {
                // Source indicator
                Circle()
                    .fill(sourceColor)
                    .frame(width: 8, height: 8)

                // Date
                Text(formattedDate)
                    .font(.caption2)
                    .foregroundStyle(isSelected ? .primary : .secondary)

                // Read indicator
                if !digest.isRead {
                    Circle()
                        .fill(.blue)
                        .frame(width: 6, height: 6)
                } else {
                    Circle()
                        .fill(.clear)
                        .frame(width: 6, height: 6)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(isSelected ? Color.accentColor.opacity(0.2) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
    }

    private var sourceColor: Color {
        switch digest.source {
        case .reddit: return .orange
        case .bluesky: return .blue
        case .youtube: return .red
        case .discord: return .purple
        }
    }

    private var formattedDate: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(digest.publishedAt) {
            return digest.publishedAt.formatted(date: .omitted, time: .shortened)
        } else if calendar.isDateInYesterday(digest.publishedAt) {
            return "Yesterday"
        } else {
            return digest.publishedAt.formatted(.dateTime.month(.abbreviated).day())
        }
    }
}

#Preview {
    VStack {
        Spacer()
        TimelineBar()
    }
    .environment(AppState())
}
