import Cocoa
import ApplicationServices

let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.openai.codex")
guard let app = apps.first else {
    print("No app found")
    exit(1)
}

let axApp = AXUIElementCreateApplication(app.processIdentifier)
var winVal: AnyObject?
AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &winVal)
guard let wins = winVal as? [AXUIElement], let win = wins.first else {
    print("No window found")
    exit(1)
}

func printTree(_ el: AXUIElement, _ depth: Int) {
    if depth > 40 { return }
    var roleVal: AnyObject?
    AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
    let role = (roleVal as? String) ?? ""
    var titleVal: AnyObject?
    AXUIElementCopyAttributeValue(el, kAXTitleAttribute as CFString, &titleVal)
    let title = (titleVal as? String) ?? ""
    var descVal: AnyObject?
    AXUIElementCopyAttributeValue(el, kAXDescriptionAttribute as CFString, &descVal)
    let desc = (descVal as? String) ?? ""
    var enabledVal: AnyObject?
    AXUIElementCopyAttributeValue(el, kAXEnabledAttribute as CFString, &enabledVal)
    let enabled = (enabledVal as? Bool) ?? false

    if role == "AXButton" {
        print("BUTTON [depth \(depth)]: title='\(title)', desc='\(desc)', enabled=\(enabled)")
    } else if role == "AXTextArea" || role == "AXTextField" {
        print("TEXT [depth \(depth)]: role=\(role), title='\(title)', desc='\(desc)', enabled=\(enabled)")
    }

    var kidsVal: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &kidsVal) == .success,
       let kids = kidsVal as? [AXUIElement] {
        for k in kids { printTree(k, depth + 1) }
    }
}

printTree(win, 0)
