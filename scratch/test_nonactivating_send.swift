import Cocoa
import ApplicationServices

// High-frequency frontmost sampler
var running = true
var samples: [(timestamp: Date, pid: pid_t, name: String)] = []
let frontmostAtStart = NSWorkspace.shared.frontmostApplication!
print("Starting test with frontmost app: [\(frontmostAtStart.processIdentifier)] \(frontmostAtStart.localizedName ?? "")")

let samplerQueue = DispatchQueue(label: "sampler")
samplerQueue.async {
    while running {
        if let current = NSWorkspace.shared.frontmostApplication {
            samples.append((Date(), current.processIdentifier, current.localizedName ?? ""))
        }
        usleep(5000) // 5ms sampling rate!
    }
}

func testApp(name: String, bundleId: String) {
    print("\n========================================================")
    print("Testing \(name) purely non-activating")
    print("========================================================")
    
    guard let app = NSWorkspace.shared.runningApplications.first(where: {
        ($0.bundleIdentifier == bundleId || $0.localizedName == name) && $0.activationPolicy == .regular
    }) else {
        print("  ERROR: \(name) not running")
        return
    }
    
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    _ = AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    
    var winVal: AnyObject?
    var targetWin: AXUIElement? = nil
    if AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute as CFString, &winVal) == .success, let w = winVal {
        targetWin = (w as! AXUIElement)
    } else {
        var winsVal: AnyObject?
        if AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &winsVal) == .success,
           let wins = winsVal as? [AXUIElement], let w = wins.first {
            targetWin = w
        }
    }
    
    guard let win = targetWin else {
        print("  ERROR: No window found for \(name)")
        return
    }
    
    print("  Window found for \(name) without activation!")
    
    // Find text area
    var foundInput: AXUIElement? = nil
    var foundSendBtn: AXUIElement? = nil
    
    func walk(_ el: AXUIElement, depth: Int) {
        if depth > 50 { return }
        var roleVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
        let role = (roleVal as? String) ?? ""
        if role == "AXTextArea" && foundInput == nil {
            foundInput = el
        }
        if role == "AXButton" && foundSendBtn == nil {
            var descVal: AnyObject?
            AXUIElementCopyAttributeValue(el, kAXDescriptionAttribute as CFString, &descVal)
            let desc = ((descVal as? String) ?? "").lowercased()
            var titleVal: AnyObject?
            AXUIElementCopyAttributeValue(el, kAXTitleAttribute as CFString, &titleVal)
            let title = ((titleVal as? String) ?? "").lowercased()
            if desc.contains("send") || title.contains("send") || desc.contains("submit") {
                foundSendBtn = el
            }
        }
        var cv: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
           let children = cv as? [AXUIElement] {
            for c in children { walk(c, depth: depth + 1) }
        }
    }
    
    walk(win, depth: 0)
    print("  foundInput: \(foundInput != nil), foundSendBtn: \(foundSendBtn != nil)")
}

testApp(name: "Claude", bundleId: "com.anthropic.claudedesktop")
testApp(name: "ChatGPT", bundleId: "com.openai.codex")
testApp(name: "Gemini", bundleId: "com.google.GeminiMacOS")

running = false
usleep(20_000)

let frontmostAtEnd = NSWorkspace.shared.frontmostApplication!
print("\nFinal frontmost app: [\(frontmostAtEnd.processIdentifier)] \(frontmostAtEnd.localizedName ?? "")")

let alienSamples = samples.filter { $0.pid != frontmostAtStart.processIdentifier }
print("Total samples collected: \(samples.count)")
print("Alien frontmost activations during execution: \(alienSamples.count)")
for s in alienSamples.prefix(10) {
    print("  Alien sample at \(s.timestamp): [\(s.pid)] \(s.name)")
}
