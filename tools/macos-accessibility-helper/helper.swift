import Foundation
import ApplicationServices
import AppKit

// Data structures for JSON communication over stdin/stdout
struct RequestOp: Codable {
    let op: String
    let app: String?
    let bundleId: String?
    let value: String?
    let requestId: String?
    let pid: pid_t?
}

struct InspectResponse: Codable {
    let ok: Bool
    let app: String
    let running: Bool
    let pid: pid_t?
    let windowCount: Int
    let windows: [String]
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
        return InspectResponse(ok: false, app: name, running: false, pid: nil, windowCount: 0, windows: [], error: "APP_NOT_RUNNING")
    }

    let pid = app.processIdentifier
    let axApp = AXUIElementCreateApplication(pid)

    var windowsValue: AnyObject?
    let result = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsValue)

    var windowTitles: [String] = []
    var windowCount = 0

    if result == .success, let windows = windowsValue as? [AXUIElement] {
        windowCount = windows.count
        for win in windows {
            var titleVal: AnyObject?
            if AXUIElementCopyAttributeValue(win, kAXTitleAttribute as CFString, &titleVal) == .success,
               let titleStr = titleVal as? String {
                windowTitles.append(titleStr)
            } else {
                windowTitles.append("Untitled Window")
            }
        }
    }

    return InspectResponse(ok: true, app: name, running: true, pid: pid, windowCount: windowCount, windows: windowTitles, error: nil)
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
        let resp = inspectApp(name: req.app ?? "Claude")
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    case "activate":
        let resp = activateApp(name: req.app ?? "Claude")
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
        let resp = unhideApp(name: req.app ?? "Claude")
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
