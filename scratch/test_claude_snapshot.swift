import Cocoa
import ApplicationServices

func extractLatestClaudeResponse(_ raw: String, requestId: String?) -> String? {
    guard !raw.isEmpty else { return nil }
    var source = raw

    if let requestId {
        let marker = "[AB:\(requestId)]"
        guard let markerRange = source.range(of: marker) else {
            print("MARKER NOT FOUND: \(marker)")
            return nil
        }
        source = String(source[markerRange.upperBound...])
    }

    guard let responseRange = source.range(of: "Claude responded:", options: .caseInsensitive) else {
        print("'Claude responded:' NOT FOUND in remaining source")
        return nil
    }

    var response = String(source[responseRange.upperBound...])

    let terminators = [
        "\nYou said:",
        "\nClaude responded:",
        "\njust now",
        "\n1 minute ago",
        "\n2 minutes ago",
        "\n3 minutes ago",
        "\n4 minutes ago",
        "\n5 minutes ago",
        "\n10 minutes ago",
        "\n20 minutes ago",
        "\n30 minutes ago",
        "\n1 hour ago",
        "\n2 hours ago",
        "\n3 hours ago",
        "\nYesterday",
        "\nAuto is on."
    ]

    var cut = response.endIndex
    for terminator in terminators {
        if let r = response.range(of: terminator, options: .caseInsensitive), r.lowerBound < cut {
            cut = r.lowerBound
        }
    }

    response = String(response[..<cut])
        .replacingOccurrences(of: "Claude finished the response", with: "")
        .trimmingCharacters(in: .whitespacesAndNewlines)

    let lines = response.components(separatedBy: "\n")
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }

    if lines.count >= 2 {
        let first = lines[0]
        let second = lines[1]
        let normalize: (String) -> String = { value in
            value.unicodeScalars
                .filter { CharacterSet.alphanumerics.contains($0) }
                .map(String.init)
                .joined()
                .lowercased()
        }

        if normalize(first) == normalize(second) {
            return second
        }

        let half = lines.count / 2
        if lines.count % 2 == 0 {
            let firstHalf = lines.prefix(half).joined(separator: "\n")
            let secondHalf = lines.suffix(half).joined(separator: "\n")
            if firstHalf == secondHalf {
                return firstHalf
            }
        }
    }

    return lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
}

let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.anthropic.claudefordesktop")
guard let app = apps.first else { print("No app"); exit(1) }
let axApp = AXUIElementCreateApplication(app.processIdentifier)
_ = AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
_ = AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)

var winVal: AnyObject?
_ = AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute as CFString, &winVal)
if winVal == nil {
    _ = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &winVal)
    if let wins = winVal as? [AXUIElement] { winVal = wins.first }
}
guard let win = winVal as! AXUIElement? else { print("No win"); exit(1) }

var texts: [String] = []
func collect(_ el: AXUIElement, _ depth: Int) {
    if depth > 60 { return }
    var roleVal: AnyObject?
    AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
    let role = (roleVal as? String) ?? ""
    if role == "AXStaticText" || role == "AXHeading" || role == "AXTextArea" || role == "AXTextField" {
        var vVal: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &vVal) == .success,
           let s = vVal as? String, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            texts.append(s)
        }
    }
    var cv: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
       let kids = cv as? [AXUIElement] {
        for k in kids { collect(k, depth + 1) }
    }
}
collect(win, 0)

let raw = texts.joined(separator: "\n")
let extracted = extractLatestClaudeResponse(raw, requestId: "req_mod_1791494069493_edc861bf")
print("\nExtracted response result:")
print(extracted ?? "NIL")
