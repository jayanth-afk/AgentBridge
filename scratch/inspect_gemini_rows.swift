import Cocoa
import ApplicationServices

guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.google.GeminiMacOS" || $0.localizedName == "Gemini" }) else {
    print("Gemini not found")
    exit(1)
}

let axApp = AXUIElementCreateApplication(app.processIdentifier)
_ = AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
_ = AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)

var val: AnyObject?
if AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute as CFString, &val) != .success || val == nil {
    AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &val)
    if let wins = val as? [AXUIElement], !wins.isEmpty { val = wins[0] }
}
guard let win = val else {
    print("No window found")
    exit(1)
}
let winEl = win as! AXUIElement

var rows: [AXUIElement] = []
func walk(_ el: AXUIElement, _ depth: Int) {
    if depth > 40 { return }
    var roleVal: AnyObject?
    AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
    let role = (roleVal as? String) ?? ""
    if role == "AXRow" { rows.append(el) }
    var cv: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success, let kids = cv as? [AXUIElement] {
        for k in kids { walk(k, depth + 1) }
    }
}
walk(winEl, 0)
print("Found rows: \(rows.count)")

for (idx, r) in rows.enumerated() {
    print("=== ROW \(idx) ===")
    func inspectRow(_ el: AXUIElement, _ indent: Int) {
        var roleVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
        let role = (roleVal as? String) ?? ""
        var titleVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXTitleAttribute as CFString, &titleVal)
        let title = (titleVal as? String) ?? ""
        var valVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &valVal)
        let val = (valVal as? String) ?? ""
        var descVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXDescriptionAttribute as CFString, &descVal)
        let desc = (descVal as? String) ?? ""
        var idVal: AnyObject?
        AXUIElementCopyAttributeValue(el, "AXIdentifier" as CFString, &idVal)
        let ident = (idVal as? String) ?? ""
        
        let info = [title, val, desc].filter { !$0.isEmpty }.joined(separator: " | ")
        if !info.isEmpty || !ident.isEmpty {
            let prefix = String(repeating: "  ", count: indent)
            print("\(prefix)[\(role)] id=\(ident) => \(info)")
        }
        var cv: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success, let kids = cv as? [AXUIElement] {
            for k in kids { inspectRow(k, indent + 1) }
        }
    }
    inspectRow(r, 0)
}
