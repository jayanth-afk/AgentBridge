import Foundation
import ApplicationServices
import AppKit

// Data structures for JSON communication over stdin/stdout
struct RequestOp: Codable {
    let op: String
    let app: String?
    let appName: String?
    let bundleId: String?
    let value: String?
    let requestId: String?
    let pid: pid_t?
    let identifier: String?
    let role: String?
    let timeoutMs: Int?

    var targetApp: String {
        return app ?? appName ?? "Claude"
    }
}

struct WindowInfo: Codable {
    let title: String
    let minimized: Bool
    let main: Bool
}

struct InspectResponse: Codable {
    let ok: Bool
    let app: String
    let running: Bool
    let pid: pid_t?
    let windowCount: Int
    let windows: [String]
    let windowDetails: [WindowInfo]
    let hidden: Bool
    let error: String?
}

struct ElementInfo: Codable {
    let role: String
    let subrole: String?
    let title: String?
    let description: String?
    let identifier: String?
    let value: String?
    let enabled: Bool
    let depth: Int
}

struct ElementsResponse: Codable {
    let ok: Bool
    let app: String
    let pid: pid_t
    let elements: [ElementInfo]
    let error: String?
}

struct FrontmostResponse: Codable {
    let ok: Bool
    let name: String
    let pid: pid_t
    let bundleId: String?
}

struct SimpleResponse: Codable {
    let ok: Bool
    let status: String
    let details: String?
}

func findAppProcess(name: String) -> NSRunningApplication? {
    let apps = NSWorkspace.shared.runningApplications
    return apps.first { app in
        if let appName = app.localizedName, appName.caseInsensitiveCompare(name) == .orderedSame {
            return true
        }
        if let bundle = app.bundleIdentifier, bundle.lowercased().contains(name.lowercased()) {
            return true
        }
        return false
    }
}

func findAppByPid(pid: pid_t) -> NSRunningApplication? {
    return NSRunningApplication(processIdentifier: pid)
}

func getFrontmostApp() -> FrontmostResponse {
    if let front = NSWorkspace.shared.frontmostApplication {
        return FrontmostResponse(
            ok: true,
            name: front.localizedName ?? "Unknown",
            pid: front.processIdentifier,
            bundleId: front.bundleIdentifier
        )
    }
    return FrontmostResponse(ok: false, name: "None", pid: 0, bundleId: nil)
}

func inspectApp(name: String) -> InspectResponse {
    guard let app = findAppProcess(name: name) else {
        return InspectResponse(ok: false, app: name, running: false, pid: nil, windowCount: 0, windows: [], windowDetails: [], hidden: false, error: "APP_NOT_RUNNING")
    }

    let pid = app.processIdentifier
    let isHidden = app.isHidden
    let axApp = AXUIElementCreateApplication(pid)

    var windowsValue: AnyObject?
    let result = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsValue)

    var windowTitles: [String] = []
    var windowDetails: [WindowInfo] = []
    var windowCount = 0

    if result == .success, let windows = windowsValue as? [AXUIElement] {
        windowCount = windows.count
        for win in windows {
            var titleVal: AnyObject?
            let titleStr: String
            if AXUIElementCopyAttributeValue(win, kAXTitleAttribute as CFString, &titleVal) == .success,
               let str = titleVal as? String {
                titleStr = str
            } else {
                titleStr = "Untitled Window"
            }
            windowTitles.append(titleStr)

            var minVal: AnyObject?
            var isMin = false
            if AXUIElementCopyAttributeValue(win, kAXMinimizedAttribute as CFString, &minVal) == .success,
               let b = minVal as? Bool {
                isMin = b
            }

            var mainVal: AnyObject?
            var isMain = false
            if AXUIElementCopyAttributeValue(win, kAXMainAttribute as CFString, &mainVal) == .success,
               let b = mainVal as? Bool {
                isMain = b
            }

            windowDetails.append(WindowInfo(title: titleStr, minimized: isMin, main: isMain))
        }
    }

    return InspectResponse(
        ok: true,
        app: name,
        running: true,
        pid: pid,
        windowCount: windowCount,
        windows: windowTitles,
        windowDetails: windowDetails,
        hidden: isHidden,
        error: nil
    )
}

func inspectElements(name: String) -> ElementsResponse {
    guard let app = findAppProcess(name: name) else {
        return ElementsResponse(ok: false, app: name, pid: 0, elements: [], error: "APP_NOT_RUNNING")
    }

    let pid = app.processIdentifier
    let axApp = AXUIElementCreateApplication(pid)

    var windowsValue: AnyObject?
    guard AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsValue) == .success,
          let windows = windowsValue as? [AXUIElement], let mainWin = windows.first else {
        return ElementsResponse(ok: false, app: name, pid: pid, elements: [], error: "NO_ACCESSIBLE_WINDOW")
    }

    var elements: [ElementInfo] = []

    func walk(_ element: AXUIElement, depth: Int) {
        if depth > 5 || elements.count >= 80 { return }

        var roleVal: AnyObject?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleVal)
        let role = (roleVal as? String) ?? "unknown"

        var subroleVal: AnyObject?
        AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subroleVal)
        let subrole = subroleVal as? String

        var titleVal: AnyObject?
        AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &titleVal)
        let title = titleVal as? String

        var descVal: AnyObject?
        AXUIElementCopyAttributeValue(element, kAXDescriptionAttribute as CFString, &descVal)
        let desc = descVal as? String

        var idVal: AnyObject?
        AXUIElementCopyAttributeValue(element, kAXIdentifierAttribute as CFString, &idVal)
        let idStr = idVal as? String

        var valVal: AnyObject?
        var valStr: String? = nil
        if AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &valVal) == .success,
           let str = valVal as? String {
            valStr = str.count > 100 ? String(str.prefix(100)) + "..." : str
        }

        var enabledVal: AnyObject?
        var isEnabled = true
        if AXUIElementCopyAttributeValue(element, kAXEnabledAttribute as CFString, &enabledVal) == .success,
           let b = enabledVal as? Bool {
            isEnabled = b
        }

        // Only keep interactable or informative elements
        if role == "AXTextArea" || role == "AXTextField" || role == "AXButton" || role == "AXStaticText" || role == "AXRow" || (idStr != nil && !idStr!.isEmpty) {
            elements.append(ElementInfo(
                role: role,
                subrole: subrole,
                title: title,
                description: desc,
                identifier: idStr,
                value: valStr,
                enabled: isEnabled,
                depth: depth
            ))
        }

        var childrenVal: AnyObject?
        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenVal) == .success,
           let children = childrenVal as? [AXUIElement] {
            for child in children {
                walk(child, depth: depth + 1)
            }
        }
    }

    walk(mainWin, depth: 0)
    return ElementsResponse(ok: true, app: name, pid: pid, elements: elements, error: nil)
}

func activateApp(name: String) -> SimpleResponse {
    guard let app = findAppProcess(name: name) else {
        return SimpleResponse(ok: false, status: "APP_NOT_RUNNING", details: nil)
    }
    app.unhide()
    let success = app.activate(options: [])
    return SimpleResponse(ok: success, status: success ? "ACTIVATED" : "FAILED", details: nil)
}

func restoreFocusToPid(pid: pid_t) -> SimpleResponse {
    guard let app = findAppByPid(pid: pid) else {
        return SimpleResponse(ok: false, status: "PROCESS_NOT_FOUND", details: nil)
    }
    let success = app.activate(options: [])
    return SimpleResponse(ok: success, status: success ? "RESTORED" : "FAILED", details: nil)
}

func unhideApp(name: String) -> SimpleResponse {
    guard let app = findAppProcess(name: name) else {
        return SimpleResponse(ok: false, status: "APP_NOT_RUNNING", details: nil)
    }
    let success = app.unhide()
    return SimpleResponse(ok: success, status: success ? "UNHIDDEN" : "FAILED", details: nil)
}

// AXObserver state
var activeObserver: AXObserver? = nil
var activeRunLoopSource: CFRunLoopSource? = nil

func setupObserver(name: String) -> SimpleResponse {
    guard let app = findAppProcess(name: name) else {
        return SimpleResponse(ok: false, status: "APP_NOT_RUNNING", details: nil)
    }

    let pid = app.processIdentifier
    var observerRef: AXObserver?
    let err = AXObserverCreate(pid, { (observer, element, notification, refcon) in
        let notifStr = notification as String
        print("{\"event\":\"ax_notification\",\"type\":\"\(notifStr)\",\"timestamp\":\(Date().timeIntervalSince1970)}")
        fflush(stdout)
    }, &observerRef)

    guard err == .success, let observer = observerRef else {
        return SimpleResponse(ok: false, status: "OBSERVER_CREATE_FAILED", details: "\(err.rawValue)")
    }

    let axApp = AXUIElementCreateApplication(pid)
    _ = AXObserverAddNotification(observer, axApp, kAXValueChangedNotification as CFString, nil)
    _ = AXObserverAddNotification(observer, axApp, kAXWindowCreatedNotification as CFString, nil)
    _ = AXObserverAddNotification(observer, axApp, kAXFocusedUIElementChangedNotification as CFString, nil)

    activeObserver = observer
    activeRunLoopSource = AXObserverGetRunLoopSource(observer)
    if let source = activeRunLoopSource {
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .defaultMode)
    }

    return SimpleResponse(ok: true, status: "OBSERVER_ACTIVE", details: "Attached to PID \(pid)")
}

func handleRequest(_ req: RequestOp) {
    let encoder = JSONEncoder()
    switch req.op {
    case "ping":
        print("{\"ok\":true,\"status\":\"pong\"}")
    case "frontmost":
        let resp = getFrontmostApp()
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    case "inspect":
        let resp = inspectApp(name: req.targetApp)
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    case "elements":
        let resp = inspectElements(name: req.targetApp)
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    case "activate":
        let resp = activateApp(name: req.targetApp)
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    case "restoreFocus":
        let targetPid = req.pid ?? 0
        let resp = restoreFocusToPid(pid: targetPid)
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    case "unhide":
        let resp = unhideApp(name: req.targetApp)
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    case "observe":
        let resp = setupObserver(name: req.targetApp)
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    default:
        print("{\"ok\":false,\"error\":\"UNKNOWN_OP\"}")
    }
    fflush(stdout)
}

// Support command-line JSON argument or persistent line-by-line stdin
let args = CommandLine.arguments
if args.count > 1 && args[1] != "--daemon" {
    let commandJson = args[1]
    if let data = commandJson.data(using: .utf8),
       let req = try? JSONDecoder().decode(RequestOp.self, from: data) {
        handleRequest(req)
    } else {
        print("{\"ok\":false,\"error\":\"INVALID_JSON\"}")
    }
} else {
    // Daemon or stream mode: continuously process lines from stdin
    while let line = readLine() {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { continue }
        if trimmed == "quit" || trimmed == "exit" { break }
        if let data = trimmed.data(using: .utf8),
           let req = try? JSONDecoder().decode(RequestOp.self, from: data) {
            handleRequest(req)
        } else {
            print("{\"ok\":false,\"error\":\"INVALID_JSON\"}")
            fflush(stdout)
        }
    }
}
