

from enum import Enum

LED_FILE_PATH = "/data/ledstate"

class DAEMON_ACT_STATE(Enum):
    OFF = 0
    RUNNING = 1
    PAUSED = 2
    STOPPED = 3

class WEB_ACT_STATE(Enum):
    OFF = 0
    RUNNING = 1
    DISCONNECTED = 2
    CRASHED = 3

class TX_ACTIVE_STATE(Enum):
    OFF = 0
    TRANSMITTING = 1
    CONNECTED = 2
    DEVICE_ERROR = 3

class LOAD_STATE(Enum):
    OFF = 0
    LOADED = 1
    LOADING = 2
    LOAD_ERROR = 3

class RUN_STATE(Enum):
    OFF = 0
    RUNNING = 1
    MANUAL_FIRE = 2
    STOPPED = 3
    PAUSED = 4
    ARMED = 5
    DELEGATE_WAIT = 6
    PRECHECK = 7
    COUNTDOWN = 8

class ERR_STATE(Enum):
    OFF = 0
    DAEMON = 1
    RF_FRONTEND = 2
    SOCKET = 3
    FUCKIFIKNOW = 4
