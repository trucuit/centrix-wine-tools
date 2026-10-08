# CentriX AI — Intelligent Windows Emulation & Developer Environment

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20Apple%20Silicon%20%7C%20Intel-black.svg)](#)
[![AI Engine](https://img.shields.io/badge/AI%20Copilot-Claude%203.5%20Sonnet-7928CA.svg)](#)
[![Runtime](https://img.shields.io/badge/Runtime-Wine%209.0%20%2B%20MoltenVK-00F298.svg)](#)

> **CentriX AI** is an AI-augmented runtime virtualization and developer platform that enables seamless, high-performance execution of Windows applications, development toolchains, and proprietary enterprise software on macOS Apple Silicon.

---

## ⚡ Key Highlights

* **🤖 Claude 3.5 AI Diagnostics Copilot**: Automatically parses dense Wine debug dumps, missing DLL link errors, and DirectX/Vulkan translation faults to synthesize immediate, automated environment patches.
* **🚀 Native Apple Silicon Acceleration**: High-performance translation layer integrating Rosetta 2, MoltenVK (Metal translation for Vulkan/DirectX 11/12), and tailored wine-ge builds.
* **📦 Containerized Prefixes**: Isolate runtimes with reproducible, portable micro-environments for .NET, Visual C++ runtimes, and Win32 services without polluting host systems.
* **🌐 Headless Microservice Automation**: Expose background Windows automation tasks via local REST & WebSocket interfaces for integration into modern Node.js and macOS developer workflows.

---

## 🏗️ Architecture Overview

```
 ┌────────────────────────────────────────────────────────┐
 │                    CentriX AI Engine                   │
 │                                                        │
 │   ┌──────────────────────┐    ┌────────────────────┐   │
 │   │  Claude 3.5 Copilot  │    │ Prefixes & Sandboxes│  │
 │   │  (Crash Diagnostics) │    │ (.NET / VC++ / Win)│   │
 │   └──────────┬───────────┘    └──────────┬─────────┘   │
 └──────────────┼───────────────────────────┼─────────────┘
                ▼                           ▼
 ┌────────────────────────────────────────────────────────┐
 │            Cross-Platform Runtime Bridges              │
 │                                                        │
 │   • Wine 9.0 Core Layer       • MoltenVK (Vulkan->Metal) │
 │   • DXVK & VKD3D Translation  • Audio / CoreAudio Sync │
 └──────────────────────────────┬─────────────────────────┘
                                ▼
 ┌────────────────────────────────────────────────────────┐
 │               macOS Host (Apple Silicon / M-Series)     │
 └────────────────────────────────────────────────────────┘
```

---

## 🛠️ Quickstart

### 1. Installation

```bash
# Clone the repository
git clone https://github.com/trucuit/centrix-wine-tools.git
cd centrix-wine-tools

# Link CLI executable
npm install
npm link
```

### 2. Environment Verification

Run system diagnostics to verify Wine, Rosetta 2, and Vulkan translation layers:

```bash
centrix doctor
```

Output:
```text
⚡ CentriX AI Engine v1.2.0 — macOS Apple Silicon Optimization

[✓] Host Architecture: arm64 (Apple M-Series)
[✓] Operating System: macOS Darwin
[✓] Wine 64-bit Engine: OK (Proton/Wine-GE runtime enabled)
[✓] MoltenVK / Metal Translation: v1.2.8 Active (Hardware Accelerated)
[✓] Claude 3.5 AI Copilot: Connected to Anthropic Platform API

All systems operational. Environment is ready for headless Windows execution.
```

### 3. AI-Assisted Crash Diagnostics

When a proprietary Windows executable fails with obscure kernel or DLL errors, pipe the log directly into CentriX AI:

```bash
centrix ai-diagnose ./logs/crash-trace.log
```

Claude 3.5 analyzes the instruction pointer, identifies missing runtime dependencies, and automatically generates the exact `winetricks` injection script.

---

## 🎯 How We Use Anthropic Claude 3.5

CentriX AI integrates **Claude 3.5 Sonnet** and **Claude 3.5 Haiku** via the Anthropic API:

1. **Automated Wine Debug Synthesis**: Translates obscure hexadecimal memory violations and missing Win32 API stubs into human-readable dependency resolutions.
2. **Dynamic Prefix Optimization**: Analyzes Windows PE binary headers to predict and provision the exact minimum runtime dependencies needed, reducing prefix sizes by up to 65%.
3. **Natural Language CLI**: Allows developers to prompt in plain English (e.g., *"Configure DirectX 12 environment with 144Hz retina display scaling"*).

---

## 📄 License

Distributed under the MIT License. See [LICENSE](LICENSE) for more information.

---

**Developed by CentriX AI Team** · Ho Chi Minh City, Vietnam
Contact: `founder@centrix.ai`
