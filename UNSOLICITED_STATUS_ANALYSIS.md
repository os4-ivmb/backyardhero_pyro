# Unsolicited Status Message Analysis

## Overview
This document analyzes when receivers send **unsolicited** status messages to the dongle (i.e., status messages not sent in response to a command).

---

## Status Message Call Sites

### 1. **Solicited Status** (Line 1135)
**Location:** `os4_receiver.ino` line 1135
```cpp
while(radio.available()){
    // ... process command ...
    sendStatus();  // Sent as ACK after receiving ANY command
}
```

**Trigger:** After receiving ANY command from dongle
- MANUAL_FIRE, CLOCK_SYNC, START_LOAD, SHOW_LOAD, SHOW_START, GENERIC_PLAY/STOP/RESET/PAUSE, RESET_DVC, GET_CONFIG

**Purpose:** Serves as acknowledgment that the receiver received and processed the command

**Frequency:** Variable, depends on command frequency from dongle

---

### 2. **Unsolicited Status** (Line 1229)
**Location:** `os4_receiver.ino` lines 1217-1229
```cpp
if(millis() - lastStatus > STATUS_INTERVAL && !gotCommand){
    if(timedOut){
        // Re-initialize radio if timed out
        radio.powerDown();
        delay(10);
        radio.powerUp();
        // ... reconfigure radio ...
    }
    Serial.println("TOS");  // "Time-Out Status" or "Time-Of-Status"
    sendStatus();
    lastStatus = millis();
    txForgivenessCt++;
}
```

**Trigger Conditions:**
1. `millis() - lastStatus > STATUS_INTERVAL` (2000ms elapsed since last status)
2. `!gotCommand` (no command received recently)

**Purpose:** Periodic heartbeat to keep dongle informed of receiver status

**Frequency:** Every 2 seconds when idle (no commands received)

---

## State Variables

### `gotCommand` Flag
- **Set to `true`:** When ANY command is received (line 1096)
- **Set to `false`:** When timeout detected (10 seconds without command, line 1189)
- **Purpose:** Prevents unsolicited status when commands are being received

### `timedOut` Flag
- **Set to `true`:** When 10 seconds pass without receiving a command (line 1190)
- **Set to `false`:** When a command is received (line 1097)
- **Purpose:** Indicates receiver hasn't heard from dongle in 10+ seconds

### `lastStatus` Timestamp
- **Updated:** After sending status (line 1230)
- **Purpose:** Tracks when last status was sent to enforce 2-second interval

### `lastCmdReceived` Timestamp
- **Updated:** After processing any command (line 1144)
- **Purpose:** Used to detect 10-second timeout (line 1181)

---

## Unsolicited Status Flow

### Normal Operation (Idle State)
```
Time 0ms:    Receiver starts, gotCommand = false
Time 2000ms: Send unsolicited status (TOS)
Time 4000ms: Send unsolicited status (TOS)
Time 6000ms: Send unsolicited status (TOS)
...continues every 2 seconds...
```

### With Periodic Commands
```
Time 0ms:    Receiver starts, gotCommand = false
Time 1500ms: Dongle sends CLOCK_SYNC command
            → gotCommand = true
            → Send solicited status (as ACK)
            → lastStatus = 1500ms
Time 2000ms: Check: millis() - lastStatus = 500ms < 2000ms → SKIP
Time 3500ms: Dongle sends CLOCK_SYNC command
            → gotCommand = true
            → Send solicited status (as ACK)
            → lastStatus = 3500ms
Time 4000ms: Check: millis() - lastStatus = 500ms < 2000ms → SKIP
```

### After Timeout (10 seconds without command)
```
Time 0ms:     Receiver starts, gotCommand = false
Time 2000ms:  Send unsolicited status (TOS)
Time 4000ms:  Send unsolicited status (TOS)
Time 6000ms:  Send unsolicited status (TOS)
Time 8000ms:  Send unsolicited status (TOS)
Time 10000ms: 10 seconds elapsed, gotCommand = false, timedOut = true
Time 10002ms: Send unsolicited status (TOS) + radio reinitialization
Time 12002ms: Send unsolicited status (TOS)
...continues every 2 seconds...
```

---

## Key Behaviors

### 1. **Suppression During Active Communication**
- When `gotCommand = true`, unsolicited status is **suppressed**
- This prevents redundant status messages when commands are frequent
- Status is still sent as ACK after each command (solicited)

### 2. **Timeout Detection**
- If 10 seconds pass without a command:
  - `gotCommand` is set to `false`
  - `timedOut` is set to `true`
  - Radio is reinitialized on next unsolicited status send
  - Unsolicited status resumes every 2 seconds

### 3. **Status Content**
Every status message (solicited or unsolicited) contains:
- `batteryLevel`: Current battery voltage reading
- `showState`: Current show ID, loadComplete, startReady flags
- `ident`: Receiver identifier (e.g., "RX121")
- `nodeID`: Receiver node ID
- `cont64_0`, `cont64_1`: Continuity bitmasks (read from shift registers)

---

## Impact on System

### With 10 Receivers (Idle State)
- **Unsolicited status rate:** 10 receivers × 1 status/2 seconds = **5 status messages/second**
- **All unsolicited** (no commands being sent)
- **Timing:** Receivers send independently based on their own `millis()`
- **Potential collisions:** If receivers' clocks are similar, they may send simultaneously

### With 10 Receivers (Active State - Clock Sync Every 2s)
- **Solicited status rate:** 10 receivers × 1 status/2 seconds = **5 status messages/second** (as ACK to clock sync)
- **Unsolicited status rate:** **0** (suppressed by `gotCommand = true`)
- **Total:** Still ~5 status messages/second, but all are solicited (as ACKs)

### With 10 Receivers (Mixed State)
- Some receivers receiving commands frequently → solicited status
- Other receivers idle → unsolicited status every 2 seconds
- Total rate depends on command distribution

---

## Edge Cases

### 1. **Command Received Just Before 2-Second Timer**
```
Time 1998ms: Check: millis() - lastStatus = 1998ms < 2000ms → SKIP
Time 1999ms: Dongle sends CLOCK_SYNC
            → gotCommand = true
            → Send solicited status (as ACK)
            → lastStatus = 1999ms
Time 2000ms: Check: millis() - lastStatus = 1ms < 2000ms → SKIP (correct)
```

### 2. **Multiple Commands in Quick Succession**
```
Time 0ms:    Command 1 received → gotCommand = true → Send status
Time 100ms:  Command 2 received → gotCommand = true → Send status
Time 200ms:  Command 3 received → gotCommand = true → Send status
Time 2000ms: Check: millis() - lastStatus = 1800ms < 2000ms → SKIP
             (Unsolicited suppressed, but solicited sent after each command)
```

### 3. **Timeout During Active Period**
```
Time 0ms:    Command received → gotCommand = true, lastCmdReceived = 0ms
Time 5000ms: No commands for 5 seconds
Time 10000ms: 10 seconds elapsed → gotCommand = false, timedOut = true
Time 10002ms: Send unsolicited status + radio reinit
```

---

## Optimization Opportunities

### Current Behavior
- Unsolicited status every 2 seconds when idle
- Suppressed when commands are frequent
- Radio reinitialized on timeout

### Potential Improvements
1. **Adaptive Interval:** Increase unsolicited interval when idle for longer periods (e.g., 2s → 5s after 30s idle)
2. **Smart Suppression:** Only suppress if command was received within last 500ms (avoid missing status if command was 1.9s ago)
3. **Timeout Handling:** Don't reinitialize radio on every timeout status - only on first timeout

---

## Summary

**Unsolicited status messages are sent:**
- Every 2 seconds (`STATUS_INTERVAL = 2000ms`)
- Only when `!gotCommand` (no recent commands)
- Purpose: Periodic heartbeat to keep dongle informed
- Content: Battery, show state, continuity, ident, nodeID

**With 10 receivers idle:**
- 5 unsolicited status messages/second
- All sent independently based on each receiver's `millis()`
- Potential for simultaneous transmissions (collisions handled by RF24)

**With 10 receivers active (clock sync every 2s):**
- 5 solicited status messages/second (as ACKs)
- 0 unsolicited status messages/second (suppressed)
- Total still ~5/second, but all are solicited

