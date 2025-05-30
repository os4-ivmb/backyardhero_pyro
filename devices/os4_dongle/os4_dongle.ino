

#include <SPI.h>
#include <RF24.h>
#include <RF24Network.h>
#include <RF24Mesh.h>
#include <Adafruit_NeoPixel.h>
#include <ArduinoJson.h>

#define RF24_CE_PIN 37
#define RF24_CSN_PIN 36
#define RF_PIN 4

#define CONTINUITY_INDEX_CT 2
#define MAX_LATENCY_SAMPLES 10

#define SWITCH_START_STOP_PIN 9   
#define SWITCH_ARMING_PIN 8       
#define SWITCH_MAN_FIRE_PIN 7    


#define LED_PIN 5                
#define NUM_PIXELS 7               

enum MessageType {
  MANUAL_FIRE     = 1,
  CLOCK_SYNC      = 2,
  START_LOAD      = 3,
  SHOW_LOAD       = 4,
  GENERIC_PLAY    = 5,
  GENERIC_STOP    = 6,
  GENERIC_RESET   = 7,
  GENERIC_PAUSE   = 8,
  SHOW_START      = 9,
  RECEIVER_STATUS = 10,
  RESET_DVC       = 12
};




struct ManualFireMessage {
  uint8_t type;  
  uint8_t position;
} __attribute__((packed));

struct ClockSyncMessage {
  uint8_t type;  
  uint64_t timestamp;
} __attribute__((packed));

struct StartLoadMessage {
  uint8_t type;  
  uint8_t numTargetsToFire;
  uint16_t showId;
} __attribute__((packed));

struct ShowLoadMessage {
  uint8_t type;  
  uint32_t time_1;
  uint8_t position_1;
  uint32_t time_2;
  uint8_t position_2;
} __attribute__((packed));

struct GenericMessage {
  uint8_t type;  
} __attribute__((packed));

struct ShowStartMessage {
  uint8_t type;  
  uint64_t targetStartTime;
  uint8_t numTargetsToFire;
  uint16_t showId;
} __attribute__((packed));

struct ReceiverStatusMessage {
  uint8_t type;  
  uint8_t nodeID;
  uint8_t batteryLevel;
  uint16_t showState; 
  char ident[10];
  uint64_t cont64_0;
  uint64_t cont64_1;
} __attribute__((packed));




struct ReceiverInfo {
  uint8_t nodeID;
  String ident;
  uint8_t batteryLevel;
  uint16_t showId;
  bool loadComplete;
  bool startReady;
  uint64_t lastMessageTime;
  uint64_t continuity[CONTINUITY_INDEX_CT]; 

  
  uint32_t latencies[MAX_LATENCY_SAMPLES];
  uint8_t latencyNextIndex;
  uint8_t latencySampleCount;
};

#define MAX_RECEIVERS 10
ReceiverInfo receivers[MAX_RECEIVERS];
uint8_t numReceivers = 0;


uint32_t receiverInactivityTimeoutMs = 30000UL; 
uint32_t commandResponseTimeoutMs = 100UL;    
uint32_t clockSyncIntervalMs = 2000UL;  
uint8_t debugMode = 0;


uint64_t lastDhcpCallTime = 0;
const uint32_t dhcpCallIntervalMs = 1000UL; 




struct QueuedCommand {
  uint8_t targetNodeID;
  MessageType messageType;

  
  uint8_t fire_position;
  uint64_t sync_timestamp;
  uint8_t startload_numTargets;
  uint16_t startload_showId;
  uint32_t showload_time_1;
  uint8_t  showload_position_1;
  uint32_t showload_time_2;
  uint8_t  showload_position_2;
  uint64_t showstart_targetStartTime;
  uint8_t  showstart_numTargetsToFire;
  uint16_t showstart_showId;
  
};

#define MAX_COMMANDS_IN_QUEUE 40
QueuedCommand commandBuffer[MAX_COMMANDS_IN_QUEUE];
int cmdQueueHead = 0;
int cmdQueueTail = 0;
int cmdQueueCount = 0;


bool awaitingResponseForCommand = false;      
uint8_t  responseTargetNodeID = 0;            
uint64_t commandDispatchTime = 0;           
uint64_t initialCommandDispatchTime = 0;    


#define MAX_LATENCY_SAMPLES 10
uint32_t latencies[MAX_LATENCY_SAMPLES];
uint8_t latencyNextIndex = 0;
uint8_t latencySampleCount = 0;




uint8_t lastStartStopState = HIGH;
uint8_t lastArmingState = HIGH;
uint8_t lastManFireState = HIGH;
unsigned long lastGpioCheckTime = 0;




Adafruit_NeoPixel pixels(NUM_PIXELS, LED_PIN, NEO_GRB + NEO_KHZ800);


unsigned long lastBlinkTime = 0;
bool blinkState = false;
unsigned long lastPulseTime = 0;
int pulseValue = 0;
int pulseDirection = 1;
uint8_t ledBrightness = 90;  


uint32_t COLOR_OFF = pixels.Color(0, 0, 0);
uint32_t COLOR_GREEN = pixels.Color(0, 255, 0);
uint32_t COLOR_YELLOW = pixels.Color(255, 255, 0);
uint32_t COLOR_RED = pixels.Color(255, 0, 0);
uint32_t COLOR_BLUE = pixels.Color(0, 0, 255);
uint32_t COLOR_PURPLE = pixels.Color(255, 0, 255);
uint32_t COLOR_WHITE = pixels.Color(255, 255, 255);
uint32_t COLOR_CYAN = pixels.Color(0, 255, 255);


uint8_t ledStates[NUM_PIXELS] = {0};
uint8_t ledEffects[NUM_PIXELS] = {0};  


uint64_t tsOffset = 0;
uint64_t lastPrintTime = 0;
uint64_t lastScheduledClockSyncTime = 0; 




RF24 radio(RF24_CE_PIN, RF24_CSN_PIN);
RF24Network network(radio);
RF24Mesh mesh(radio, network);




bool isQueueFull() {
  return cmdQueueCount >= MAX_COMMANDS_IN_QUEUE;
}

bool isQueueEmpty() {
  return cmdQueueCount == 0;
}

void enqueueCommand(const QueuedCommand& cmd) {
  if (isQueueFull()) {
    Serial.println(F("ERR: Command queue full. Command dropped."));
    return;
  }
  commandBuffer[cmdQueueTail] = cmd;
  cmdQueueTail = (cmdQueueTail + 1) % MAX_COMMANDS_IN_QUEUE;
  cmdQueueCount++;
}

bool dequeueCommand(QueuedCommand& cmd) {
  if (isQueueEmpty()) {
    return false;
  }
  cmd = commandBuffer[cmdQueueHead];
  cmdQueueHead = (cmdQueueHead + 1) % MAX_COMMANDS_IN_QUEUE;
  cmdQueueCount--;
  return true;
}




void setupLEDs() {
  pixels.begin();
  pixels.setBrightness(map(ledBrightness, 0, 100, 0, 255));
  pixels.clear();

  
  pixels.setPixelColor(0, COLOR_GREEN);
  pixels.show();
}




void updateLEDs() {
  unsigned long currentMillis = millis();

  
  if (currentMillis - lastBlinkTime >= 500) {
    blinkState = !blinkState;
    lastBlinkTime = currentMillis;
  }

  
  if (currentMillis - lastPulseTime >= 50) {
    pulseValue += pulseDirection * 5;
    if (pulseValue >= 100) {
      pulseValue = 100;
      pulseDirection = -1;
    } else if (pulseValue <= 0) {
      pulseValue = 0;
      pulseDirection = 1;
    }
    lastPulseTime = currentMillis;
  }

  
  for (int i = 0; i < NUM_PIXELS; i++) {
    uint32_t color;

    
    switch (ledStates[i]) {
      case 0: color = COLOR_OFF; break;
      case 1: color = COLOR_GREEN; break;
      case 2: color = COLOR_YELLOW; break;
      case 3: color = COLOR_RED; break;
      case 4: color = COLOR_BLUE; break;
      case 5: color = COLOR_PURPLE; break;
      case 6: color = COLOR_WHITE; break;
      case 7: color = COLOR_CYAN; break;
      default: color = COLOR_OFF;
    }

    
    if (ledEffects[i] == 1) {  
      if (!blinkState) {
        color = COLOR_OFF;  
      }
    } else if (ledEffects[i] == 2) {  
      
      uint8_t r = ((color >> 16) & 0xFF) * pulseValue / 100;
      uint8_t g = ((color >> 8) & 0xFF) * pulseValue / 100;
      uint8_t b = (color & 0xFF) * pulseValue / 100;
      color = pixels.Color(r, g, b);
    }

    pixels.setPixelColor(i, color);
  }

  pixels.show();
}




void parseLedJSON(const String& json) {
  StaticJsonDocument<512> doc;
  DeserializationError error = deserializeJson(doc, json);
  if (error) {
    Serial.print(F("deserializeJson() failed: "));
    Serial.println(error.f_str());
    return;
  }
  
  if (doc.containsKey("led_brightness")) {
    ledBrightness = doc["led_brightness"].as<int>();
    if (ledBrightness < 1) ledBrightness = 1;
    if (ledBrightness > 100) ledBrightness = 100;
    pixels.setBrightness(map(ledBrightness, 0, 100, 0, 255));
  }
  if (doc.containsKey("daemon_act")) {
    ledStates[0] = doc["daemon_act"].as<int>() ? 1 : 0;
  }
  if (doc.containsKey("web_act_state")) {
    ledStates[1] = doc["web_act_state"].as<int>();
  }
  if (doc.containsKey("tx_active")) {
    ledStates[2] = doc["tx_active"].as<int>();
  }
  if (doc.containsKey("show_load_state")) {
    ledStates[3] = doc["show_load_state"].as<int>();
  }
  if (doc.containsKey("show_run_state")) {
    int runState = doc["show_run_state"].as<int>();
    ledStates[4] = runState;
    if (runState == 1) {        
      ledEffects[4] = 2;
    } else if (runState == 2) { 
      ledEffects[4] = 1;
    } else if (runState == 8) { 
      ledEffects[4] = 1;
    } else if (runState == 7) { 
      ledEffects[4] = 1;
    } else {
      ledEffects[4] = 0;
    }
  }
  if (doc.containsKey("error_state")) {
    ledStates[5] = doc["error_state"].as<int>();
  }

  
  if (doc.containsKey("receiver_timeout_ms")) {
    receiverInactivityTimeoutMs = doc["receiver_timeout_ms"].as<uint32_t>();
  }
  if (doc.containsKey("response_timeout_ms")) {
    commandResponseTimeoutMs = doc["response_timeout_ms"].as<uint32_t>();
  }
  if (doc.containsKey("clock_sync_interval_ms")) {
    clockSyncIntervalMs = doc["clock_sync_interval_ms"].as<uint32_t>();
  }

  if (doc.containsKey("debug_mode")) {
    debugMode = doc["debug_mode"].as<uint8_t>();
  }
}




void checkGpioStatus() {
  uint8_t startStopState = digitalRead(SWITCH_START_STOP_PIN);
  uint8_t armingState = digitalRead(SWITCH_ARMING_PIN);
  uint8_t manFireState = digitalRead(SWITCH_MAN_FIRE_PIN);

  if (startStopState != lastStartStopState ||
      armingState != lastArmingState ||
      manFireState != lastManFireState ||
      millis() - lastGpioCheckTime > 10000) {
      if(millis() - lastGpioCheckTime > 200){ 
        lastStartStopState = startStopState;
        lastArmingState = armingState;
        lastManFireState = manFireState;
        lastGpioCheckTime = millis();
        StaticJsonDocument<200> doc;
        doc["gpio"] = "gpio_status";
        doc["start_stop"] = (startStopState);
        doc["armed"] = (armingState);
        doc["man_fire"] = (manFireState);
        String jsonString;
        serializeJson(doc, jsonString);
        Serial.println(jsonString);
      }
  }
}




ReceiverInfo* getReceiverByIdent(const String &ident, bool createIfNotExist) {
  if (ident.length() == 0 || ident.charAt(0) != 'R') {
    
    return nullptr;
  }
  for (uint8_t i = 0; i < numReceivers; i++){
    if(receivers[i].ident == ident)
      return &receivers[i];
  }
  if(!createIfNotExist){
    
    return nullptr;
  }
  if(numReceivers < MAX_RECEIVERS){
    receivers[numReceivers].ident = ident;
    receivers[numReceivers].nodeID = 0; 
    receivers[numReceivers].batteryLevel = 0;
    receivers[numReceivers].showId = 0;
    receivers[numReceivers].loadComplete = false;
    receivers[numReceivers].startReady = false;
    receivers[numReceivers].lastMessageTime = millis() + tsOffset; 
    for(uint8_t j=0; j<CONTINUITY_INDEX_CT; j++){
      receivers[numReceivers].continuity[j]=0;
    }
    
    receivers[numReceivers].latencyNextIndex = 0;
    receivers[numReceivers].latencySampleCount = 0;
    for(uint8_t k=0; k<MAX_LATENCY_SAMPLES; k++){
        receivers[numReceivers].latencies[k] = 0; 
    }
    numReceivers++;
    return &receivers[numReceivers-1];
  }
  
  
  Serial.println(F("ERR: Max receivers reached. Cannot add new."));
  return nullptr;
}

void printMeshAddresses() {
  Serial.println(F("Mesh DHCP Table:"));
  for (uint8_t i = 0; i < mesh.addrListTop; i++) {
    Serial.print(F("NodeID: "));
    Serial.print(mesh.addrList[i].nodeID);
    Serial.print(F("  RF24 Address: 0x"));
    Serial.println(mesh.addrList[i].address, HEX);
  }
}




void sendActualManualFireMessage(uint8_t nodeID, uint8_t position) {
  ManualFireMessage msg;
  msg.type = MANUAL_FIRE;
  msg.position = position;
  if(!mesh.write(&msg, MANUAL_FIRE, sizeof(msg), nodeID)){
    Serial.println(F("TX ERROR: MANUAL_FIRE"));
  }
}

void sendActualClockSyncMessage(uint8_t nodeID, uint64_t timestamp) {
  uint64_t now = millis() + tsOffset;
  ClockSyncMessage msg;
  msg.type = CLOCK_SYNC;
  msg.timestamp = now;
  if(!mesh.write(&msg, CLOCK_SYNC, sizeof(msg), nodeID)){
    Serial.println(F("TX ERROR: CLOCK_SYNC"));
  }
}

void sendActualStartLoadMessage(uint8_t nodeID, uint8_t numTargets, uint16_t showId) {
  StartLoadMessage msg;
  msg.type = START_LOAD;
  msg.numTargetsToFire = numTargets;
  msg.showId = showId;
  if(!mesh.write(&msg, START_LOAD, sizeof(msg), nodeID)){
    Serial.println(F("TX ERROR: START_LOAD"));
  }
}

void sendActualShowLoadMessage(uint8_t nodeID, uint32_t t1, uint8_t p1,
                         uint32_t t2, uint8_t p2) {
  ShowLoadMessage msg;
  msg.type = SHOW_LOAD;
  msg.time_1 = t1;
  msg.position_1 = p1;
  msg.time_2 = t2;
  msg.position_2 = p2;
  if(!mesh.write(&msg, SHOW_LOAD, sizeof(msg), nodeID)){
    Serial.println(F("TX ERROR: SHOW_LOAD"));
  }
}

void sendActualShowStartMessage(uint8_t nodeID, uint64_t startTime, uint8_t numTargets, uint16_t showId) {
  ShowStartMessage msg;
  msg.type = SHOW_START;
  msg.targetStartTime = startTime;
  msg.numTargetsToFire = numTargets;
  msg.showId = showId;
  if(!mesh.write(&msg, SHOW_START, sizeof(msg), nodeID)){
    Serial.println(F("TX ERROR: SHOW_START"));
  }
}

void sendActualGenericMessage(uint8_t nodeID, uint8_t commandType) {
  GenericMessage msg;
  msg.type = commandType;
  if(!mesh.write(&msg, commandType, sizeof(msg), nodeID)){
    Serial.print(F("TX ERROR: Generic Cmd "));
    Serial.println(commandType);
  }
}


bool isValidMessage(const String &message) {
  return message.startsWith(">>") && message.endsWith("<<") && message.indexOf(':') != -1;
}

String parseBinaryString(const String &message) {
  int start = message.indexOf(">>") + 2;
  int colon = message.indexOf(':');
  return message.substring(start, colon);
}

int parseRepetitions(const String &message) {
  int colon = message.indexOf(':');
  int end = message.indexOf("<<");
  return message.substring(colon + 1, end).toInt();
}

void sendBinaryString(const String &binaryString) {
  for (int i = 0; i < binaryString.length(); i++) {
    if (binaryString[i] == '1') {
      sendOneMessage();
    } else if (binaryString[i] == '0') {
      sendZeroMessage();
    }
  }
  digitalWrite(RF_PIN, HIGH);
  delayMicroseconds(400);
  digitalWrite(RF_PIN, LOW);
  delay(10);
}

void sendOneMessage() {
  digitalWrite(RF_PIN, HIGH);
  delayMicroseconds(376);
  digitalWrite(RF_PIN, LOW);
  delayMicroseconds(1030);
}

void sendZeroMessage() {
  digitalWrite(RF_PIN, HIGH);
  delayMicroseconds(1032);
  digitalWrite(RF_PIN, LOW);
  delayMicroseconds(566);
}




void processSerialCommand(String inStr) {
  inStr.trim();
  if(inStr.length() == 0) return;

  
  if (inStr.startsWith("{")) {
    
    parseLedJSON(inStr);
    return;
  }

  int firstSpace = inStr.indexOf(' ');
  if (firstSpace < 0) {
    Serial.println(F("C?NFS")); 
    return;
  }
  String cmdStr = inStr.substring(0, firstSpace);
  String args = inStr.substring(firstSpace+1);

  if(cmdStr == "433fire") { 
    
    if (isValidMessage(args)) {
      String binaryString = parseBinaryString(args);
      int repetitions = parseRepetitions(args);
      if (debugMode > 0) {
        Serial.print(F("Processing 433MHz: "));
        Serial.print(binaryString);
        Serial.print(F(" x"));
        Serial.println(repetitions);
      }
      for (int i = 0; i < repetitions; i++) {
        sendBinaryString(binaryString);
      }
      if(debugMode > 0) Serial.println(F("C+ 433"));
    } else {
      Serial.println(F("CV 433")); 
    }
    return;
  }
  
  int secondSpace = args.indexOf(' ');
  if (secondSpace < 0 && cmdStr != "msync") { 
     Serial.println(F("C?NSS")); 
     return;
  }
  
  String ident = (secondSpace > 0) ? args.substring(0, secondSpace) : args; 
  String paramsStr = (secondSpace > 0) ? args.substring(secondSpace+1) : "";


  if(cmdStr == "msync") {
    uint64_t ts = atoll(paramsStr.c_str()); 
    tsOffset = ts - millis();
    
    Serial.println(F("C+ msync"));
    return;
  }

  ReceiverInfo* rinfo = getReceiverByIdent(ident, true); 
  if(!rinfo) {
    Serial.println(F("CV RNE")); 
    return;
  }
  
  
  
  uint8_t targetNodeID = rinfo->nodeID; 
  
  
  
  
  
  if (targetNodeID == 0 && rinfo->ident.length() > 0) {
      
      
      
      
      
      
      
      targetNodeID = 1; 
                        
                        
                        
                        
                        
                        
                        
      if (rinfo->nodeID == 0) targetNodeID = 1; else targetNodeID = rinfo->nodeID;

  }


  QueuedCommand qc = {0};
  qc.targetNodeID = targetNodeID;

  if(cmdStr == "fire") {
    qc.messageType = MANUAL_FIRE;
    qc.fire_position = paramsStr.toInt();
  } else if(cmdStr == "sync") { 
    qc.messageType = CLOCK_SYNC;
    qc.sync_timestamp = atoll(paramsStr.c_str());
  } else if(cmdStr == "startload") {
    qc.messageType = START_LOAD;
    int thirdSpace = paramsStr.indexOf(' ');
    qc.startload_numTargets = paramsStr.substring(0, thirdSpace).toInt();
    qc.startload_showId = paramsStr.substring(thirdSpace+1).toInt();
  } else if(cmdStr == "showload") {
    qc.messageType = SHOW_LOAD;
    int tokens[4];
    int currentIdx = 0;
    for (uint8_t i = 0; i < 4; i++){
      int sp = paramsStr.indexOf(' ', currentIdx);
      if(sp < 0) sp = paramsStr.length();
      tokens[i] = paramsStr.substring(currentIdx, sp).toInt();
      currentIdx = sp+1;
    }
    qc.showload_time_1 = tokens[0];
    qc.showload_position_1 = tokens[1];
    qc.showload_time_2 = tokens[2];
    qc.showload_position_2 = tokens[3];
  } else if(cmdStr == "showstart") {
    qc.messageType = SHOW_START;
    uint64_t ts_param = 0;
    int int_tokens[2] = {0, 0};
    int currentIdx = 0;
    for (uint8_t i = 0; i < 3; i++){ 
      int sp = paramsStr.indexOf(' ', currentIdx);
      if(sp < 0) sp = paramsStr.length();
      String valStr = paramsStr.substring(currentIdx, sp);
      if(i == 0){
        ts_param = atoll(valStr.c_str());
      } else {
        int_tokens[i-1] = atoi(valStr.c_str());
      }
      currentIdx = sp+1;
      if (currentIdx >= paramsStr.length() && i < 2) { /* error, not enough params */ break; }
    }
    qc.showstart_targetStartTime = ts_param;
    qc.showstart_numTargetsToFire = int_tokens[0];
    qc.showstart_showId = int_tokens[1];
  } else if(cmdStr == "play")   { qc.messageType = GENERIC_PLAY; }
    else if(cmdStr == "stop")  { qc.messageType = GENERIC_STOP; }
    else if(cmdStr == "reset") { qc.messageType = GENERIC_RESET; } 
    else if(cmdStr == "pause") { qc.messageType = GENERIC_PAUSE; }
    
  else {
    Serial.println(F("C?UK")); 
    return;
  }

  if (qc.messageType != 0) { 
    enqueueCommand(qc);
    if(debugMode > 0)Serial.println(F("C+ Q")); 
  } else {
    Serial.println(F("C? PE")); 
  }
}




void setup() {
  Serial.begin(115200);
  while (!Serial); 
  delay(1000); 

  SPI.begin(35, 33, 34); 
  pinMode(RF_PIN, OUTPUT); 
  pinMode(SWITCH_START_STOP_PIN, INPUT_PULLUP);
  pinMode(SWITCH_ARMING_PIN, INPUT_PULLUP);
  pinMode(SWITCH_MAN_FIRE_PIN, INPUT_PULLUP);

  setupLEDs();

  Serial.println(F("Initializing Radio..."));
  while (!radio.begin()) {
    Serial.println(F("ERROR: Radio hardware not responding!"));
    pixels.setPixelColor(5, COLOR_RED); pixels.show(); 
    delay(5000);
  }
  radio.setDataRate(RF24_250KBPS);
  radio.setPALevel(RF24_PA_MAX);
  radio.setChannel(85); 
  radio.setRetries(3, 5); 

  mesh.setNodeID(0); 
  Serial.println(F("Initializing Mesh..."));
  while (!mesh.begin()) {
    Serial.println(F("M- (Mesh begin failed, retrying)"));
    pixels.setPixelColor(5, COLOR_YELLOW); pixels.show(); 
    delay(2000);
  }
  mesh.DHCP(); 
  Serial.println(F("M+ (Mesh Master Online)"));

  
  for (int i = 0; i < NUM_PIXELS; i++) {
    pixels.setPixelColor(i, COLOR_GREEN); pixels.show(); delay(50);
    pixels.setPixelColor(i, COLOR_OFF); pixels.show();
  }
  pixels.setPixelColor(0, COLOR_GREEN); 
  pixels.show();
  ledStates[0] = 1; 
  for (int i = 1; i < NUM_PIXELS; i++) {
    ledStates[i] = 0; ledEffects[i] = 0;
  }
}

void loop() {
  uint64_t now = millis() + tsOffset;
  mesh.update();    
  
                  

  
  if (now - lastDhcpCallTime >= dhcpCallIntervalMs) {
    mesh.DHCP();
    lastDhcpCallTime = now;
    if (debugMode > 1) { 
      Serial.println(F("INFO: Periodic mesh.DHCP() called."));
    }
  }

  checkGpioStatus();
  updateLEDs();

  
  for (uint8_t i = 0; i < numReceivers; /*no increment*/) {
    if ((now - receivers[i].lastMessageTime) > receiverInactivityTimeoutMs) {
      Serial.print(F("INFO: Pruning inactive receiver: ")); Serial.println(receivers[i].ident);
      for (uint8_t j = i; j < numReceivers - 1; ++j) {
        receivers[j] = receivers[j+1];
      }
      numReceivers--;
      
    } else {
      i++; 
    }
  }


  
  while (network.available()) {
    RF24NetworkHeader header;
    uint8_t buf[32]; 
    uint8_t msgSize = network.read(header, &buf, sizeof(buf));

    uint8_t msgType = (msgSize > 0) ? buf[0] : 0;

    ReceiverInfo* r_from_msg = nullptr;
    


    if (msgType == RECEIVER_STATUS) {
      ReceiverStatusMessage* status = (ReceiverStatusMessage*)buf;
      
      if (!r_from_msg) {
          r_from_msg = getReceiverByIdent(String(status->ident), true); 
      }

      if (r_from_msg) {
        r_from_msg->nodeID = status->nodeID; 
        r_from_msg->batteryLevel = status->batteryLevel;
        r_from_msg->showId = status->showState & 0x3FFF;
        r_from_msg->loadComplete = (status->showState & (1 << 14)) ? true : false;
        r_from_msg->startReady  = (status->showState & (1 << 15)) ? true : false;
        r_from_msg->lastMessageTime = now;
        
        r_from_msg->continuity[0] = status->cont64_0;
        r_from_msg->continuity[1] = status->cont64_1;

        if (awaitingResponseForCommand && r_from_msg->nodeID == responseTargetNodeID) {
          uint32_t currentLatency = now - initialCommandDispatchTime;
          
          
          latencies[latencyNextIndex] = currentLatency;
          latencyNextIndex = (latencyNextIndex + 1) % MAX_LATENCY_SAMPLES;
          if (latencySampleCount < MAX_LATENCY_SAMPLES) {
            latencySampleCount++;
          }

          
          r_from_msg->latencies[r_from_msg->latencyNextIndex] = currentLatency;
          r_from_msg->latencyNextIndex = (r_from_msg->latencyNextIndex + 1) % MAX_LATENCY_SAMPLES;
          if (r_from_msg->latencySampleCount < MAX_LATENCY_SAMPLES) {
            r_from_msg->latencySampleCount++;
          }

          if(debugMode > 0) {
              Serial.print(F("RX_STATUS from N")); Serial.println(responseTargetNodeID);
              Serial.print(F("CMD_TO_STATUS_LATENCY: ")); Serial.print(currentLatency); Serial.println(F(" ms"));
          }
          commandDispatchTime = now; 
          awaitingResponseForCommand = false; 
        }
      } else {
         Serial.print(F("ERR: Status from unknown ident/node ")); Serial.println(status->nodeID);
      }
    } else if (msgType != 0) {
        Serial.print(F("WARN: Received unhandled message type ")); Serial.print(msgType);
        Serial.print(F(" from node ")); Serial.println(header.from_node);
    }
  }

  
  if (awaitingResponseForCommand) {
    if (now - commandDispatchTime > commandResponseTimeoutMs) {
      Serial.print(F("TIMEOUT waiting for response from Node ")); Serial.println(responseTargetNodeID);
      if(debugMode > 0) {
        Serial.print(F("CMD_TIMEOUT_LATENCY: ")); Serial.print(now - initialCommandDispatchTime); Serial.println(F(" ms"));
      }
      awaitingResponseForCommand = false; 
      
    }
  }

  if (!awaitingResponseForCommand && !isQueueEmpty()) {
    QueuedCommand cmdToSend;
    if (dequeueCommand(cmdToSend)) {
      responseTargetNodeID = cmdToSend.targetNodeID;
      
      
      if (cmdToSend.targetNodeID == 0 && cmdToSend.messageType != CLOCK_SYNC /*e.g.*/) {
          Serial.print(F("WARN: Cmd for Node 0 (master) skipped or invalid target: "));
          Serial.println(cmdToSend.messageType);
          
      } else {
        if(debugMode > 0) {
          Serial.print(F("TX CMD: ")); Serial.print(cmdToSend.messageType);
          Serial.print(F(" to N")); Serial.println(cmdToSend.targetNodeID);
        }

          switch(cmdToSend.messageType) {
            case MANUAL_FIRE:
              sendActualManualFireMessage(cmdToSend.targetNodeID, cmdToSend.fire_position);
              break;
            case CLOCK_SYNC:
              sendActualClockSyncMessage(cmdToSend.targetNodeID, cmdToSend.sync_timestamp);
              break;
            case START_LOAD:
              sendActualStartLoadMessage(cmdToSend.targetNodeID, cmdToSend.startload_numTargets, cmdToSend.startload_showId);
              break;
            case SHOW_LOAD:
              sendActualShowLoadMessage(cmdToSend.targetNodeID, cmdToSend.showload_time_1, cmdToSend.showload_position_1, cmdToSend.showload_time_2, cmdToSend.showload_position_2);
              break;
            case SHOW_START:
              sendActualShowStartMessage(cmdToSend.targetNodeID, cmdToSend.showstart_targetStartTime, cmdToSend.showstart_numTargetsToFire, cmdToSend.showstart_showId);
              break;
            case GENERIC_PLAY:
            case GENERIC_STOP:
            case GENERIC_RESET:
            case GENERIC_PAUSE:
            case RESET_DVC: 
              sendActualGenericMessage(cmdToSend.targetNodeID, cmdToSend.messageType);
              break;
            default:
              Serial.print(F("ERR: Unknown command type in queue: ")); Serial.println(cmdToSend.messageType);
              
              goto next_command_check; 
          }

          awaitingResponseForCommand = true;
          commandDispatchTime = now;
          initialCommandDispatchTime = now; 
      }
    }
  }
next_command_check:; 

  
  if (now - lastPrintTime >= 1000) { 
    lastPrintTime = now;
    DynamicJsonDocument doc(1024 + (numReceivers * 256)); 
    doc["timestamp"] = now;
    doc["q"] = cmdQueueCount;

    uint32_t totalLatencySum = 0;
    int avgLatency = 0;
    if (latencySampleCount > 0) {
      for (uint8_t i = 0; i < latencySampleCount; i++) {
        totalLatencySum += latencies[i];
      }
      avgLatency = round((float)totalLatencySum / latencySampleCount);
    }
    doc["l"] = avgLatency;

    JsonArray receiversArray = doc.createNestedArray("receivers");
    for (uint8_t i = 0; i < numReceivers; i++) {
      JsonObject receiver = receiversArray.createNestedObject();
      receiver["i"] = receivers[i].ident;
      receiver["n"] = receivers[i].nodeID;
      receiver["b"] = receivers[i].batteryLevel;
      receiver["s"] = receivers[i].showId;
      receiver["l"] = receivers[i].loadComplete ? 1 : 0; 
      receiver["r"] = receivers[i].startReady ? 1 : 0;   
      receiver["t"] = receivers[i].lastMessageTime;    
      
      
      uint32_t receiverTotalLatencySum = 0;
      int receiverAvgLatency = 0;
      if (receivers[i].latencySampleCount > 0) {
        for (uint8_t k = 0; k < receivers[i].latencySampleCount; k++) {
          receiverTotalLatencySum += receivers[i].latencies[k];
        }
        receiverAvgLatency = round((float)receiverTotalLatencySum / receivers[i].latencySampleCount);
      }
      receiver["x"] = receiverAvgLatency;

      JsonArray continuityArray = receiver.createNestedArray("c");
      for (uint8_t j = 0; j < CONTINUITY_INDEX_CT; j++) {
        continuityArray.add(receivers[i].continuity[j]);
      }
    }
    String jsonOutput;
    serializeJson(doc, jsonOutput);
    Serial.println(jsonOutput);
  }

  
  if (now - lastScheduledClockSyncTime >= clockSyncIntervalMs) {
    lastScheduledClockSyncTime = now;
    if (numReceivers > 0 && debugMode > 0) {
        Serial.println(F("INFO: Queuing clock sync for all receivers."));
    }
    for (uint8_t i = 0; i < numReceivers; i++) {
      if (receivers[i].nodeID != 0) { 
        QueuedCommand qc = {0};
        qc.targetNodeID = receivers[i].nodeID;
        qc.messageType = CLOCK_SYNC;
        qc.sync_timestamp = now; 
        enqueueCommand(qc);
      }
    }
  }

  
  if (Serial.available()) {
    String s = Serial.readStringUntil('\n');
    processSerialCommand(s);
  }
}
