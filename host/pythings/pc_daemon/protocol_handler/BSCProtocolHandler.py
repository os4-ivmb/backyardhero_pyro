
import os
import time
import serial
import sqlite3
import threading
from datetime import datetime
import json
from enum import Enum
from led_control import *
#TX token -- "OK"

class BSCFireTranslator:
    def translate_zone_target_to_tx_pkg(zone, target, repetition=6):
        actual_zone = zone
        if(isinstance(zone, str)):
            actual_zone = int(zone[1:])

        adj_zone = 123-int(actual_zone)
        adj_target = 15-int(target)

        dev_preamble = 0xe3 << (4*4)
        zone = adj_zone << (2*4)
        safebit = 7 << 4
        targetbit = adj_target
        rtn_str = str(bin(dev_preamble | zone | safebit | targetbit)).split("b")[1]

        return f">>{rtn_str}:{repetition}<<"

class BSCProtocolHandler:
    def __init__(self, parent):
        self.token = "OK"
        self.protocol = "BILUSOCN_433_TX_ONLY"
        self.schedule_stop_event = threading.Event()  # Used to stop schedules
        self.schedule_pause_event = threading.Event() # that but pause
        self.running_show = False  # Set running state
        self.time_cursor = -1
        self.errors = []
        self.show_loaded = False
        self.parent = parent

        self.firing_array = []
        print(f"Initialized Protocol {self.protocol}")

    def process_serial_in(self, msg):
        return True

    def fire_item(self, item):
        print(f"Issuing fire command for {item['id']} at {item['startTime']}")
        msg = BSCFireTranslator.translate_zone_target_to_tx_pkg(item['zone'], item['target'])
        self.parent.send_serial_command(msg)

    def handle_manual_fire(self, zone, target):
        msg = BSCFireTranslator.translate_zone_target_to_tx_pkg(zone, target)
        self.parent.send_serial_command(msg)

    def load_show(self, firing_array):
        print("Loaded firing array")
        print(firing_array)
        if(len(firing_array) == 0):
            self.parent.write_error("Loaded a show with an empty firing array? No")
            return False
        self.firing_array = firing_array
        self.show_loaded = True
        self.time_cursor=0
        return True

    def unload_show(self):
        self.time_cursor=-1
        self.firing_array = []
        self.errors = []

    def get_fc_failures(self):
        self.errors = []
        if(len(self.firing_array) == 0):
            self.errors = ["System error - No firing strategy loaded in. Check other errors."]
        return self.errors

    def run_show(self):
        updateLEDState("show_run_state", RUN_STATE.RUNNING.value)
        try:
            self.running_show = True  # Set running state
            self.schedule_stop_event.clear()  # Reset the stop event
            self.schedule_pause_event.clear()  # Reset the stop event
            print(self.firing_array)
            pause_start = 0
            pause_offset = 0
            start_time_epoch_sms = time.time()
            last_write_time = time.time()  # Track last file write time

            for item in self.firing_array:
                delay = item['startTime']  # Convert to MS
                while (time.time() - start_time_epoch_sms) < (delay + pause_offset):
                    if self.schedule_stop_event.is_set():
                        print("Schedule stopped.")
                        self.running_show = False
                        updateLEDState("show_run_state", RUN_STATE.STOPPED.value)
                        return
                    if self.schedule_pause_event.is_set():
                        print("Schedule paused.")
                        pause_start = time.time()
                        while self.schedule_pause_event.is_set():  # Stay in paused state
                            time.sleep(0.1)
                            if self.schedule_stop_event.is_set():
                                print("Schedule stopped.")
                                updateLEDState("show_run_state", RUN_STATE.STOPPED.value)
                                self.running_show = False
                                return

                        if pause_start:
                            pause_offset += (time.time() - pause_start)
                            pause_start = 0

                        print("Schedule resumed.")
                        updateLEDState("show_run_state", RUN_STATE.RUNNING.value)

                    time.sleep(0.01)  # Check stop event frequently
                    self.time_cursor = round((time.time() - start_time_epoch_sms + pause_offset),2)

                    # Overwrite file every second
                    if time.time() - last_write_time >= 1:
                        self.parent.write_time_cursor(self.time_cursor)
                        last_write_time = time.time()
                
                self.fire_item(item)
                print(f"Executing scheduled command: {item}")
            print("All commands fired.")
            self.running_show = False
            updateLEDState("show_run_state", RUN_STATE.STOPPED.value)
            return
        except Exception as e:
            print(f"Error in schedule: {e}")
            updateLEDState("error_state", ERR_STATE.DAEMON.value)
            updateLEDState("show_run_state", RUN_STATE.STOPPED.value)
            return

    
