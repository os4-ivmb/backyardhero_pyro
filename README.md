# Backyard Hero: An excessively DIY Firework Control System

## Overview

Backyard Hero is an open-source firework control system designed for enthusiasts who want a powerful, flexible, and cost-effective solution. It features a local web interface for show design and execution, and supports both existing Bilusocn one-way receivers and a custom 2.4GHz bidirectional hardware platform.

**Version NYE2025.01** introduces major improvements including rack editing, YouTube video processing for firing profiles, enhanced receiver telemetry, pyromusical support, and significant reliability improvements.

This project provides the complete software, firmware, and hardware design resources.

## Table of Contents

*   [Project Structure](#project-structure)
*   [System Capabilities](#system-capabilities)
    *   [Custom Hardware](#custom-hardware)
    *   [Software Platform](#software-platform)
    *   [Show Control Lifecycle](#show-control-lifecycle)
*   [Getting Started](#getting-started)
    *   [Prerequisites](#prerequisites)
    *   [Installation & Setup](#installation--setup)
    *   [Running the System](#running-the-system)
*   [Key Files & Directories](#key-files--directories)
*   [Target Audience & Community](#target-audience--community)
*   [What's Next? (Roadmap)](#whats-next-roadmap)
*   [Contributing](#contributing)
*   [License](#license)

## Project Structure

The project is organized into two primary directories:

*   `host/`: Contains all software components that run on the host computer (e.g., OSX/Windows laptop, Raspberry Pi). This includes the show builder, runner, and communication daemon.
*   `devices/`: Contains firmware, CAD files for enclosures, and PCB design overviews for the custom hardware components (receivers, cue modules, dongle).

### Host Software Components

The host software is containerized using Docker for ease of deployment and consists of:

*   **Next.js Web Application (`byh-app`)**: Provides the user interface for show design, inventory management, and firing control. Runs on port `1776`.
*   **Python WebSocket Server (`websock`)**: Enables real-time, bidirectional communication between the web application and the backend Python daemon. Runs on port `8090`.
*   **Python Firework Daemon (`firework-daemon`)**: Interfaces with the firework hardware (dongle) via a serial connection and manages the show execution logic.

These components are orchestrated by `supervisord` within the Docker container.

### Hardware Device Designs

The `devices/` directory includes resources for:

*   `os4_receiver/`: Custom 2.4GHz receiver with direct point-to-point communication (1000+ yard range).
*   `os4_cuemodule/`: Chainable 8-cue modules (expandable).
*   `os4_dongle/`: USB dongle for host communication with custom receivers and 433MHz systems.

Each directory contains firmware, enclosure CAD files, and PCB design details.

## System Capabilities

### Custom Hardware

The custom 2.4GHz hardware platform offers significant advantages:

*   **Direct RF Communication:** Receivers use raw point-to-point communication (non-mesh) with 1000+ yard range. Mesh networking was removed as it added unnecessary overhead - the direct range is more than sufficient for most applications.
*   **Superior RF Performance:** Meticulous PCB design and impedance matching maximize the performance of the onboard PA/LNA, ensuring robust communication.
*   **Long Battery Life:** On-board lithium batteries are rechargeable via USB-C PD (12V for fast charging) and provide well over 24 hours of continuous runtime.
*   **Expandable & Modular Cues:** Each receiver supports up to 128 cues via chainable 8-cue modules.
*   **Advanced Telemetry:** The system provides comprehensive real-time feedback including cue continuity, signal latency, ready count, success percentage, and receiver battery levels. All metrics are displayed in the UI with visual health indicators.
*   **Rugged Design:** 3D-printable enclosures are designed for durability and can be made water-resistant.. if you want.
*   **Dual-Frequency Dongle:** The custom dongle interfaces with the 2.4GHz custom receivers and also includes a 433MHz frontend for compatibility with BILUSOCN and similar one-way systems.
*   **Cost-Effectiveness:**
    *   Receiver: ~$27 (pre-tariff)
    *   Dongle: ~$25 (pre-tariff)
    *   8-Cue Module: ~$8 (pre-tariff)
    *   A complete 2-receiver, 32-cue system can be built for around $110 USD. Prices are above are what you need in materials to finish completed components

### Software Platform

The local web application, runnable on a laptop or a dedicated device like a Raspberry Pi, offers:

*   **Show Design:** A graphical interface for creating and managing firework shows with an improved UI.
*   **Rack Editing:** Create custom racks with configurable dimensions, assign shells to specific cells, and build fuse lines with visual representation. Racks can be assigned to receivers and integrated into shows.
*   **Inventory Management:** Keep track of your pyro stock with support for shell packs, firing profiles, and metadata. Automatically process lists of mortar effects - paste shell descriptions and the system extracts colors and effects, mapping them to standardized types for easy rack spot selection.
*   **YouTube Video Processing:** Automatically crawl YouTube videos and extract firing profiles by analyzing audio. The system can identify shot timings and optionally populate color information for shells.
*   **Pyromusical Support:** Upload audio files and synchronize show timing with music. The timeline includes waveform visualization for precise cue placement.
*   **Advanced Fusing Logic:** The show builder automatically incorporates delays for fused lines in racks, ensuring precise timing based on fuse burn rates.
*   **Cross-Platform Compatibility:** Designed to run on OSX and Windows (via `start.sh` and `start.bat` respectively in the `host` directory).

### Show Control Lifecycle

The system follows a lifecycle for show execution. I learned it from launching rockets and shit:

1.  **Initialization & Synchronization:** Upon power-on, receivers connect to the host, which synchronizes their clocks to within <10ms accuracy.
2.  **Show Staging:** Shows are loaded from a database, populating the UI, editor, and reflecting cue usage on the receiver status tabs.
3.  **System Loading & Verification:** The system verifies all custom receivers are online (433MHz systems are assumed operational). Firing instructions are then transmitted to each receiver. Cue status is indicated by LEDs on the modules:
    *   **Red:** Continuity required but not detected.
    *   **Green:** Continuity required and detected.
    *   **Blue:** Continuity detected but not required for the current show.
4.  **Arming the System:** Before starting, the physical 'start/stop' switch on the dongle must be moved to the 'start' position. (Shows will not load if the switch is not in 'stop').
5.  **Pre-Launch & Execution:**
    *   Pressing 'Play' in the UI triggers pre-launch checks (continuity, battery levels) on all receivers.
    *   If checks pass, a synchronized start time (typically T-20 minutes) is sent to all receivers.
    *   Upon confirmation, the host issues 'play' commands, and the custom receivers take over autonomous execution. This ensures highly precise timing, independent of potential RF interference with the host.
6.  **Show Monitoring & Safety Abort:**
    *   The show runs according to the programmed sequence.
    *   Flipping the dongle switch to 'stop' or pressing the abort button in the UI immediately halts the show by sending a stop command to all receivers.
    *   Custom receivers will automatically stop if they lose contact with the host for more than 10 seconds.

## Getting Started

### Prerequisites

*   Docker
*   Docker Compose
*   A Unix-based system is currently the primary development target, though Windows support is available via `start.bat`.

### Installation & Setup

1.  **Clone the Repository:**
    ```bash
    git clone <repository-url> # Replace <repository-url> with the actual URL
    cd backyardhero # Or your chosen directory name
    ```
2.  **System Configuration:**
    *   The main user configuration file is `host/config/systemcfg.json`.
    *   **Serial Port (`SERIAL_PORT`):** This is the most critical setting. Identify the correct serial port for your connected dongle and update it in `host/config/systemcfg.json`. While `docker-compose.yml` also defines `SERIAL_PORT`, the `systemcfg.json` file is the recommended place for this user-specific setting.
    *   **Serial Baud Rate (`SERIAL_BAUD`):** Fixed at `115200` by the dongle hardware; do not change.
    *   **Privileged Mode (Docker):** If you encounter serial port permission issues, ensure `privileged: true` is active in `host/docker-compose.yml` (it is by default). This grants the Docker container necessary hardware access.

### Running the System

1.  Navigate to the `host/` directory:
    ```bash
    cd host
    ```
2.  Execute the startup script for your OS:
    *   For OSX/Linux:
        ```bash
        ./start.sh
        ```
    *   For Windows:
        ```bash
        start.bat
        ```
    These scripts handle building the Docker images (if not already built) and starting the application stack.

3.  **Access the Web Interface:**
    Open your web browser and go to `http://localhost:1776`.

## Key Files & Directories

*   `host/start.sh` & `host/start.bat`: Master scripts for starting the system on Unix-like systems and Windows, respectively.
*   `host/docker-compose.yml`: Defines the Docker services, networks, and volumes.
*   `host/Dockerfile`: Specifies the build process for the main `firework-system` Docker image.
*   `host/supervisord.conf`: Configures `supervisord` to manage the Next.js app, WebSocket server, and Python daemon within the container.
*   `host/config/systemcfg.json`: User-configurable system parameters, primarily the serial port and available devices
*   `host/byh_app/`: Contains the Next.js frontend web application.
*   `host/pythings/`: Contains the Python backend (WebSocket server, firework daemon).
*   `devices/`: Houses all hardware-related files (firmware, CAD, PCB overviews).

## Target Audience & Community

This project is for pyrotechnic hobbyists and DIY electronics enthusiasts looking for a highly capable, customizable, and affordable firing system. It serves as a robust foundation for a community-driven platform where users can share improvements, new features, and hardware modifications.

While the custom RF hardware designs would require FCC certification for commercial sale, the complete software, firmware, and design concepts are provided. The maintainer welcomes collaboration, especially on the hardware aspects, and is willing to share detailed design/production resources and potentially provide hardware modules for testing to active contributors (at material cost).

## Version History

### NYE2025.01 (Current)

*   **Rack Editing System:** Full rack creation and management - design custom rack layouts, assign shells to cells, create and visualize fuse lines, and assign racks to receivers. Auto-processing of shell description lists extracts colors and effects, making it easy to choose shells for rack spots based on color/effect filters.
*   **Auto Shell Description Processing:** Paste lists of mortar shell descriptions and the system automatically extracts colors and effects, maps them to standardized types, and creates inventory entries. Makes it easy to filter and select shells by color or effect when building racks.
*   **YouTube Video Processing:** Automated firing profile extraction from YouTube videos with audio analysis. Supports color detection and population for shells.
*   **Enhanced Receiver Telemetry:** Comprehensive telemetry including ready count, latency tracking, success percentage, and real-time health monitoring.
*   **RF Protocol Improvements:** Switched from mesh networking to direct point-to-point communication. Achieves 1000+ yard range without mesh overhead, improving reliability and reducing complexity.
*   **Pyromusical Support:** Audio file upload and timeline synchronization with waveform visualization for music-synchronized shows.
*   **Reliability & Resiliency:** Numerous fixes and improvements to receiver/transmitter communication, error handling, and recovery mechanisms.
*   **UI Revamp:** Improved user interface in multiple areas including show builder, receiver status displays, and inventory management.

## What's Next?

This project is actively evolving. Here are some potential areas for future development:

*   **Enhanced UI/UX:** Continuously improving the web interface for better usability and more advanced show design features.
*   **Expanded Hardware Support:**
    *   Developing more pre-designed hardware modules, maybe a DMX module instead of an 8 cue. 
    *   Official support and documentation for Raspberry Pi as a dedicated host device.
*   **Advanced Show Synchronization:** Pyromusical support is now available - upload audio files and sync cues to music with waveform visualization.
*   **Community Features:** Building a platform or forum for users to share show files, hardware mods, and experiences.
*   **Comprehensive Documentation:** Expanding documentation for developers, hardware builders, and end-users.
*   **Windows Native Support:** Improving native Windows support beyond the current Docker-based `start.bat`.

Your contributions and suggestions are welcome - though if they dont come with help, its 50/50 if anything will come of it. 


## License

Dont be a dick
