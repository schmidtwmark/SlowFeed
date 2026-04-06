import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct HTTPLogView: View {
    @State private var httpLogger = HTTPLogger.shared
    @State private var searchText = ""
    @State private var statusFilter: StatusFilter = .all
    @State private var selectedEntry: HTTPLogEntry?

    enum StatusFilter: String, CaseIterable {
        case all = "All"
        case success = "2xx"
        case clientError = "4xx"
        case serverError = "5xx"
        case failed = "Failed"
    }

    private var filteredEntries: [HTTPLogEntry] {
        httpLogger.entries.filter { entry in
            // Status filter
            switch statusFilter {
            case .all: break
            case .success: guard entry.isSuccess else { return false }
            case .clientError: guard (400..<500).contains(entry.responseStatus) else { return false }
            case .serverError: guard entry.responseStatus >= 500 else { return false }
            case .failed: guard entry.isError else { return false }
            }
            // Search filter
            if !searchText.isEmpty {
                let query = searchText.lowercased()
                let matches = entry.url.lowercased().contains(query)
                    || entry.method.lowercased().contains(query)
                    || (entry.requestBody?.lowercased().contains(query) ?? false)
                    || (entry.responseBody?.lowercased().contains(query) ?? false)
                    || (entry.error?.lowercased().contains(query) ?? false)
                if !matches { return false }
            }
            return true
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            if !httpLogger.isEnabled {
                ContentUnavailableView(
                    "HTTP Logging Disabled",
                    systemImage: "network.slash",
                    description: Text("Enable HTTP logging to see network requests.\nThis may impact performance.")
                )
                .overlay(alignment: .bottom) {
                    Button("Enable Logging") {
                        httpLogger.isEnabled = true
                    }
                    .buttonStyle(.borderedProminent)
                    .padding(.bottom, 40)
                }
            } else if httpLogger.entries.isEmpty {
                ContentUnavailableView(
                    "No Requests Yet",
                    systemImage: "network",
                    description: Text("HTTP requests will appear here as they are made.")
                )
            } else {
                List(filteredEntries, selection: $selectedEntry) { entry in
                    HTTPLogRow(entry: entry)
                        .tag(entry)
                }
                .listStyle(.plain)
                .searchable(text: $searchText, prompt: "Search URL, body, error...")
            }
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("Filter", selection: $statusFilter) {
                    ForEach(StatusFilter.allCases, id: \.self) { filter in
                        Text(filter.rawValue).tag(filter)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 300)
            }

            #if os(macOS)
            ToolbarItem(placement: .primaryAction) {
                Toggle(isOn: $httpLogger.isEnabled) {
                    Label("Logging", systemImage: httpLogger.isEnabled ? "circle.fill" : "circle")
                }
                .toggleStyle(.button)
                .help(httpLogger.isEnabled ? "Disable HTTP logging" : "Enable HTTP logging")
            }
            #endif

            ToolbarItem(placement: .destructiveAction) {
                Button {
                    httpLogger.clear()
                } label: {
                    Label("Clear", systemImage: "trash")
                }
                .disabled(httpLogger.entries.isEmpty)
            }
        }
        .sheet(item: $selectedEntry) { entry in
            HTTPLogDetailView(entry: entry)
        }
    }
}

// MARK: - Log Row

struct HTTPLogRow: View {
    let entry: HTTPLogEntry

    var body: some View {
        HStack(spacing: 8) {
            // Status indicator
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)

            // Method badge
            Text(entry.method)
                .font(.caption)
                .fontWeight(.bold)
                .monospaced()
                .foregroundStyle(.secondary)
                .frame(width: 40, alignment: .leading)

            // Status code
            Text(entry.responseStatus > 0 ? "\(entry.responseStatus)" : "ERR")
                .font(.caption)
                .fontWeight(.semibold)
                .monospaced()
                .foregroundStyle(statusColor)
                .frame(width: 32, alignment: .leading)

            // URL path (strip base URL for readability)
            VStack(alignment: .leading, spacing: 1) {
                Text(urlPath)
                    .font(.subheadline)
                    .lineLimit(1)

                if let error = entry.error {
                    Text(error)
                        .font(.caption2)
                        .foregroundStyle(.red)
                        .lineLimit(1)
                }
            }

            Spacer()

            // Duration + time
            VStack(alignment: .trailing, spacing: 1) {
                Text("\(Int(entry.duration * 1000))ms")
                    .font(.caption2)
                    .monospaced()
                    .foregroundStyle(.secondary)
                Text(entry.timestamp.formatted(date: .omitted, time: .standard))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }

    private var statusColor: Color {
        if entry.error != nil { return .red }
        switch entry.responseStatus {
        case 200..<300: return .green
        case 300..<400: return .blue
        case 400..<500: return .orange
        case 500...: return .red
        default: return .gray
        }
    }

    private var urlPath: String {
        if let url = URL(string: entry.url) {
            return url.path + (url.query.map { "?\($0)" } ?? "")
        }
        return entry.url
    }
}

// MARK: - Log Detail View

struct HTTPLogDetailView: View {
    let entry: HTTPLogEntry

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    // Summary
                    GroupBox("Request") {
                        VStack(alignment: .leading, spacing: 8) {
                            row("Method", entry.method)
                            row("URL", entry.url)
                            row("Time", entry.timestamp.formatted(date: .abbreviated, time: .standard))
                            row("Duration", "\(Int(entry.duration * 1000))ms")

                            if !entry.requestHeaders.isEmpty {
                                headerSection("Headers", entry.requestHeaders)
                            }

                            if let body = entry.requestBody {
                                bodySection("Body", body)
                            }
                        }
                    }

                    GroupBox("Response") {
                        VStack(alignment: .leading, spacing: 8) {
                            row("Status", "\(entry.responseStatus)")

                            if let error = entry.error {
                                row("Error", error)
                            }

                            if !entry.responseHeaders.isEmpty {
                                headerSection("Headers", entry.responseHeaders)
                            }

                            if let body = entry.responseBody {
                                bodySection("Body", body)
                            }
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("\(entry.method) \(URL(string: entry.url)?.path ?? entry.url)")
            #if !os(macOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        copyAll()
                    } label: {
                        Label("Copy All", systemImage: "doc.on.doc")
                    }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 600, minHeight: 500)
        #endif
    }

    @ViewBuilder
    private func row(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
                .frame(width: 60, alignment: .trailing)
            Text(value)
                .font(.caption)
                .textSelection(.enabled)
        }
    }

    @ViewBuilder
    private func headerSection(_ title: String, _ headers: [String: String]) -> some View {
        DisclosureGroup(title) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(headers.sorted(by: { $0.key < $1.key }), id: \.key) { key, value in
                    HStack(alignment: .top, spacing: 4) {
                        Text(key + ":")
                            .font(.system(.caption2, design: .monospaced))
                            .fontWeight(.medium)
                            .foregroundStyle(.secondary)
                        Text(value)
                            .font(.system(.caption2, design: .monospaced))
                            .textSelection(.enabled)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func bodySection(_ title: String, _ body: String) -> some View {
        DisclosureGroup(title) {
            Text(body)
                .font(.system(.caption2, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(.quaternary.opacity(0.3))
                .clipShape(RoundedRectangle(cornerRadius: 6))
        }
    }

    private func copyAll() {
        var text = "\(entry.method) \(entry.url)\n"
        text += "Status: \(entry.responseStatus)\n"
        text += "Duration: \(Int(entry.duration * 1000))ms\n"
        text += "Time: \(entry.timestamp.formatted())\n\n"

        if !entry.requestHeaders.isEmpty {
            text += "--- Request Headers ---\n"
            for (k, v) in entry.requestHeaders.sorted(by: { $0.key < $1.key }) {
                text += "\(k): \(v)\n"
            }
            text += "\n"
        }

        if let body = entry.requestBody {
            text += "--- Request Body ---\n\(body)\n\n"
        }

        if !entry.responseHeaders.isEmpty {
            text += "--- Response Headers ---\n"
            for (k, v) in entry.responseHeaders.sorted(by: { $0.key < $1.key }) {
                text += "\(k): \(v)\n"
            }
            text += "\n"
        }

        if let body = entry.responseBody {
            text += "--- Response Body ---\n\(body)\n"
        }

        if let error = entry.error {
            text += "--- Error ---\n\(error)\n"
        }

        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
    }
}

// Make HTTPLogEntry work with sheet(item:)
extension HTTPLogEntry: Hashable {
    static func == (lhs: HTTPLogEntry, rhs: HTTPLogEntry) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}
