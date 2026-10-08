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
    let text: String?
    let requestId: String?
    let pid: pid_t?
    let identifier: String?
    let role: String?
    let timeoutMs: Int?
    let activate: Bool?
    let minimized: Bool?

    var targetApp: String {
        return app ?? appName ?? "Claude"
    }

    var payloadText: String {
        return text ?? value ?? ""
    }
}

struct SendTurnResponse: Codable {
    let ok: Bool
    let status: String
    let requestId: String?
    let error: String?
}

struct ObserveTurnResponse: Codable {
    let ok: Bool
    let status: String
    let requestId: String?
    let response: String?
    let latencyMs: Double?
    let error: String?
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
    // Priority 1: Exact localizedName match with regular activation policy
    if let exactRegular = apps.first(where: { app in
        guard app.activationPolicy == .regular else { return false }
        return app.localizedName?.caseInsensitiveCompare(name) == .orderedSame
    }) {
        return exactRegular
    }
    // Priority 2: Exact localizedName match regardless of activation policy
    if let exact = apps.first(where: { app in
        app.localizedName?.caseInsensitiveCompare(name) == .orderedSame
    }) {
        return exact
    }
    // Priority 3: Known bundle IDs
    let knownBundles: [String: [String]] = [
        "gemini": ["com.google.geminimacos"],
        "claude": ["com.anthropic.claudedesktop"],
        "chatgpt": ["com.openai.codex", "com.openai.chat"]
    ]
    if let bundles = knownBundles[name.lowercased()] {
        if let match = apps.first(where: { app in
            guard let b = app.bundleIdentifier?.lowercased() else { return false }
            return bundles.contains(b)
        }) {
            return match
        }
    }
    // Priority 4: Bundle contains name, preferring regular activation policy
    if let bundleRegular = apps.first(where: { app in
        guard app.activationPolicy == .regular else { return false }
        guard let bundle = app.bundleIdentifier?.lowercased() else { return false }
        return bundle.contains(name.lowercased()) && !bundle.contains("extension") && !bundle.contains("launcher")
    }) {
        return bundleRegular
    }
    // Priority 5: Any bundle contains name
    return apps.first { app in
        guard let bundle = app.bundleIdentifier?.lowercased() else { return false }
        return bundle.contains(name.lowercased())
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

func inspectAXApplicationState(name: String) -> [String: Any] {
    guard let app = findAppProcess(name: name) else {
        return ["ok": false, "error": "APP_NOT_RUNNING"]
    }

    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    func boolAttribute(_ attribute: String) -> Bool? {
        var value: AnyObject?
        guard AXUIElementCopyAttributeValue(axApp, attribute as CFString, &value) == .success else { return nil }
        return value as? Bool
    }

    func elementSummary(_ element: AXUIElement) -> [String: Any] {
        func stringAttribute(_ attribute: String) -> String? {
            var value: AnyObject?
            guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
            return value as? String
        }
        var minimized: AnyObject?
        let minResult = AXUIElementCopyAttributeValue(element, kAXMinimizedAttribute as CFString, &minimized)
        return [
            "title": stringAttribute(kAXTitleAttribute) ?? "",
            "role": stringAttribute(kAXRoleAttribute) ?? "",
            "subrole": stringAttribute(kAXSubroleAttribute) ?? "",
            "minimized": minResult == .success ? (minimized as? Bool ?? false) : false
        ]
    }

    var windowsValue: AnyObject?
    let windowsResult = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsValue)
    let windowCount = (windowsValue as? [AXUIElement])?.count ?? 0

    var mainWindowValue: AnyObject?
    let mainWindowResult = AXUIElementCopyAttributeValue(
        axApp, kAXMainWindowAttribute as CFString, &mainWindowValue
    )

    var focusedWindowValue: AnyObject?
    let focusedWindowResult = AXUIElementCopyAttributeValue(
        axApp, kAXFocusedWindowAttribute as CFString, &focusedWindowValue
    )

    var focusedUIValue: AnyObject?
    let focusedUIResult = AXUIElementCopyAttributeValue(
        axApp, kAXFocusedUIElementAttribute as CFString, &focusedUIValue
    )

    let primaryWindow = resolvePrimaryAXWindow(app)
    var result: [String: Any] = [
        "ok": true,
        "pid": app.processIdentifier,
        "hidden": app.isHidden,
        "windowsAttributeStatus": Int(windowsResult.rawValue),
        "windowCount": windowCount,
        "primaryWindowAvailable": primaryWindow != nil,
        "focusedWindowAttributeStatus": Int(focusedWindowResult.rawValue),
        "mainWindowAttributeStatus": Int(mainWindowResult.rawValue),
        "focusedUIElementAttributeStatus": Int(focusedUIResult.rawValue)
    ]

    if mainWindowResult == .success, let mainWindowValue {
        let mainWindow = mainWindowValue as! AXUIElement
        result["mainWindow"] = elementSummary(mainWindow)
    } else {
        result["mainWindow"] = NSNull()
    }

    if focusedWindowResult == .success, let focusedWindowValue {
        let focusedWindow = focusedWindowValue as! AXUIElement
        result["focusedWindow"] = elementSummary(focusedWindow)
    } else {
        result["focusedWindow"] = NSNull()
    }

    if focusedUIResult == .success, let focusedUIValue {
        let focusedUI = focusedUIValue as! AXUIElement
        result["focusedUIElement"] = elementSummary(focusedUI)
    } else {
        result["focusedUIElement"] = NSNull()
    }

    if let frontmost = boolAttribute(kAXFrontmostAttribute) {
        result["frontmost"] = frontmost
    }
    if let hidden = boolAttribute(kAXHiddenAttribute) {
        result["axHidden"] = hidden
    }

    return result
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

    if windowCount == 0 {
        var mainWindowValue: AnyObject?
        if AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute as CFString, &mainWindowValue) == .success,
           let mainWindow = mainWindowValue {
            let win = mainWindow as! AXUIElement
            var titleVal: AnyObject?
            let titleStr: String
            if AXUIElementCopyAttributeValue(win, kAXTitleAttribute as CFString, &titleVal) == .success,
               let str = titleVal as? String {
                titleStr = str
            } else {
                titleStr = "\(name) Window"
            }
            windowTitles.append(titleStr)

            var minVal: AnyObject?
            var isMin = false
            if AXUIElementCopyAttributeValue(win, kAXMinimizedAttribute as CFString, &minVal) == .success,
               let b = minVal as? Bool {
                isMin = b
            }

            var mainVal: AnyObject?
            var isMain = true
            if AXUIElementCopyAttributeValue(win, kAXMainAttribute as CFString, &mainVal) == .success,
               let b = mainVal as? Bool {
                isMain = b
            }

            windowDetails.append(WindowInfo(title: titleStr, minimized: isMin, main: isMain))
            windowCount = 1
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
    // Electron/WebKit applications may expose only window chrome until enhanced
    // accessibility is enabled. This remains within the user-authorized AX API.
    _ = AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)

    let (_, resolvedWindow) = resolveWindow(name, activate: false)
    guard let mainWin = resolvedWindow else {
        return ElementsResponse(ok: false, app: name, pid: pid, elements: [], error: "NO_ACCESSIBLE_WINDOW")
    }

    var elements: [ElementInfo] = []

    func walk(_ element: AXUIElement, depth: Int) {
        if depth > 60 || elements.count >= 2000 { return }

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
        if role == "AXTextArea" || role == "AXTextField" || role == "AXButton" ||
           role == "AXStaticText" || role == "AXHeading" || role == "AXRow" ||
           role == "AXWebArea" || role == "AXGroup" || (idStr != nil && !idStr!.isEmpty) {
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

func setAppMinimized(name: String, minimized: Bool) -> SimpleResponse {
    let (app, maybeWin) = resolveWindow(name, activate: false)
    guard app != nil else {
        return SimpleResponse(ok: false, status: "APP_NOT_RUNNING", details: nil)
    }
    guard let win = maybeWin else {
        return SimpleResponse(ok: false, status: "NO_WINDOW", details: nil)
    }
    let result = AXUIElementSetAttributeValue(
        win,
        kAXMinimizedAttribute as CFString,
        minimized ? kCFBooleanTrue : kCFBooleanFalse
    )
    return SimpleResponse(ok: result == .success, status: result == .success ? "MINIMIZED_STATE_SET" : "MINIMIZE_FAILED", details: nil)
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
nonisolated(unsafe) var activeObserver: AXObserver? = nil
nonisolated(unsafe) var activeRunLoopSource: CFRunLoopSource? = nil
nonisolated(unsafe) var cachedChatGPTWindow: AXUIElement? = nil

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

func sendPromptToClaude(name: String, text: String, requestId: String?) -> SendTurnResponse {
    let (maybeApp, maybeWin) = resolveWindow(name, activate: true)
    guard let app = maybeApp else {
        return SendTurnResponse(ok: false, status: "APP_NOT_RUNNING", requestId: requestId, error: "Application \(name) is not running")
    }
    guard let win = maybeWin else {
        return SendTurnResponse(ok: false, status: "NO_WINDOW", requestId: requestId, error: "No open window found for \(name)")
    }

    func findInput(_ el: AXUIElement) -> AXUIElement? {
        var roleVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
        let role = (roleVal as? String) ?? ""
        if role == "AXTextArea" { return el }
        var childrenVal: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenVal) == .success,
           let children = childrenVal as? [AXUIElement] {
            for c in children {
                if let found = findInput(c) { return found }
            }
        }
        return nil
    }

    func findSendBtn(_ el: AXUIElement) -> AXUIElement? {
        var descVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXDescriptionAttribute as CFString, &descVal)
        let desc = ((descVal as? String) ?? "").lowercased()
        var titleVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXTitleAttribute as CFString, &titleVal)
        let title = ((titleVal as? String) ?? "").lowercased()
        if desc == "send message" || desc == "send" || title == "send" || title == "send message" { return el }
        var childrenVal: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenVal) == .success,
           let children = childrenVal as? [AXUIElement] {
            for c in children {
                if let found = findSendBtn(c) { return found }
            }
        }
        return nil
    }

    guard let input = findInput(win) else {
        return SendTurnResponse(ok: false, status: "INPUT_NOT_FOUND", requestId: requestId, error: "Prompt textarea not found")
    }

    let setErr = AXUIElementSetAttributeValue(input, kAXValueAttribute as CFString, text as CFTypeRef)
    guard setErr == .success else {
        return SendTurnResponse(ok: false, status: "VALUE_SET_FAILED", requestId: requestId, error: "AXError \(setErr.rawValue)")
    }

    var sendBtn: AXUIElement? = nil
    for _ in 1...10 {
        usleep(100_000) // 100ms
        if let btn = findSendBtn(win) {
            sendBtn = btn
            break
        }
    }

    guard let btn = sendBtn else {
        return SendTurnResponse(ok: false, status: "SEND_BUTTON_NOT_FOUND", requestId: requestId, error: "Send button did not become available")
    }

    let pressErr = AXUIElementPerformAction(btn, kAXPressAction as CFString)
    guard pressErr == .success else {
        return SendTurnResponse(ok: false, status: "PRESS_FAILED", requestId: requestId, error: "AXError \(pressErr.rawValue)")
    }

    return SendTurnResponse(ok: true, status: "SUBMITTED", requestId: requestId, error: nil)
}

func captureTextSnapshot(name: String) -> [String] {
    let (_, maybeWin) = resolveWindow(name, activate: false)
    guard let win = maybeWin else { return [] }

    var texts: [String] = []
    func collect(_ el: AXUIElement, depth: Int) {
        if depth > 20 { return }
        var roleVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
        let role = (roleVal as? String) ?? ""
        if role == "AXStaticText" || role == "AXHeading" || role == "AXTextArea" || role == "AXTextField" {
            var valueVal: AnyObject?
            if AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &valueVal) == .success,
               let s = valueVal as? String, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                texts.append(s)
            }
        }
        var childrenVal: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenVal) == .success,
           let children = childrenVal as? [AXUIElement] {
            for child in children { collect(child, depth: depth + 1) }
        }
    }
    collect(win, depth: 0)
    return texts
}

func extractLatestClaudeResponse(_ raw: String, requestId: String?) -> String? {
    guard !raw.isEmpty else { return nil }

    var source = raw

    // Correlation is mandatory for live desktop delivery. The accessibility
    // tree contains the submitted user marker followed by Claude's response
    // heading/body. Never fall back to an arbitrary older "Claude responded:"
    // node because that can silently return a stale turn.
    if let requestId {
        let marker = "[AB:\(requestId)]"
        guard let markerRange = source.range(of: marker) else {
            return nil
        }
        source = String(source[markerRange.upperBound...])
    }

    guard let responseRange = source.range(of: "Claude responded:", options: .caseInsensitive) else {
        return nil
    }

    var response = String(source[responseRange.upperBound...])

    // Keep only the response belonging to this assistant turn. Claude exposes
    // subsequent turns as another "You said:" / "Claude responded:" pair.
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

        // Electron may expose both an accessible heading and rendered body.
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

func sendAndObserveClaude(name: String, text: String, requestId: String?, timeoutMs: Int) -> ObserveTurnResponse {
    // CRITICAL: establish the response baseline BEFORE pressing Send.
    // This closes the race where a fast Claude response finishes before a
    // separate observeResponse invocation has captured its baseline.
    let baseline = captureTextSnapshot(name: name)
    let sent = sendPromptToClaude(name: name, text: text, requestId: requestId)
    guard sent.ok else {
        return ObserveTurnResponse(
            ok: false,
            status: sent.status,
            requestId: requestId,
            response: nil,
            latencyMs: nil,
            error: sent.error
        )
    }
    return observeResponseFromClaude(
        name: name,
        requestId: requestId,
        timeoutMs: timeoutMs,
        baselineTexts: baseline
    )
}

func observeResponseFromClaude(name: String, requestId: String?, timeoutMs: Int, baselineTexts: [String]? = nil) -> ObserveTurnResponse {
    let (maybeApp, maybeWin) = resolveWindow(name, activate: false)
    guard maybeApp != nil else {
        return ObserveTurnResponse(ok: false, status: "APP_NOT_RUNNING", requestId: requestId, response: nil, latencyMs: nil, error: "Application is not running")
    }
    guard let win = maybeWin else {
        return ObserveTurnResponse(ok: false, status: "NO_WINDOW", requestId: requestId, response: nil, latencyMs: nil, error: "No window found")
    }

    let start = Date()
    let maxDuration = Double(timeoutMs > 0 ? timeoutMs : 30000) / 1000.0

    // Collect all text from the AX tree, depth up to 20
    func collectAllText(_ el: AXUIElement, depth: Int, texts: inout [String]) {
        if depth > 60 { return }
        var roleVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
        let role = (roleVal as? String) ?? ""
        if role == "AXStaticText" || role == "AXHeading" || role == "AXTextArea" || role == "AXTextField" {
            var valVal: AnyObject?
            if AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &valVal) == .success,
               let s = valVal as? String, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                texts.append(s)
            }
        }
        var childrenVal: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenVal) == .success,
           let children = childrenVal as? [AXUIElement] {
            for c in children { collectAllText(c, depth: depth + 1, texts: &texts) }
        }
    }

    // Detect generation in progress (stop/cancel button presence)
    func checkGenerating(_ el: AXUIElement) -> Bool {
        var roleVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
        if (roleVal as? String) == "AXButton" {
            var descVal: AnyObject?
            AXUIElementCopyAttributeValue(el, kAXDescriptionAttribute as CFString, &descVal)
            let desc = ((descVal as? String) ?? "").lowercased()
            var titleVal: AnyObject?
            AXUIElementCopyAttributeValue(el, kAXTitleAttribute as CFString, &titleVal)
            let title = ((titleVal as? String) ?? "").lowercased()
            if desc.contains("stop") || title.contains("stop") || desc.contains("cancel") || title.contains("cancel") {
                return true
            }
        }
        var childrenVal: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenVal) == .success,
           let children = childrenVal as? [AXUIElement] {
            for c in children { if checkGenerating(c) { return true } }
        }
        return false
    }

    // The baseline is still captured before submission to preserve the
    // send/observe ordering guarantee. Correlation itself is now performed
    // against the complete live AX tree so historical nodes cannot shadow the
    // current request.
    if let providedBaseline = baselineTexts {
        _ = providedBaseline
    } else {
        var captured: [String] = []
        collectAllText(win, depth: 0, texts: &captured)
        _ = captured
    }

    var sawGenerating = false
    var lastCorrelatedResponse = ""
    var stableResponseRounds = 0

    while Date().timeIntervalSince(start) < maxDuration {
        usleep(300_000)

        let generating = checkGenerating(win)
        if generating {
            sawGenerating = true
            stableResponseRounds = 0
        }

        var snapshot: [String] = []
        collectAllText(win, depth: 0, texts: &snapshot)

        // IMPORTANT: parse the COMPLETE current AX tree, not only values that
        // differ from the baseline. Claude can reuse/accessibly replace nodes,
        // and Set-based baseline subtraction can discard the exact correlated
        // heading/body needed to identify the current response.
        let rawSnapshot = snapshot.joined(separator: "\n")
        if let extracted = extractLatestClaudeResponse(rawSnapshot, requestId: requestId),
           !extracted.isEmpty {
            if extracted == lastCorrelatedResponse {
                stableResponseRounds += 1
            } else {
                lastCorrelatedResponse = extracted
                stableResponseRounds = 0
            }

            // Require the response to settle. If Claude exposes a stop/cancel
            // control, completion is only accepted after it disappears. If no
            // such control is exposed, two identical observations provide the
            // conservative completion signal.
            if (!generating && (sawGenerating || stableResponseRounds >= 2)) {
                let latency = Date().timeIntervalSince(start) * 1000.0
                return ObserveTurnResponse(
                    ok: true,
                    status: "COMPLETED",
                    requestId: requestId,
                    response: extracted,
                    latencyMs: latency,
                    error: nil
                )
            }
        }
    }

    // Final reconciliation uses the COMPLETE current AX tree. Never return an
    // unrelated historical response merely because it is visible in Claude.
    var finalTexts: [String] = []
    collectAllText(win, depth: 0, texts: &finalTexts)
    let finalRaw = finalTexts.joined(separator: "\n")

    if let extracted = extractLatestClaudeResponse(finalRaw, requestId: requestId),
       !extracted.isEmpty {
        let latency = Date().timeIntervalSince(start) * 1000.0
        return ObserveTurnResponse(
            ok: true,
            status: "COMPLETED_RECONCILED",
            requestId: requestId,
            response: extracted,
            latencyMs: latency,
            error: nil
        )
    }

    if finalRaw.contains(requestId.map { "[AB:\($0)]" } ?? "") {
        return ObserveTurnResponse(
            ok: false,
            status: "RESPONSE_INCOMPLETE",
            requestId: requestId,
            response: nil,
            latencyMs: nil,
            error: "Claude accepted the correlated request but no correlated assistant response was observed"
        )
    }

    return ObserveTurnResponse(
        ok: false,
        status: "CORRELATION_NOT_FOUND",
        requestId: requestId,
        response: nil,
        latencyMs: nil,
        error: "Claude response correlation marker was not found in the live accessibility tree"
    )
}

// ============================================================
// Dedicated autonomous send + observe for Google Gemini Desktop
// (com.google.GeminiMacOS)
// Targets the native composer AXTextArea ("What's next?"),
// the submit button (identifier: "send_button", description: "Submit"),
// and extracts the generated model response from the conversation rows.
// ============================================================

func findGeminiApp() -> NSRunningApplication? {
    return findAppProcess(name: "Gemini")
}

func resolveGeminiWindow(_ app: NSRunningApplication) -> AXUIElement? {
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    _ = AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)

    var val: AnyObject?
    if AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute as CFString, &val) == .success, let w = val {
        return (w as! AXUIElement)
    }
    if AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &val) == .success, let w = val {
        return (w as! AXUIElement)
    }
    if AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &val) == .success,
       let wins = val as? [AXUIElement], let w = wins.first {
        return w
    }
    return nil
}

func findGeminiComposer(_ win: AXUIElement) -> AXUIElement? {
    var found: AXUIElement? = nil
    func walk(_ el: AXUIElement, _ depth: Int) {
        if depth > 60 || found != nil { return }
        var roleVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
        if (roleVal as? String) == "AXTextArea" {
            var descVal: AnyObject?
            AXUIElementCopyAttributeValue(el, kAXDescriptionAttribute as CFString, &descVal)
            let desc = (descVal as? String ?? "").lowercased()
            if desc.contains("what's next") || desc.contains("whats next") || desc.contains("gemini") || found == nil {
                found = el
                if desc.contains("what's next") || desc.contains("whats next") { return }
            }
        }
        var childrenVal: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenVal) == .success,
           let children = childrenVal as? [AXUIElement] {
            for c in children {
                walk(c, depth + 1)
                if found != nil { return }
            }
        }
    }
    walk(win, 0)
    return found
}

func findGeminiSendButton(_ win: AXUIElement) -> AXUIElement? {
    var found: AXUIElement? = nil
    func walk(_ el: AXUIElement, _ depth: Int) {
        if depth > 60 || found != nil { return }
        var roleVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
        if (roleVal as? String) == "AXButton" {
            var idVal: AnyObject?
            AXUIElementCopyAttributeValue(el, "AXIdentifier" as CFString, &idVal)
            let ident = (idVal as? String ?? "").lowercased()
            var descVal: AnyObject?
            AXUIElementCopyAttributeValue(el, kAXDescriptionAttribute as CFString, &descVal)
            let desc = (descVal as? String ?? "").lowercased()

            if ident == "send_button" || desc == "submit" || desc == "send" || desc == "send message" {
                var enVal: AnyObject?
                if AXUIElementCopyAttributeValue(el, kAXEnabledAttribute as CFString, &enVal) == .success,
                   let en = enVal as? Bool, en {
                    found = el
                    return
                } else if enVal == nil {
                    found = el
                    return
                }
            }
        }
        var childrenVal: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenVal) == .success,
           let children = childrenVal as? [AXUIElement] {
            for c in children {
                walk(c, depth + 1)
                if found != nil { return }
            }
        }
    }
    walk(win, 0)
    return found
}

func sendPromptToGemini(name: String = "Gemini", text: String, requestId: String?) -> SendTurnResponse {
    guard let app = findGeminiApp() else {
        return SendTurnResponse(ok: false, status: "APP_NOT_RUNNING", requestId: requestId, error: "Application Gemini is not running")
    }

    guard let win = resolveGeminiWindow(app) else {
        return SendTurnResponse(ok: false, status: "NO_WINDOW", requestId: requestId, error: "No open window found for Gemini")
    }

    guard let composer = findGeminiComposer(win) else {
        return SendTurnResponse(ok: false, status: "INPUT_NOT_FOUND", requestId: requestId, error: "Prompt textarea not found in Gemini")
    }

    let setErr = AXUIElementSetAttributeValue(composer, kAXValueAttribute as CFString, text as CFTypeRef)
    guard setErr == .success else {
        return SendTurnResponse(ok: false, status: "VALUE_SET_FAILED", requestId: requestId, error: "AXError \(setErr.rawValue)")
    }

    var sendBtn: AXUIElement? = nil
    for _ in 1...20 {
        usleep(100_000) // 100ms
        if let btn = findGeminiSendButton(win) {
            sendBtn = btn
            break
        }
    }

    guard let btn = sendBtn else {
        return SendTurnResponse(ok: false, status: "SEND_BUTTON_NOT_FOUND", requestId: requestId, error: "Send button did not become available")
    }

    let pressErr = AXUIElementPerformAction(btn, kAXPressAction as CFString)
    guard pressErr == .success else {
        return SendTurnResponse(ok: false, status: "PRESS_FAILED", requestId: requestId, error: "AXError \(pressErr.rawValue)")
    }

    return SendTurnResponse(ok: true, status: "SUBMITTED", requestId: requestId, error: nil)
}

func findGeminiRows(_ win: AXUIElement) -> [AXUIElement] {
    var rows: [AXUIElement] = []
    func walk(_ el: AXUIElement, _ depth: Int) {
        if depth > 40 { return }
        var roleVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
        if (roleVal as? String) == "AXRow" {
            rows.append(el)
        }
        var childrenVal: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenVal) == .success,
           let children = childrenVal as? [AXUIElement] {
            for c in children { walk(c, depth + 1) }
        }
    }
    walk(win, 0)
    return rows
}

func extractTextFromGeminiRow(_ row: AXUIElement) -> (text: String, isComplete: Bool) {
    var copyBtnText = ""
    var hasCopyBtn = false
    func findCopyBtn(_ el: AXUIElement) {
        var roleVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
        if (roleVal as? String) == "AXButton" {
            var idVal: AnyObject?
            AXUIElementCopyAttributeValue(el, "AXIdentifier" as CFString, &idVal)
            if (idVal as? String) == "copy-button" {
                hasCopyBtn = true
                var dVal: AnyObject?
                AXUIElementCopyAttributeValue(el, kAXDescriptionAttribute as CFString, &dVal)
                var vVal: AnyObject?
                AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &vVal)
                let d = (dVal as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let v = (vVal as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if d.count > 15 && d != "Copy response" { copyBtnText = d }
                else if v.count > 15 && v != "Copy response" { copyBtnText = v }
            }
        }
        var cv: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
           let kids = cv as? [AXUIElement] {
            for k in kids { findCopyBtn(k) }
        }
    }
    findCopyBtn(row)
    if !copyBtnText.isEmpty {
        return (copyBtnText, true)
    }

    var pieces: [String] = []
    let skipTokens: Set<String> = [
        "expand_more", "search_activity", "build", "Agent Bridge",
        "check_circle", "Complete", "Approved", "Show all, expand_more",
        "Good response", "Bad response", "Copy response", "More actions",
        "Gemini is AI and can make mistakes."
    ]
    func collect(_ el: AXUIElement) {
        var roleVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
        let role = (roleVal as? String) ?? ""
        if role == "AXStaticText" || role == "AXHeading" || role == "AXTextArea" {
            var valVal: AnyObject?
            AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &valVal)
            var descVal: AnyObject?
            AXUIElementCopyAttributeValue(el, kAXDescriptionAttribute as CFString, &descVal)
            let v = (valVal as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let d = (descVal as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let text = !v.isEmpty ? v : d
            if !text.isEmpty && !skipTokens.contains(text) && !pieces.contains(text) {
                pieces.append(text)
            }
        }
        var cv: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
           let kids = cv as? [AXUIElement] {
            for k in kids { collect(k) }
        }
    }
    collect(row)
    let joined = pieces.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    return (joined, hasCopyBtn)
}

func checkGeminiGenerating(_ win: AXUIElement) -> Bool {
    var isGenerating = false
    func walk(_ el: AXUIElement, _ depth: Int) {
        if depth > 40 || isGenerating { return }
        var roleVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
        if (roleVal as? String) == "AXButton" {
            var descVal: AnyObject?
            AXUIElementCopyAttributeValue(el, kAXDescriptionAttribute as CFString, &descVal)
            let desc = ((descVal as? String) ?? "").lowercased()
            var idVal: AnyObject?
            AXUIElementCopyAttributeValue(el, "AXIdentifier" as CFString, &idVal)
            let ident = ((idVal as? String) ?? "").lowercased()
            if desc.contains("stop") || ident.contains("stop") || desc.contains("cancel") {
                isGenerating = true
                return
            }
        }
        var cv: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
           let kids = cv as? [AXUIElement] {
            for k in kids { walk(k, depth + 1) }
        }
    }
    walk(win, 0)
    return isGenerating
}

func extractLatestGeminiResponse(_ win: AXUIElement, requestId: String?) -> (response: String?, isComplete: Bool) {
    let rows = findGeminiRows(win)
    guard !rows.isEmpty else { return (nil, false) }

    if let requestId, !requestId.isEmpty {
        let marker = "[AB:\(requestId)]"
        for i in 0..<rows.count {
            let rowText = extractTextFromGeminiRow(rows[i]).text
            if rowText.contains(marker) {
                if i + 1 < rows.count {
                    let asstRow = rows[i + 1]
                    let (asstText, isComplete) = extractTextFromGeminiRow(asstRow)
                    if !asstText.isEmpty {
                        return (asstText, isComplete)
                    }
                }
                return (nil, false)
            }
        }
        return (nil, false)
    }

    for i in (0..<rows.count).reversed() {
        let (rowText, isComplete) = extractTextFromGeminiRow(rows[i])
        if !rowText.isEmpty && !rowText.contains("Gemini is AI and can make mistakes") {
            return (rowText, isComplete)
        }
    }
    return (nil, false)
}

func observeResponseFromGemini(name: String = "Gemini", requestId: String?, timeoutMs: Int) -> ObserveTurnResponse {
    guard let app = findGeminiApp() else {
        return ObserveTurnResponse(ok: false, status: "APP_NOT_RUNNING", requestId: requestId, response: nil, latencyMs: nil, error: "Application Gemini is not running")
    }

    guard let win = resolveGeminiWindow(app) else {
        return ObserveTurnResponse(ok: false, status: "NO_WINDOW", requestId: requestId, response: nil, latencyMs: nil, error: "No window found for Gemini")
    }

    let start = Date()
    let maxDuration = Double(timeoutMs > 0 ? timeoutMs : 60000) / 1000.0

    var sawGenerating = false
    var lastResponse = ""
    var stableRounds = 0

    while Date().timeIntervalSince(start) < maxDuration {
        usleep(300_000)

        let generating = checkGeminiGenerating(win)
        if generating {
            sawGenerating = true
            stableRounds = 0
        }

        let (extracted, isComplete) = extractLatestGeminiResponse(win, requestId: requestId)
        if let response = extracted, !response.isEmpty {
            if response == lastResponse {
                stableRounds += 1
            } else {
                lastResponse = response
                stableRounds = 0
            }

            if !generating && (isComplete || sawGenerating || stableRounds >= 2) {
                let latency = Date().timeIntervalSince(start) * 1000.0
                return ObserveTurnResponse(
                    ok: true,
                    status: "COMPLETED",
                    requestId: requestId,
                    response: response,
                    latencyMs: latency,
                    error: nil
                )
            }
        }
    }

    let (finalExtracted, _) = extractLatestGeminiResponse(win, requestId: requestId)
    if let response = finalExtracted, !response.isEmpty {
        let latency = Date().timeIntervalSince(start) * 1000.0
        return ObserveTurnResponse(
            ok: true,
            status: "COMPLETED_RECONCILED",
            requestId: requestId,
            response: response,
            latencyMs: latency,
            error: nil
        )
    }

    return ObserveTurnResponse(
        ok: false,
        status: "TIMEOUT",
        requestId: requestId,
        response: nil,
        latencyMs: Date().timeIntervalSince(start) * 1000.0,
        error: "Timed out waiting for Gemini model response"
    )
}

func sendAndObserveGemini(name: String = "Gemini", text: String, requestId: String?, timeoutMs: Int) -> ObserveTurnResponse {
    let sent = sendPromptToGemini(name: name, text: text, requestId: requestId)
    guard sent.ok else {
        return ObserveTurnResponse(
            ok: false,
            status: sent.status,
            requestId: requestId,
            response: nil,
            latencyMs: nil,
            error: sent.error
        )
    }
    return observeResponseFromGemini(
        name: name,
        requestId: requestId,
        timeoutMs: timeoutMs
    )
}

// ============================================================
// Profile-aware autonomous send + observe for desktop LLM clients.
// Claude and Gemini use dedicated paths; ChatGPT uses the generic
// path below (composer identified by role, "Send" button, marker-based
// response correlation over the complete live AX tree).
// ============================================================

func axString(_ el: AXUIElement, _ attr: String) -> String {
    var v: AnyObject?
    if AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success, let x = v as? String { return x }
    return ""
}

func axBool(_ el: AXUIElement, _ attr: String) -> Bool {
    var v: AnyObject?
    if AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success, let x = v as? Bool { return x }
    return false
}

func profileFor(_ name: String) -> String {
    let lower = name.lowercased()
    if lower.contains("chatgpt") { return "chatgpt" }
    if lower.contains("gemini") { return "gemini" }
    return "claude"
}

// Resolve the target application and its first accessible window, activating
// and unhiding the app when requested. Returns (app, window?) without throwing.
func resolvePrimaryAXWindow(_ app: NSRunningApplication) -> AXUIElement? {
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute as CFString, &value) == .success,
          let value else {
        return nil
    }
    return (value as! AXUIElement)
}

func resolveWindow(_ name: String, activate: Bool) -> (NSRunningApplication?, AXUIElement?) {
    guard let app = findAppProcess(name: name) else { return (nil, nil) }
    if activate {
        app.unhide()
        _ = app.activate(options: [])
    }
    for _ in 1...12 {
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        if !activate, let primary = resolvePrimaryAXWindow(app) {
            return (app, primary)
        }
        _ = AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        _ = AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        var winVal: AnyObject?
        if AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &winVal) == .success,
           let wins = winVal as? [AXUIElement], let w = wins.first {
            if name.caseInsensitiveCompare("ChatGPT") == .orderedSame { cachedChatGPTWindow = w }
             return (app, w)
        }
        if !activate && name.caseInsensitiveCompare("ChatGPT") == .orderedSame, let cached = cachedChatGPTWindow {
            return (app, cached)
        }
        var mainValue: AnyObject?
        if AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute as CFString, &mainValue) == .success,
           let mainWindow = mainValue {
            return (app, (mainWindow as! AXUIElement))
        }
        var focusedValue: AnyObject?
        if AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &focusedValue) == .success,
           let focusedWindow = focusedValue {
            return (app, (focusedWindow as! AXUIElement))
        }
        usleep(250_000)
    }
    return (app, nil)
}

// Discover the message composer/input. Enforces an unambiguous single
// candidate; never blindly guesses a random text field.
func findComposerElement(_ win: AXUIElement, profile: String) -> AXUIElement? {
    var candidates: [AXUIElement] = []
    var preferred: AXUIElement? = nil
    func walk(_ el: AXUIElement, _ depth: Int) {
        if depth > 90 || candidates.count > 8 { return }
        let role = axString(el, kAXRoleAttribute)
        if role == "AXTextArea" || role == "AXTextField" {
            let desc = axString(el, kAXDescriptionAttribute).lowercased()
            if profile == "chatgpt" && desc.contains("ask chatgpt") { preferred = el; return }
            if axBool(el, kAXEnabledAttribute) { candidates.append(el) }
        }
        var cv: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
           let kids = cv as? [AXUIElement] {
            for k in kids { walk(k, depth + 1) }
        }
    }
    walk(win, 0)
    if let p = preferred { return p }
    if candidates.count == 1 { return candidates[0] }
    return nil
}

// Discover the enabled Send/Submit control by accessible title or description.
func findSendButton(_ win: AXUIElement) -> AXUIElement? {
    let names: Set<String> = ["send", "send message", "submit"]
    func walk(_ el: AXUIElement, _ depth: Int) -> AXUIElement? {
        if depth > 90 { return nil }
        if axString(el, kAXRoleAttribute) == "AXButton" {
            let title = axString(el, kAXTitleAttribute).lowercased()
            let desc = axString(el, kAXDescriptionAttribute).lowercased()
            if (names.contains(title) || names.contains(desc)) && axBool(el, kAXEnabledAttribute) {
                return el
            }
        }
        var cv: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
           let kids = cv as? [AXUIElement] {
            for k in kids { if let f = walk(k, depth + 1) { return f } }
        }
        return nil
    }
    return walk(win, 0)
}

// Exact AX button activation used for explicit project/chat routing.
// It never activates or unhides the application.
func pressButtonByExactTitle(_ name: String, title expectedTitle: String) -> SimpleResponse {
    let (app, maybeWin) = resolveWindow(name, activate: false)
    guard app != nil else {
        return SimpleResponse(ok: false, status: "APP_NOT_RUNNING", details: nil)
    }
    guard let win = maybeWin else {
        return SimpleResponse(ok: false, status: "NO_WINDOW", details: nil)
    }

    func walk(_ el: AXUIElement, _ depth: Int) -> AXUIElement? {
        if depth > 90 { return nil }
        if axString(el, kAXRoleAttribute) == "AXButton" {
            let title = axString(el, kAXTitleAttribute)
            let desc = axString(el, kAXDescriptionAttribute)
            if (title == expectedTitle || desc == expectedTitle) && axBool(el, kAXEnabledAttribute) {
                return el
            }
        }
        var cv: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
           let kids = cv as? [AXUIElement] {
            for k in kids {
                if let found = walk(k, depth + 1) { return found }
            }
        }
        return nil
    }

    guard let button = walk(win, 0) else {
        return SimpleResponse(ok: false, status: "BUTTON_NOT_FOUND", details: nil)
    }
    let result = AXUIElementPerformAction(button, kAXPressAction as CFString)
    return SimpleResponse(ok: result == .success, status: result == .success ? "PRESSED" : "PRESS_FAILED", details: nil)
}

// Detect an in-progress generation (Stop control, or "is responding" label).
func isGenerating(_ win: AXUIElement, profile: String) -> Bool {
    func walk(_ el: AXUIElement, _ depth: Int) -> Bool {
        if depth > 90 { return false }
        let role = axString(el, kAXRoleAttribute)
        if role == "AXButton" {
            let d = axString(el, kAXDescriptionAttribute).lowercased()
            let t = axString(el, kAXTitleAttribute).lowercased()
            if d.contains("stop") || t.contains("stop") { return true }
        }
        if role == "AXStaticText" || role == "AXHeading" {
            if axString(el, kAXValueAttribute).contains("is responding") { return true }
        }
        var cv: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
           let kids = cv as? [AXUIElement] {
            for k in kids { if walk(k, depth + 1) { return true } }
        }
        return false
    }
    return walk(win, 0)
}

// Response extraction for ChatGPT. Correlates strictly on the request marker:
// the newest node containing [AB:requestId] is the submitted user turn, and the
// assistant text is the run of nodes that follows, terminated at known UI
// chrome. Never returns an unrelated/historical response.
func extractChatGptResponse(_ texts: [String], requestId: String?) -> String? {
    guard let requestId else { return nil }
    let marker = "[AB:\(requestId)]"
    var markerIdx = -1
    for (i, t) in texts.enumerated() where t.contains(marker) { markerIdx = i }
    guard markerIdx >= 0 else { return nil }

    // The AX tree represents each turn as:
    //   You said: -> submitted text -> ChatGPT said: -> assistant text
    // Start extraction only after the assistant heading. This prevents the
    // submitted prompt itself from ever being mistaken for the answer.
    var assistantHeadingIndex: Int?
    var i = markerIdx + 1
    while i < texts.count {
        let t = texts[i].trimmingCharacters(in: .whitespacesAndNewlines)
        if t.lowercased() == "chatgpt said:" {
            assistantHeadingIndex = i
            break
        }
        i += 1
    }
    guard let heading = assistantHeadingIndex else { return nil }

    let terminators: Set<String> = [
        "ask chatgpt",
        "response complete",
        "chatgpt can make mistakes. check important info.",
        "latest response",
        "you said:",
        "chatgpt said:"
    ]

    var parts: [String] = []
    i = heading + 1
    while i < texts.count {
        let t = texts[i].trimmingCharacters(in: .whitespacesAndNewlines)
        i += 1
        if t.isEmpty { continue }
        let low = t.lowercased()
        if terminators.contains(low) { break }
        if low == "copy" || low == "share" || low == "copy message" || low == "share prompt" || low == "edit message" || low == "rate response" {
            continue
        }
        if low.hasPrefix("worked for ") || low.hasPrefix("thought for ") || low.hasPrefix("thinking for ") || low.hasPrefix("reasoned for ") {
            continue
        }
        parts.append(t)
    }

    let joined = parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    return joined.isEmpty ? nil : joined
}

func extractCorrelatedResponse(_ texts: [String], requestId: String?, profile: String) -> String? {
    if profile == "claude" {
        return extractLatestClaudeResponse(texts.joined(separator: "\n"), requestId: requestId)
    }
    return extractChatGptResponse(texts, requestId: requestId)
}

func collectTextValues(_ win: AXUIElement) -> [String] {
    var texts: [String] = []
    let skipRoles: Set<String> = ["AXScrollBar", "AXSplitter", "AXColorWell", "AXRuler", "AXProgressIndicator"]
    func walk(_ el: AXUIElement, _ depth: Int) {
        if depth > 90 { return }
        let role = axString(el, kAXRoleAttribute)
        if skipRoles.contains(role) { return }
        if role == "AXStaticText" || role == "AXHeading" || role == "AXTextArea" || role == "AXTextField" {
            let v = axString(el, kAXValueAttribute)
            if !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { texts.append(v) }
        }
        var cv: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
           let kids = cv as? [AXUIElement] {
            for k in kids { walk(k, depth + 1) }
        }
    }
    walk(win, 0)
    return texts
}

func sendPromptGeneric(name: String, text: String, requestId: String?, profile: String, activate: Bool = true) -> SendTurnResponse {
    let (app, maybeWin) = resolveWindow(name, activate: activate)
    guard app != nil else {
        return SendTurnResponse(ok: false, status: "APP_NOT_RUNNING", requestId: nil, error: "\(name) is not running")
    }
    guard let win = maybeWin else {
        return SendTurnResponse(ok: false, status: "NO_WINDOW", requestId: nil, error: "No accessible window for \(name)")
    }

    // AXRaise does not activate the application. For a fullscreen ChatGPT
    // worker on another Space, this can refresh the window's accessibility
    // surface without switching the user's Space or stealing foreground focus.
    if profile == "chatgpt" {
        _ = AXUIElementPerformAction(win, kAXRaiseAction as CFString)
        usleep(150_000)
    }

    guard let composer = findComposerElement(win, profile: profile) else {
        return SendTurnResponse(ok: false, status: "CHATGPT_COMPOSER_NOT_FOUND", requestId: nil, error: "No unambiguous composer element found")
    }

    let prefix = String(text.prefix(24))
    var setOk = false
    for attempt in 1...3 {
        _ = AXUIElementSetAttributeValue(composer, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        let setErr = AXUIElementSetAttributeValue(composer, kAXValueAttribute as CFString, text as CFTypeRef)
        if setErr != .success {
            _ = AXUIElementSetAttributeValue(composer, "AXSelectedText" as CFString, text as CFTypeRef)
        }
        usleep(250_000)
        // Re-resolve so a React re-render cannot leave us reading a stale node.
        if let w2 = resolveWindow(name, activate: false).1 ?? maybeWin,
           let c2 = findComposerElement(w2, profile: profile),
           axString(c2, kAXValueAttribute).contains(prefix) {
            setOk = true
            break
        }
        if setErr != .success && attempt == 3 && !setOk {
            return SendTurnResponse(ok: false, status: "VALUE_SET_FAILED", requestId: nil, error: "AXError \(setErr.rawValue)")
        }
    }
    if !setOk {
        return SendTurnResponse(ok: false, status: "VALUE_NOT_REGISTERED", requestId: nil, error: "Composer did not retain the submitted value")
    }

    var sendOk = false
    for _ in 1...20 {
        guard let w3 = resolveWindow(name, activate: false).1 ?? maybeWin else { usleep(150_000); continue }
        if let btn = findSendButton(w3) {
            if AXUIElementPerformAction(btn, kAXPressAction as CFString) == .success { sendOk = true; break }
        }
        usleep(150_000)
    }
    guard sendOk else {
        return SendTurnResponse(ok: false, status: "CHATGPT_SUBMISSION_FAILED", requestId: nil, error: "Send control could not be activated")
    }

    // Do not call a turn "submitted" merely because AXPress succeeded. In
    // background/fullscreen mode ChatGPT can expose the composer while the
    // action is still being processed. Require the composer to clear and the
    // correlation marker to appear in the conversation tree.
    let marker = requestId.map { "[AB:\($0)]" } ?? String(text.prefix(24))
    for attempt in 1...25 {
        if attempt > 1 {
            let sleepTime: useconds_t = attempt < 6 ? 50_000 : 100_000
            usleep(sleepTime)
        }
        guard let verifyWindow = resolveWindow(name, activate: false).1 ?? maybeWin else { continue }
        let composerValue = findComposerElement(verifyWindow, profile: profile).map { axString($0, kAXValueAttribute) } ?? ""
        let values = collectTextValues(verifyWindow)
        let markerInConversation = values.contains { $0.contains(marker) }
        let composerStillContainsRequest = composerValue.contains(marker) || composerValue.contains(String(text.prefix(24)))
        if markerInConversation && !composerStillContainsRequest {
            return SendTurnResponse(ok: true, status: "SUBMITTED", requestId: requestId, error: nil)
        }
    }

    return SendTurnResponse(
        ok: false,
        status: "SUBMISSION_NOT_REGISTERED",
        requestId: requestId,
        error: "Send action completed but ChatGPT did not register the request in the conversation"
    )
}

func observeResponseGeneric(name: String, requestId: String?, profile: String, timeoutMs: Int) -> ObserveTurnResponse {
    let (app, maybeWin) = resolveWindow(name, activate: false)
    guard app != nil else {
        return ObserveTurnResponse(ok: false, status: "APP_NOT_RUNNING", requestId: requestId, response: nil, latencyMs: nil, error: "Application is not running")
    }
    guard var win = maybeWin else {
        return ObserveTurnResponse(ok: false, status: "NO_WINDOW", requestId: requestId, response: nil, latencyMs: nil, error: "No accessible window")
    }

    let start = Date()
    let maxDuration = Double(timeoutMs > 0 ? timeoutMs : 30000) / 1000.0
    var lastResponse = ""
    var stableRounds = 0
    var sawMarker = false

    while Date().timeIntervalSince(start) < maxDuration {
        // Recover window if it momentarily disappears (e.g. during re-render).
        if let w = resolveWindow(name, activate: false).1 { win = w }

        let generating = isGenerating(win, profile: profile)
        if generating { stableRounds = 0 }

        let texts = collectTextValues(win)
        if let rid = requestId, texts.contains(where: { $0.contains("[AB:\(rid)]") }) { sawMarker = true }

        if let extracted = extractCorrelatedResponse(texts, requestId: requestId, profile: profile), !extracted.isEmpty {
            if extracted == lastResponse {
                stableRounds += 1
            } else {
                lastResponse = extracted
                stableRounds = 0
            }
            if !generating && stableRounds >= 1 {
                // Short adaptive confirmation check to avoid waiting an extra full 300ms cycle
                usleep(80_000)
                let recheckWin = resolveWindow(name, activate: false).1 ?? win
                let recheckGen = isGenerating(recheckWin, profile: profile)
                let recheckTexts = collectTextValues(recheckWin)
                if !recheckGen, let recheckExtracted = extractCorrelatedResponse(recheckTexts, requestId: requestId, profile: profile), recheckExtracted == extracted {
                    let latency = Date().timeIntervalSince(start) * 1000.0
                    return ObserveTurnResponse(ok: true, status: "COMPLETED", requestId: requestId, response: extracted, latencyMs: latency, error: nil)
                }
            }
        }

        let loopSleep: useconds_t = generating ? 80_000 : (sawMarker ? 100_000 : 60_000)
        usleep(loopSleep)
    }

    let finalTexts = collectTextValues(win)
    if let extracted = extractCorrelatedResponse(finalTexts, requestId: requestId, profile: profile), !extracted.isEmpty {
        let latency = Date().timeIntervalSince(start) * 1000.0
        return ObserveTurnResponse(ok: true, status: "COMPLETED_RECONCILED", requestId: requestId, response: extracted, latencyMs: latency, error: nil)
    }
    let markerPresent = requestId.map { rid in finalTexts.contains { $0.contains("[AB:\(rid)]") } } ?? false
    if sawMarker || markerPresent {
        return ObserveTurnResponse(ok: false, status: "CHATGPT_RESPONSE_TIMEOUT", requestId: requestId, response: nil, latencyMs: nil, error: "Request was accepted but no correlated assistant response was observed before timeout")
    }
    return ObserveTurnResponse(ok: false, status: "CHATGPT_RESPONSE_CORRELATION_FAILED", requestId: requestId, response: nil, latencyMs: nil, error: "Correlation marker was not found in the live accessibility tree")
}

func sendAndObserveGeneric(name: String, text: String, requestId: String?, profile: String, timeoutMs: Int, activate: Bool = true) -> ObserveTurnResponse {
    let sent = sendPromptGeneric(name: name, text: text, requestId: requestId, profile: profile, activate: activate)
    guard sent.ok else {
        return ObserveTurnResponse(ok: false, status: sent.status, requestId: requestId, response: nil, latencyMs: nil, error: sent.error)
    }
    return observeResponseGeneric(name: name, requestId: requestId, profile: profile, timeoutMs: timeoutMs)
}


func executeChatGPTJavaScript(_ javascript: String) -> [String: Any] {
    guard findAppProcess(name: "ChatGPT") != nil else {
        return ["ok": false, "error": "CHATGPT_NOT_RUNNING"]
    }

    let quote = String(Character(UnicodeScalar(34)!))
    let backslash = String(Character(UnicodeScalar(92)!))
    let newline = String(Character(UnicodeScalar(10)!))
    let carriageReturn = String(Character(UnicodeScalar(13)!))
    let escaped = javascript
        .replacingOccurrences(of: backslash, with: backslash + backslash)
        .replacingOccurrences(of: quote, with: backslash + quote)
        .replacingOccurrences(of: newline, with: backslash + "n")
        .replacingOccurrences(of: carriageReturn, with: backslash + "r")

    let source = "tell application " + quote + "ChatGPT" + quote + " to execute (active tab of window 1) javascript " + quote + escaped + quote
    guard let script = NSAppleScript(source: source) else {
        return ["ok": false, "error": "APPLESCRIPT_COMPILE_FAILED"]
    }

    var error: NSDictionary?
    let result = script.executeAndReturnError(&error)
    if let error {
        return ["ok": false, "error": "APPLESCRIPT_EXECUTION_FAILED", "details": String(describing: error)]
    }

    return [
        "ok": true,
        "result": result.stringValue ?? ""
    ]
}

func readChatGPTScriptingDefinition() -> [String: Any] {
    guard let app = findAppProcess(name: "ChatGPT"),
          let bundleURL = app.bundleURL else {
        return ["ok": false, "error": "CHATGPT_NOT_RUNNING"]
    }
    let url = bundleURL.appendingPathComponent("Contents/Resources/scripting.sdef")
    guard let data = try? Data(contentsOf: url),
          let content = String(data: data, encoding: .utf8) else {
        return ["ok": false, "error": "SCRIPTING_DEFINITION_NOT_FOUND"]
    }
    return ["ok": true, "path": url.path, "content": content]
}

func handleRequest(_ req: RequestOp) {
    let encoder = JSONEncoder()
    switch req.op {
    case "ping":
        print("{\"ok\":true,\"status\":\"pong\"}")
    case "chatgptExecuteJavaScript":
        if let data = try? JSONSerialization.data(withJSONObject: executeChatGPTJavaScript(req.payloadText)),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
    case "chatgptScriptingDefinition":
        if let data = try? JSONSerialization.data(withJSONObject: readChatGPTScriptingDefinition()),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
    case "chatgptPressButton":
        let resp = pressButtonByExactTitle(req.targetApp, title: req.payloadText)
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
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
    case "diagnostic":
        let resp = inspectAXApplicationState(name: req.targetApp)
        if let encoded = try? JSONSerialization.data(withJSONObject: resp),
           let str = String(data: encoded, encoding: .utf8) {
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
    case "setMinimized":
        let resp = setAppMinimized(name: req.targetApp, minimized: req.minimized ?? true)
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
    case "sendPrompt":
        let profile = profileFor(req.targetApp)
        let resp: SendTurnResponse
        if profile == "claude" {
            resp = sendPromptToClaude(name: req.targetApp, text: req.payloadText, requestId: req.requestId)
        } else if profile == "gemini" {
            resp = sendPromptToGemini(name: req.targetApp, text: req.payloadText, requestId: req.requestId)
        } else {
            resp = sendPromptGeneric(name: req.targetApp, text: req.payloadText, requestId: req.requestId, profile: profile, activate: req.activate ?? true)
        }
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    case "observeResponse":
        let timeout = req.timeoutMs ?? 30000
        let profile = profileFor(req.targetApp)
        let resp: ObserveTurnResponse
        if profile == "claude" {
            resp = observeResponseFromClaude(name: req.targetApp, requestId: req.requestId, timeoutMs: timeout)
        } else if profile == "gemini" {
            resp = observeResponseFromGemini(name: req.targetApp, requestId: req.requestId, timeoutMs: timeout)
        } else {
            resp = observeResponseGeneric(name: req.targetApp, requestId: req.requestId, profile: profile, timeoutMs: timeout)
        }
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    case "sendAndObserve":
        let timeout = req.timeoutMs ?? 30000
        let profile = profileFor(req.targetApp)
        let resp: ObserveTurnResponse
        if profile == "claude" {
            resp = sendAndObserveClaude(name: req.targetApp, text: req.payloadText, requestId: req.requestId, timeoutMs: timeout)
        } else if profile == "gemini" {
            resp = sendAndObserveGemini(name: req.targetApp, text: req.payloadText, requestId: req.requestId, timeoutMs: timeout)
        } else {
            resp = sendAndObserveGeneric(name: req.targetApp, text: req.payloadText, requestId: req.requestId, profile: profile, timeoutMs: timeout, activate: req.activate ?? true)
        }
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
