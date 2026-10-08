import Cocoa
import ApplicationServices

let frontmostBefore = NSWorkspace.shared.frontmostApplication!
print("Frontmost before: [\(frontmostBefore.processIdentifier)] \(frontmostBefore.localizedName ?? "")")

// Monitor frontmost app continuously
var running = true
var activations: [String] = []

let queue = DispatchQueue(label: "monitor")
queue.async {
    while running {
        if let current = NSWorkspace.shared.frontmostApplication {
            if current.processIdentifier != frontmostBefore.processIdentifier {
                activations.append("[\(Date())] Frontmost changed to [\(current.processIdentifier)] \(current.localizedName ?? "")")
            }
        }
        usleep(10_000) // 10ms
    }
}

func probeApp(_ name: String, bundleId: String) {
    print("\n--- Probing \(name) without activation ---")
    guard let app = NSWorkspace.shared.runningApplications.first(where: {
        ($0.bundleIdentifier == bundleId || $0.localizedName == name) && $0.activationPolicy == .regular
    }) else {
        print("  \(name) not running")
        return
    }

    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    _ = AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)

    var winVal: AnyObject?
    let err = AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute as CFString, &winVal)
    if err == .success, let win = winVal as! AXUIElement? {
        print("  Window found via kAXMainWindowAttribute")
    } else {
        var winsVal: AnyObject?
        if AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &winsVal) == .success,
           let wins = winsVal as? [AXUIElement], let w = wins.first {
            print("  Window found via kAXWindowsAttribute (\(wins.count) windows)")
        } else {
            print("  No window found without activation: AXError \(err.rawValue)")
        }
    }
}

probeApp("Google Chrome", bundleId: "com.google.Chrome")
probeApp("Claude", bundleId: "com.anthropic.claudedesktop")
probeApp("Gemini", bundleId: "com.google.GeminiMacOS")
probeApp("ChatGPT", bundleId: "com.openai.codex")

usleep(500_000)
running = false
usleep(50_000)

let frontmostAfter = NSWorkspace.shared.frontmostApplication!
print("\nFrontmost after: [\(frontmostAfter.processIdentifier)] \(frontmostAfter.localizedName ?? "")")
print("Transient activations detected: \(activations.count)")
for a in activations {
    print("  \(a)")
}
