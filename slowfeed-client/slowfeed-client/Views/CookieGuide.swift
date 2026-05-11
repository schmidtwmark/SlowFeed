import SwiftUI

/// Collapsed-by-default help block for source-credentials sections of
/// SettingsView. Mirrors the `<details><summary>...</summary>...</details>`
/// help blocks the old web UI used to ship — the user can expand it to
/// see step-by-step instructions for getting Reddit / YouTube cookies
/// or the Discord token, then collapse it again to keep the form tidy.
struct CookieGuide: View {
    let summary: String
    let intro: String?
    let steps: [String]
    let notes: [String]

    @State private var isExpanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 10) {
                if let intro {
                    Text(intro)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(steps.enumerated()), id: \.offset) { idx, step in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("\(idx + 1).")
                                .font(.footnote)
                                .fontWeight(.semibold)
                                .foregroundStyle(.secondary)
                                .frame(width: 18, alignment: .trailing)
                            Text(step)
                                .font(.footnote)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                if !notes.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(notes.enumerated()), id: \.offset) { _, note in
                            Text(note)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.top, 2)
                }
            }
            .padding(.top, 6)
        } label: {
            Label(summary, systemImage: "questionmark.circle")
                .font(.footnote)
                .foregroundStyle(.tint)
        }
    }
}
