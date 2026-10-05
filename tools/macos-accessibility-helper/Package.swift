// SwiftPM wrapper for the native Agent Bridge Accessibility helper.
// Keeping the helper buildable through `swift build` makes the checked-in
// automation binary reproducible without introducing another build system.
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AgentBridgeAXHelper",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "bridge-ax-helper", targets: ["BridgeAXHelper"])
    ],
    targets: [
        .executableTarget(
            name: "BridgeAXHelper",
            path: ".",
            exclude: ["bridge-ax-helper"],
            sources: ["helper.swift"]
        )
    ]
)
