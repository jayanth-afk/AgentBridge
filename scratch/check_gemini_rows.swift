import Cocoa
import ApplicationServices

let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.google.GeminiMacOS")
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

var rows: [AXUIElement] = []
func walk(_ el: AXUIElement, _ depth: Int) {
    if depth > 40 { return }
    var roleVal: AnyObject?
    AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
    if (roleVal as? String) == "AXRow" {
        rows.append(el)
    }
    var cv: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
       let kids = cv as? [AXUIElement] {
        for k in kids { walk(k, depth + 1) }
    }
}
walk(win, 0)

for rIdx in 42..<rows.count {
    print("\n--- INSPECTING ROW [\(rIdx)] ---")
    func dump(_ el: AXUIElement, _ depth: Int) {
        if depth > 20 { return }
        var roleVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
        let role = (roleVal as? String) ?? ""
        var valVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &valVal)
        let v = (valVal as? String) ?? ""
        var descVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXDescriptionAttribute as CFString, &descVal)
        let d = (descVal as? String) ?? ""
        var titleVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXTitleAttribute as CFString, &titleVal)
        let t = (titleVal as? String) ?? ""
        var idVal: AnyObject?
        AXUIElementCopyAttributeValue(el, "AXIdentifier" as CFString, &idVal)
        let ident = (idVal as? String) ?? ""

        print("  [\(depth)] role=\(role) ident=\(ident) val=\"\(v.prefix(60))\" desc=\"\(d.prefix(60))\" title=\"\(t.prefix(60))\"")

        var cv: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
           let kids = cv as? [AXUIElement] {
            for k in kids { dump(k, depth + 1) }
        }
    }
    dump(rows[rIdx], 0)
}
