import Cocoa
import ApplicationServices

// High-frequency frontmost sampler (every 2ms)
var running = true
var samples: [(timestamp: Date, pid: pid_t, name: String)] = []
let frontmostAtStart = NSWorkspace.shared.frontmostApplication!
print("Starting non-activating test. Frontmost: [\(frontmostAtStart.processIdentifier)] \(frontmostAtStart.localizedName ?? "")")

let samplerQueue = DispatchQueue(label: "sampler")
samplerQueue.async {
    while running {
        if let current = NSWorkspace.shared.frontmostApplication {
            samples.append((Date(), current.processIdentifier, current.localizedName ?? ""))
        }
        usleep(2000) // 2ms
    }
}

func axString(_ el: AXUIElement, _ attr: String) -> String {
    var v: AnyObject?
    if AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success, let s = v as? String { return s }
    return ""
}

// 1. Test Claude
print("\n--- Testing Claude non-activating turn ---")
if let claudeApp = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.anthropic.claudefordesktop" || $0.localizedName == "Claude" }) {
    let axApp = AXUIElementCreateApplication(claudeApp.processIdentifier)
    var winVal: AnyObject?
    _ = AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute as CFString, &winVal)
    if let win = winVal as! AXUIElement? {
        var input: AXUIElement? = nil
        var sendBtn: AXUIElement? = nil
        func walk(_ el: AXUIElement, depth: Int) {
            if depth > 40 { return }
            let role = axString(el, kAXRoleAttribute)
            if role == "AXTextArea" && input == nil { input = el }
            if role == "AXButton" && sendBtn == nil {
                let desc = axString(el, kAXDescriptionAttribute).lowercased()
                let title = axString(el, kAXTitleAttribute).lowercased()
                if desc.contains("send") || title.contains("send") { sendBtn = el }
            }
            var cv: AnyObject?
            if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
               let kids = cv as? [AXUIElement] {
                for k in kids { walk(k, depth: depth + 1) }
            }
        }
        walk(win, depth: 0)
        print("  Claude input: \(input != nil), sendBtn: \(sendBtn != nil)")
    }
}

// 2. Test ChatGPT
print("\n--- Testing ChatGPT non-activating turn ---")
if let chatgptApp = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.openai.codex" }) {
    let axApp = AXUIElementCreateApplication(chatgptApp.processIdentifier)
    var winVal: AnyObject?
    _ = AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute as CFString, &winVal)
    if let win = winVal as! AXUIElement? {
        var input: AXUIElement? = nil
        var sendBtn: AXUIElement? = nil
        func walk(_ el: AXUIElement, depth: Int) {
            if depth > 40 { return }
            let role = axString(el, kAXRoleAttribute)
            if role == "AXTextArea" && input == nil { input = el }
            if role == "AXButton" && sendBtn == nil {
                let desc = axString(el, kAXDescriptionAttribute).lowercased()
                let title = axString(el, kAXTitleAttribute).lowercased()
                if desc.contains("send") || title.contains("send") { sendBtn = el }
            }
            var cv: AnyObject?
            if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
               let kids = cv as? [AXUIElement] {
                for k in kids { walk(k, depth: depth + 1) }
            }
        }
        walk(win, depth: 0)
        print("  ChatGPT input: \(input != nil), sendBtn: \(sendBtn != nil)")
    }
}

// 3. Test Gemini
print("\n--- Testing Gemini non-activating turn ---")
if let geminiApp = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.google.GeminiMacOS" }) {
    let axApp = AXUIElementCreateApplication(geminiApp.processIdentifier)
    var winVal: AnyObject?
    _ = AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute as CFString, &winVal)
    if winVal == nil {
        var winsVal: AnyObject?
        _ = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &winsVal)
        if let ws = winsVal as? [AXUIElement], let first = ws.first { winVal = first }
    }
    if let win = winVal as! AXUIElement? {
        var input: AXUIElement? = nil
        var sendBtn: AXUIElement? = nil
        func walk(_ el: AXUIElement, depth: Int) {
            if depth > 40 { return }
            let role = axString(el, kAXRoleAttribute)
            if role == "AXTextArea" && input == nil { input = el }
            if role == "AXButton" && sendBtn == nil {
                let desc = axString(el, kAXDescriptionAttribute).lowercased()
                let title = axString(el, kAXTitleAttribute).lowercased()
                if desc.contains("send") || title.contains("send") || desc.contains("submit") { sendBtn = el }
            }
            var cv: AnyObject?
            if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
               let kids = cv as? [AXUIElement] {
                for k in kids { walk(k, depth: depth + 1) }
            }
        }
        walk(win, depth: 0)
        print("  Gemini input: \(input != nil), sendBtn: \(sendBtn != nil)")
    }
}

usleep(100_000)
running = false
usleep(20_000)

let frontmostAtEnd = NSWorkspace.shared.frontmostApplication!
print("\nFinal frontmost: [\(frontmostAtEnd.processIdentifier)] \(frontmostAtEnd.localizedName ?? "")")

let alienSamples = samples.filter { $0.pid != frontmostAtStart.processIdentifier }
print("Total samples collected: \(samples.count)")
print("Alien frontmost activations detected: \(alienSamples.count)")
for s in alienSamples.prefix(10) {
    print("  Alien sample at \(s.timestamp): [\(s.pid)] \(s.name)")
}
