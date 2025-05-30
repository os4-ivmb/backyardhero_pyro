# Backyard Hero Firework Control System

This project is a firework control system. It provides a web interface for controlling fireworks, with the host software designed to run on a Unix-based laptop via Docker.

## Project Structure

The project is organized into two main directories:

*   `host/`: Contains the software that runs on the host computer.
*   `devices/`: Contains firmware, CAD files for enclosures, and PCB design overviews for the hardware components.

### Host Software

The host software is containerized using Docker and consists of the following components:

*   **Next.js Web Application (`byh-app`)**: Provides the user interface for controlling the fireworks. It runs on port 1776.
*   **Python WebSocket Server (`websock`)**: Facilitates real-time communication between the web application and the backend Python daemon. It runs on port 8090.
*   **Python Firework Daemon (`firework-daemon`)**: Interfaces with the firework hardware via a serial connection.

These components are managed by `supervisord` within the Docker container.

### Hardware Devices

The `devices/` directory contains the necessary files for the following hardware components:

*   `os4_cuemodule/`
*   `os4_dongle/`
*   `os4_receiver/`

Each device-specific directory includes:
*   Firmware
*   CAD files for enclosures
*   PCB design overview

## Getting Started

### Prerequisites

*   Docker
*   Docker Compose
*   A Unix-based system (currently)

### Running the System

1.  **Clone the repository:**
    ```bash
    git clone <repository-url>
    cd <repository-directory>
    ```
2.  **Configure the system (if necessary):**
    *   The primary user configuration file is `host/config/systemcfg.json`.
    *   **Serial Port (`SERIAL_PORT`):** This is the main setting you might need to change. Identify the correct serial port for the connected dongle on your system and update it in `host/config/systemcfg.json`. The `docker-compose.yml` also defines `SERIAL_PORT` as an environment variable, which might serve as a fallback or initial default, but `systemcfg.json` is the recommended place for user changes.
    *   **Serial Baud Rate (`SERIAL_BAUD`):** This is fixed at `115200` by the dongle hardware and generally should not be changed.
    *   **Privileged Mode:** If you encounter permission issues with the serial port, ensure the `privileged: true` line in `host/docker-compose.yml` is active (it is by default). This grants the Docker container necessary access to hardware devices.

3.  **Start the system:**
    Navigate to the `host/` directory and run the startup script:
    ```bash
    cd host
    ./start.sh
    ```
    This script handles building and running the Docker container.

4.  **Access the web interface:**
    Open your web browser and navigate to `http://localhost:1776`.

## Key Files

*   `host/start.sh`: The main script to build and start the entire system.
*   `host/docker-compose.yml`: Defines the Docker services and their configuration.
*   `host/Dockerfile`: Specifies how the Docker image for the `firework-system` service is built.
*   `host/supervisord.conf`: Configures the processes managed by `supervisord` (web app, WebSocket server, firework daemon).
*   `host/byh_app/`: Contains the Next.js web application.
*   `host/pythings/`: Contains the Python backend components (WebSocket server and firework daemon).
*   `devices/`: Contains firmware, CAD files, and PCB designs for all hardware modules.

## Contributing

Please feel free to submit pull requests or open issues to improve the project.
