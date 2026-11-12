#pragma once

// GPIO assignments for the omni (receiver PCB), shared by every role.

#define RF24_CE_PIN_V6_PLUS 37
#define RF24_CSN_PIN_V6_PLUS 36
#define RF24_CE_PIN_PRE_V6 34
#define RF24_CSN_PIN_PRE_V6 33

#define LED_PIN 11
#define STATUS_LED_PIN 17
#define STATUS_LED_COUNT 3
#define BATT_VOLTAGE_PIN 3
#define BOARD_CT_PIN 2

#define SHIFT_OUT_CLOCK 10
#define SHIFT_OUT_LATCH 9
#define SHIFT_OUT_OE 13
#define SHIFT_OUT_DATA 7

#define SHIFT_IN_CLOCK 6
#define SHIFT_IN_LATCH 5
#define SHIFT_IN_DATA 12

// Identity, receiver config, and hub WiFi settings all live here so WIPEID
// factory-resets every role at once.
#define OMNI_NVS_NAMESPACE "byh_omni"
