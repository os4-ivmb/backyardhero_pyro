#!/bin/sh

VERSION="0.08UNIX"

# Configure paths
BRIDGE_DIR="tcp_serial_bridge"
BRIDGE_SCRIPT="$BRIDGE_DIR/tcp_serial_bridge.py"
BRIDGE_VENV="$BRIDGE_DIR/venv"
REQUIREMENTS="$BRIDGE_DIR/requirements.txt"

echo "BACKYARD HERO HOST --- VERSION: $VERSION"
echo "Working directory is $(pwd)"

# Function to clean up processes on exit
cleanup() {
    echo "Shutting down services..."
    
    # Kill the serial bridge if it's running
    if [ -n "$BRIDGE_PID" ] && ps -p $BRIDGE_PID > /dev/null; then
        echo "Stopping TCP to Serial bridge (PID: $BRIDGE_PID)"
        kill $BRIDGE_PID
    fi
    
    # Stop docker-compose if it's running
    if [ -n "$DOCKER_PID" ] && ps -p $DOCKER_PID > /dev/null; then
        echo "Stopping Docker Compose stack (PID: $DOCKER_PID)"
        docker-compose -f docker-compose-dev.yml down
    fi
    
    echo "Cleanup complete."
    exit 0
}

# Set up trap to catch signals and run cleanup
trap cleanup INT TERM EXIT

# Check if the bridge directory exists
if [ ! -d "$BRIDGE_DIR" ]; then
    echo "ERROR: Bridge directory $BRIDGE_DIR does not exist."
    exit 1
fi

# Check if the bridge script exists
if [ ! -f "$BRIDGE_SCRIPT" ]; then
    echo "ERROR: Bridge script $BRIDGE_SCRIPT does not exist."
    exit 1
fi

# Set up virtual environment if it doesn't exist
if [ ! -d "$BRIDGE_VENV" ]; then
    echo "Creating virtual environment in $BRIDGE_VENV..."
    python3 -m venv "$BRIDGE_VENV"
    if [ $? -ne 0 ]; then
        echo "ERROR: Failed to create virtual environment."
        exit 1
    fi
fi

# Activate virtual environment and install requirements
echo "Activating virtual environment and installing requirements..."
source "$BRIDGE_VENV/bin/activate"
if [ ! -f "$REQUIREMENTS" ]; then
    echo "WARNING: Requirements file $REQUIREMENTS does not exist."
else
    pip install -r "$REQUIREMENTS"
    if [ $? -ne 0 ]; then
        echo "ERROR: Failed to install requirements."
        exit 1
    fi
fi

# Start TCP to Serial bridge
echo "Starting TCP to Serial link..."
python "$BRIDGE_SCRIPT" &
BRIDGE_PID=$!

# Check if the bridge started successfully
sleep 2
if ! ps -p $BRIDGE_PID > /dev/null; then
    echo "ERROR: TCP to Serial bridge failed to start or exited prematurely."
    exit 1
fi
echo "TCP to Serial bridge running with PID: $BRIDGE_PID"

# Start Docker Compose stack
echo "Starting Backyard Hero Docker stack..."
docker-compose -f docker-compose-dev.yml up &
DOCKER_PID=$!

# Check if docker-compose started successfully
sleep 5
if ! ps -p $DOCKER_PID > /dev/null; then
    echo "ERROR: Docker Compose failed to start or exited prematurely."
    kill $BRIDGE_PID
    exit 1
fi
echo "Docker Compose running with PID: $DOCKER_PID"

echo "All services started successfully. Press Ctrl+C to stop."

# Wait for either process to exit
wait $BRIDGE_PID $DOCKER_PID
echo "One of the services has exited. Shutting down..."