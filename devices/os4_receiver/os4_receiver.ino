#include <SPI.h>
#include <RF24.h>
#include <RF24Network.h>
#include <RF24Mesh.h>
#include <Adafruit_NeoPixel.h>

// FW_VERSION: Firmware version tracking for os4_receiver
// v1-v4: Historical versions (not documented, dates unknown)
// v5: Baseline version before tracking system (date unknown)
// v6: 2025-01-XX - Added FW_VERSION tracking system with version history comments (fixed typo: FW_VERISON -> FW_VERSION)
#define BOARD_VERISON 7
#define FW_VERSION 6
#define NODE_ID 122
const char RECEIVER_IDENT[] = "RX122";

const bool RECEIVER_USES_V1_CUES = false;
 
#if BOARD_VERISON >= 6
  #define RF24_CE_PIN 37
  #define RF24_CSN_PIN 36
#else
  #define RF24_CE_PIN 34
  #define RF24_CSN_PIN 33
#endif



#define FIRE_MS_DURATION 1000

#define LED_PIN 11
#define BATT_VOLTAGE_PIN 3
#define BOARD_CT_PIN 2
int NUM_BOARDS = 1;
int NUM_LEDS = (8 * NUM_BOARDS);


#define SHIFT_OUT_CLOCK 10
#define SHIFT_OUT_LATCH 9
#define SHIFT_OUT_OE 13
#define SHIFT_OUT_DATA 7


#define SHIFT_IN_CLOCK 6
#define SHIFT_IN_LATCH 5
#define SHIFT_IN_DATA 12

const uint16_t STATUS_INTERVAL = 2000;
const uint8_t FAILED_TX_THRESHOLD = 4;
const uint16_t INPUT_MODE_INTERVAL = 100;


bool targetFiring[128] = { false };
uint64_t fireStartTime[128] = { 0 };
bool targetFired[128] = { false }; 

bool gotCommand = false;
bool timedOut = false;
uint64_t lastCmdReceived = 0;
uint64_t lastInputModeRunTime = 0;

Adafruit_NeoPixel strip(NUM_LEDS, LED_PIN, NEO_GRB + NEO_KHZ800);

uint32_t COLOR_CONT_NEEDED = strip.Color(180, 0, 0);
uint32_t COLOR_CONT_ACHIEVED = strip.Color(0, 175, 0);
uint32_t COLOR_CONT_AVAIL = strip.Color(0, 0, 175);
uint32_t COLOR_FIRING = strip.Color(200, 200, 0);

 
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

RF24 radio(RF24_CE_PIN, RF24_CSN_PIN);
RF24Network network(radio);
RF24Mesh mesh(radio, network);

int8_t failed_tx_ct = 0;
int8_t txSetting = 0;
 



int64_t ADDITIONAL_CLOCK_TX_OFFSET = 40;

int64_t clock_offset = 0;
uint32_t targetTimes[257];
bool targetLoaded[257];
uint8_t expectedTargets = 0;
uint16_t currentShowId = 0;
bool loadComplete = false;
bool startReady = false;
uint64_t showStartTime = 0;
uint64_t showPauseTimeAcc = 0;
uint8_t txForgivenessCt=0;

bool isPlaying = false;
bool isPaused = false;
uint64_t timePaused = 0;
 
void zeroTargets(){
  memset(targetTimes, 0, sizeof(targetTimes));
  memset(targetLoaded, 0, sizeof(targetLoaded));
  memset(targetFiring, 0, sizeof(targetFiring));
  memset(fireStartTime, 0, sizeof(fireStartTime));
  memset(targetFired, 0, sizeof(targetFired));
}

void incrementFailedTXCtAndMaybeChangeTXP(){
  failed_tx_ct++;

  Serial.println("Failed TX. Incrementing counter");
  Serial.println(failed_tx_ct);

  if(failed_tx_ct > FAILED_TX_THRESHOLD){
    if(txSetting == 0){
      Serial.println("Failure count exceeded, going back to LOW pa");
      radio.setPALevel(RF24_PA_LOW);
    }else if(txSetting == 1){
      Serial.println("Failure count exceeded, going back to MIN pa");
      radio.setPALevel(RF24_PA_MIN);
    }else if(txSetting == 2){
      Serial.println("Failure count exceeded, TRYING MAX pa");
      radio.setPALevel(RF24_PA_MAX);
    }else{
      Serial.println("Failure count exceeded, going back to HIGH pa");
      radio.setPALevel(RF24_PA_HIGH);
      txSetting = 0;
    }
    failed_tx_ct = 0;
  }
}


uint64_t getSynchronizedTime() {
  return ((uint64_t)millis()) + clock_offset;
}
 


void handleManualFire(ManualFireMessage* msg){
  Serial.print("Manual Fire: Firing target at position ");
  Serial.println(msg->position);

  fireTarget(msg->position);
  
}
 
void handleClockSync(ClockSyncMessage* msg) {
  
  Serial.println("ClockSync");
  uint64_t localTime64 = (uint64_t)millis();
  
  clock_offset = (int64_t)msg->timestamp - (int64_t)localTime64;
}

 
void handleStartLoad(StartLoadMessage* msg){
  resetSystem();
  expectedTargets = msg->numTargetsToFire;
  currentShowId = msg->showId;
  zeroTargets();
  Serial.print("Begin show load: show ");
  Serial.print(currentShowId);
  Serial.print(", expecting ");
  Serial.print(expectedTargets);
  Serial.println(" targets.");
}
 
void handleShowLoad(ShowLoadMessage* msg){
  Serial.println("Show Load Message received:");
  Serial.println(msg->position_1);
  Serial.println(msg->position_2);
  Serial.println((NUM_BOARDS*8));
  if((msg->position_1 > (NUM_BOARDS*8) && msg->position_1 < 128) || (msg->position_2 > (NUM_BOARDS*8) && msg->position_2 < 128)){
    Serial.println("LOAD ERR: TARGET EXCEEDS AVAIALABLE.");
  }else{
    if(msg->position_1 < 128 && msg->time_1 > 0){
      targetTimes[msg->position_1] = msg->time_1;
      targetLoaded[msg->position_1] = true;
      Serial.print(" - Loaded target at ");
      Serial.print(msg->position_1);
      Serial.print(" with time ");
      Serial.println(msg->time_1);
    }
    if(msg->position_2 < 128 && msg->time_2 > 0){
      targetTimes[msg->position_2] = msg->time_2;
      targetLoaded[msg->position_2] = true;
      Serial.print(" - Loaded target at ");
      Serial.print(msg->position_2);
      Serial.print(" with time ");
      Serial.println(msg->time_2);
    }
  }
  
  uint8_t cnt = 0;
  for (uint8_t i=0; i<128; i++){
    if(targetLoaded[i]) cnt++;
  }
  if (cnt >= expectedTargets){
    loadComplete = true;
    Serial.println("Show load complete.");
  }
}
 
void handleShowStart(ShowStartMessage* msg){
  if(msg->showId == currentShowId && loadComplete){
    startReady = true;
    showStartTime = msg->targetStartTime;
    Serial.print("Show Start confirmed. Start time: ");
    Serial.println(showStartTime);
    Serial.print("Current clock: ");
    Serial.println(getSynchronizedTime());
  } else {
    Serial.println("Show Start rejected (mismatch or load incomplete).");
  }
}

void resetSystem(){
  expectedTargets = 0;
  currentShowId = 0;
  loadComplete = false;
  startReady = false;
  showStartTime = 0;
 
  zeroTargets();
}

void fireTarget(uint8_t target_pos){
  uint64_t now = getSynchronizedTime();
  targetFiring[target_pos] = true;
  fireStartTime[target_pos] = now;

  Serial.print("Firing target at position: ");
  Serial.println(target_pos);

  refreshFiring();
}
 
void handleGeneric(GenericMessage* msg){
  switch(msg->type){
    case GENERIC_PLAY:
      Serial.println("Generic Command: PLAY");
      if(isPlaying){
        Serial.println("Duplicate play message. Ignoring!");
      }else{
        isPlaying=true;
        if(isPaused){
          Serial.println("Resuming play from paused state");
          showPauseTimeAcc = showPauseTimeAcc + (getSynchronizedTime() - timePaused);
          Serial.println(showPauseTimeAcc);
          timePaused = 0;
        }
        isPaused=false;
        Serial.println("Now PLAYING!");
      }
      
      break;
    case GENERIC_STOP:
      Serial.println("Generic Command: STOP");
      isPlaying=false;
      
      break;
    case GENERIC_RESET:
      Serial.println("Generic Command: RESET");
      resetSystem();
      break;
    case GENERIC_PAUSE:
      Serial.println("Generic Command: PAUSE");
      isPlaying=false;
      isPaused=true;
      timePaused = getSynchronizedTime();
      
      break;
    default:
      Serial.println("Unknown Generic Command");
      break;
  }
}
 


void sendStatus(){
  Serial.println("Stat send");
  int bval = analogRead(BATT_VOLTAGE_PIN)/2;
  if(bval > 3700){
    bval=253;
  }else if(bval < 2350){
    bval=5;
  }else{
    bval = ((bval - 2320) / 15.38)*2.5;
  }

  ReceiverStatusMessage msg;
  msg.type = RECEIVER_STATUS;
  msg.batteryLevel = bval;
  
  uint16_t s = currentShowId & 0x3FFF;
  if(loadComplete) s |= (1 << 14);
  if(startReady)  s |= (1 << 15);
  msg.showState = s;
  strncpy(msg.ident, RECEIVER_IDENT, sizeof(msg.ident));
  msg.ident[sizeof(msg.ident)-1] = '\0';
  msg.nodeID = NODE_ID;

  
  uint8_t shiftInput[NUM_BOARDS];
  readInputShiftRegister(shiftInput, NUM_BOARDS);
  msg.cont64_0 = 0;
  msg.cont64_1 = 0;

  
  
  for (uint8_t i = 0; i < 8; i++) {
    if (i < NUM_BOARDS) {
      msg.cont64_0 |= ((uint64_t)shiftInput[i]) << (i * 8);
    }
  }
  
  for (uint8_t i = 0; i < 8; i++) {
    uint8_t boardIdx = i + 8;
    if (boardIdx < NUM_BOARDS) {
      msg.cont64_1 |= ((uint64_t)shiftInput[boardIdx]) << (i * 8);
    }
  }

  if(!mesh.write(&msg, RECEIVER_STATUS, sizeof(msg), 0)){
    incrementFailedTXCtAndMaybeChangeTXP();
  }
}

void sendToShiftRegister(uint64_t pos1, uint64_t pos2){

}
 
uint64_t lastStatus = 0;
uint64_t lastContinuity = 0;
bool lastSyncLightState = 0;
uint64_t lastSyncLightTime = 0;
bool fireChanged = false;

void runPlayLoop(){
  
  if (isPlaying && !isPaused) {
    uint64_t now = getSynchronizedTime();
    now = now - showPauseTimeAcc;
    uint64_t elapsed = 0;
    if(now > showStartTime){
      elapsed = now-showStartTime;
      

      
      for (uint8_t i = 0; i < 128; i++) {
        if (targetLoaded[i]) {
          
          if (!targetFiring[i] && !targetFired[i] && elapsed >= targetTimes[i]) {
            Serial.print("Firing ");
            Serial.print(i);
            Serial.print(" | ");
            Serial.print(targetTimes[i]);
            Serial.print(" | ");
            Serial.println(elapsed);
            targetFiring[i] = true;
            fireStartTime[i] = now;
            targetFired[i] = true;
            fireChanged=true;
          }
          
          else if (targetFiring[i]) {
            if (now - fireStartTime[i] >= FIRE_MS_DURATION) {
              targetFiring[i] = false;
              fireChanged=true;
            }
          }
        }
      }

      if(fireChanged){
        refreshFiring();
        fireChanged=false;
      }

      
      bool allFired = true;
      for (uint8_t i = 0; i < 128; i++) {
        if (targetLoaded[i] && !targetFired[i]) {
          allFired = false;
          break;
        }
      }
      
      if (allFired) {
        isPlaying = false;
        startReady = false;
        currentShowId=0;
        testLEDStrip_pulsingYellowFast();
        Serial.println("Show complete. Stopping playback and setting show to 0.");
      }
    }
  }
}

void testLEDStrip(){
  for(int i=0; i<NUM_LEDS; i++){
    strip.clear();
    if(i>3){
      strip.setPixelColor(i-3, strip.Color(0,40,0));
      strip.setPixelColor(i-2, strip.Color(0,80,0));
      strip.setPixelColor(i-1, strip.Color(0, 130, 0));
    }
    strip.setPixelColor(i, strip.Color(0, 210, 0));
    strip.show();
    delay(30);
  }

  for(int i=0; i<NUM_LEDS; i++){
    strip.clear();
    if(i>3){
      strip.setPixelColor(i-3, strip.Color(0,0,20));
      strip.setPixelColor(i-2, strip.Color(0,0,60));
      strip.setPixelColor(i-1, strip.Color(0, 0, 130));
    }
    strip.setPixelColor(i, strip.Color(0, 0, 210));
    strip.show();
    delay(30);
  }

  strip.clear();
  strip.show();
}

void testLEDStrip_pulsingBlue() {
  uint32_t blue = strip.Color(0, 0, 255);
  int pulseDuration = 2000 / 2;
  int steps = 50;
  int delayTime = (pulseDuration / 2) / steps;

  for (int p = 0; p < 2; p++) {
    
    for (int j = 0; j <= steps; j++) {
      uint8_t brightness = (j * 255) / steps;
      for (int i = 0; i < NUM_LEDS; i++) {
        strip.setPixelColor(i, strip.Color(0, 0, brightness));
      }
      strip.show();
      delay(delayTime);
    }
    
    for (int j = steps; j >= 0; j--) {
      uint8_t brightness = (j * 255) / steps;
      for (int i = 0; i < NUM_LEDS; i++) {
        strip.setPixelColor(i, strip.Color(0, 0, brightness));
      }
      strip.show();
      delay(delayTime);
    }
  }
  strip.clear();
  strip.show();
}

void testLEDStrip_pulsingGreen() {
  uint32_t green = strip.Color(0, 255, 0);
  int pulseDuration = 2000 / 3;
  int steps = 40;
  int delayTime = (pulseDuration / 2) / steps;

  for (int p = 0; p < 3; p++) {
    
    for (int j = 0; j <= steps; j++) {
      uint8_t brightness = (j * 255) / steps;
      for (int i = 0; i < NUM_LEDS; i++) {
        strip.setPixelColor(i, strip.Color(0, brightness, 0));
      }
      strip.show();
      delay(delayTime);
    }
    
    for (int j = steps; j >= 0; j--) {
      uint8_t brightness = (j * 255) / steps;
      for (int i = 0; i < NUM_LEDS; i++) {
        strip.setPixelColor(i, strip.Color(0, brightness, 0));
      }
      strip.show();
      delay(delayTime);
    }
  }
  strip.clear();
  strip.show();
}

void testLEDStrip_pulsingYellowFast() {
  int pulseDuration = 200;  // Much faster: 200ms instead of ~667ms
  int steps = 20;            // Fewer steps for faster animation
  int delayTime = (pulseDuration / 2) / steps;

  for (int p = 0; p < 3; p++) {
    
    for (int j = 0; j <= steps; j++) {
      uint8_t brightness = (j * 255) / steps;
      for (int i = 0; i < NUM_LEDS; i++) {
        strip.setPixelColor(i, strip.Color(brightness, brightness, 0));  // Yellow: R=G, B=0
      }
      strip.show();
      delay(delayTime);
    }
    
    for (int j = steps; j >= 0; j--) {
      uint8_t brightness = (j * 255) / steps;
      for (int i = 0; i < NUM_LEDS; i++) {
        strip.setPixelColor(i, strip.Color(brightness, brightness, 0));  // Yellow: R=G, B=0
      }
      strip.show();
      delay(delayTime);
    }
  }
  strip.clear();
  strip.show();
}

void testLEDStrip_flashingPurple() {
  uint32_t purple = strip.Color(128, 0, 128);
  int flashDuration = 50;
  int totalDuration = 1000;
  int numFlashes = totalDuration / (flashDuration * 2);

  for (int f = 0; f < numFlashes; f++) {
    for (int i = 0; i < NUM_LEDS; i++) {
      strip.setPixelColor(i, purple);
    }
    strip.show();
    delay(flashDuration);
    
    strip.clear();
    strip.show();
    delay(flashDuration);
  }
}

void testLEDStrip_smoothWave() {
  int waveSpeed = 50;
  int gradientSteps = 5;
  uint32_t skyBlue = strip.Color(0, 100, 255);

  for (int centerLed = -gradientSteps; centerLed < NUM_LEDS + gradientSteps; centerLed++) {
    strip.clear();

    
    if (centerLed >= 0 && centerLed < NUM_LEDS) {
      strip.setPixelColor(centerLed, skyBlue);
    }

    
    for (int i = 1; i <= gradientSteps; i++) {
      int ledIndex = centerLed - i;
      if (ledIndex >= 0 && ledIndex < NUM_LEDS) {
        uint8_t brightness = 255 * (gradientSteps - i) / gradientSteps;
        
        uint32_t gradientColor = strip.Color(0, (100 * brightness) / 255, brightness);
        strip.setPixelColor(ledIndex, gradientColor);
      }
    }

    
    for (int i = 1; i <= gradientSteps; i++) {
      int ledIndex = centerLed + i;
      if (ledIndex >= 0 && ledIndex < NUM_LEDS) {
        uint8_t brightness = 255 * (gradientSteps - i) / gradientSteps;
        uint32_t gradientColor = strip.Color(0, (100 * brightness) / 255, brightness);
        strip.setPixelColor(ledIndex, gradientColor);
      }
    }

    strip.show();
    delay(waveSpeed);
  }
  strip.clear();
  strip.show();
}

void testLEDStrip_smootherSweep(){
  int sweepDelay = 15; 
  int tailLength = 4;

  
  for(int i = -tailLength; i < NUM_LEDS; i++){
    strip.clear();
    for (int t = 0; t <= tailLength; t++) {
        int ledIndex = i - t;
        if (ledIndex >= 0 && ledIndex < NUM_LEDS) {
            
            uint8_t brightness = 255 * (tailLength - t) / tailLength;
            
            strip.setPixelColor(ledIndex, strip.Color(0, (210 * brightness) / 255, 0)); 
        }
    }
    strip.show();
    delay(sweepDelay);
  }

  
  for(int i = -tailLength; i < NUM_LEDS; i++){
    strip.clear();
     for (int t = 0; t <= tailLength; t++) {
        int ledIndex = i - t;
        if (ledIndex >= 0 && ledIndex < NUM_LEDS) {
            uint8_t brightness = 255 * (tailLength - t) / tailLength;
            
            strip.setPixelColor(ledIndex, strip.Color(0, 0, (210 * brightness) / 255)); 
        }
    }
    strip.show();
    delay(sweepDelay);
  }

  strip.clear();
  strip.show();
}

void setBoardCount(){
  int tolerance = 100;

  int targetY = analogRead(BOARD_CT_PIN);

  if(targetY > 8000){
    Serial.println("No Cue board detected.Defaulting to 1");
    NUM_BOARDS = 1;
    NUM_LEDS = (8 * NUM_BOARDS);
  }else{
    
    if(targetY < 1000){
      NUM_BOARDS=1;
    }else if(targetY < 1900){
      NUM_BOARDS=2;
    }else if(targetY < 2500){
      NUM_BOARDS=3;
    }else if(targetY < 3150){
      NUM_BOARDS=4;
    }else if(targetY < 3500){
      NUM_BOARDS=5;
    }else if(targetY < 4000){
      NUM_BOARDS=6;
    }else if(targetY < 4400){
      NUM_BOARDS=7;
    }else{
      NUM_BOARDS=8;
    }



    Serial.print("Setting board count to ");
    Serial.println(NUM_BOARDS);

    NUM_LEDS = (8 * NUM_BOARDS);
  }

}


void myShiftOut(uint8_t dataPin, uint8_t clockPin, uint8_t bitOrder, uint8_t val)
{
  uint8_t i;

  for (i = 0; i < 8; i++) {
    if (bitOrder == LSBFIRST)
      digitalWrite(dataPin, !!(val & (1 << i)));
    else    
      digitalWrite(dataPin, !!(val & (1 << (7 - i))));
    
    delayMicroseconds(30);         
    digitalWrite(clockPin, HIGH);
    delayMicroseconds(30);
    digitalWrite(clockPin, LOW);    
    delayMicroseconds(30);        
  }
}


void writeOutputShiftRegister(uint8_t targets[], size_t numTargets) {
  uint8_t numBytes = NUM_BOARDS;
  uint8_t shiftData[numBytes];

  
  memset(shiftData, 0, numBytes);

  
  for (size_t i = 0; i < numTargets; i++) {
    uint8_t index = targets[i];
    uint8_t boardIndex = index / 8;
    uint8_t position = index % 8;

    if (boardIndex >= NUM_BOARDS) {
      Serial.print("Error: Index ");
      Serial.print(index);
      Serial.println(" out of range!");
      continue;
    }

    
    shiftData[boardIndex] |= (1 << position);
  }

  digitalWrite(SHIFT_OUT_OE, LOW);
  digitalWrite(SHIFT_OUT_LATCH, LOW);

  
  for (int i = NUM_BOARDS - 1; i >= 0; i--) {
    myShiftOut(SHIFT_OUT_DATA, SHIFT_OUT_CLOCK, MSBFIRST, shiftData[i]);
  }

  digitalWrite(SHIFT_OUT_LATCH, HIGH);
}


void latchShiftRegister() {
  digitalWrite(SHIFT_IN_LATCH, LOW);
  delayMicroseconds(30);
  digitalWrite(SHIFT_IN_LATCH, HIGH);
  delayMicroseconds(30);
}


void readInputShiftRegister(uint8_t *buffer, uint8_t numBytes) {
  latchShiftRegister();

  for (int i = numBytes - 1; i >= 0; i--) {
    uint8_t pos = numBytes - i - 1;
    
    buffer[pos] = 0;
    
    for (int bit = 7; bit >= 0; bit--) {
      uint8_t reading = digitalRead(SHIFT_IN_DATA);
      if(RECEIVER_USES_V1_CUES){
        if(NUM_BOARDS % 2 == 1 && i%2 == 1){
          reading = !reading;
        }else if(NUM_BOARDS % 2 == 0 && i%2 == 0){
          reading = !reading;
        }
      }
      if (reading) {
        buffer[pos] |= (1 << bit);
      }
      digitalWrite(SHIFT_IN_CLOCK, HIGH);
      delayMicroseconds(20);

      

      digitalWrite(SHIFT_IN_CLOCK, LOW);
      delayMicroseconds(20);
    }
  }
}


uint8_t inputPinToBitPosition(uint8_t physicalPin) {
  
  return physicalPin - 1;
}


uint8_t bitPositionToInputPin(uint8_t bitPosition) {
  
  return bitPosition + 1;
}


void displayInputStates(uint8_t *shiftInput) {
  
  for (int i = 0; i < NUM_LEDS; i++) {
    strip.setPixelColor(i, 0);
  }
  
  
  for (int boardIndex = 0; boardIndex < NUM_BOARDS; boardIndex++) {
    for (int bitPosition = 0; bitPosition < 8; bitPosition++) {
      
      
      uint8_t physicalPin = bitPositionToInputPin(bitPosition);
      
      uint8_t ledIndex = (boardIndex * 8) + (physicalPin - 1);
      if (targetFiring[ledIndex]) {
        strip.setPixelColor(ledIndex, COLOR_FIRING);
      }else{
        if (shiftInput[boardIndex] & (1 << bitPosition)) {
          
          if(targetLoaded[(boardIndex*8)+bitPosition]){
            strip.setPixelColor(ledIndex, COLOR_CONT_ACHIEVED); 
          }else{
            strip.setPixelColor(ledIndex, COLOR_CONT_AVAIL); 
          }
        
        } else if(targetLoaded[(boardIndex*8)+bitPosition]){
          strip.setPixelColor(ledIndex, COLOR_CONT_NEEDED); 
        }
      }
    }
  }
  strip.show();
}



void refreshFiring() {
  
  int targetCount = 0;
  for (int i = 0; i < 128; i++) {
    if (targetFiring[i]) {
      targetCount++;
    }
  }
  
  
  uint8_t targets[targetCount];
  
  
  int index = 0;
  for (int i = 0; i < 128; i++) {
    if (targetFiring[i]) {
      
      if (i < NUM_LEDS) {
        strip.setPixelColor(i, COLOR_FIRING);
        Serial.print("FIRE");
        Serial.println(i);
      }
      
      
      targets[index] = i;
      index++;
    }
  }
  
  
  strip.show();
  
  
  writeOutputShiftRegister(targets, targetCount);
  
  
  Serial.print("Setting outputs: ");
  for (int i = 0; i < targetCount; i++) {
    Serial.print(targets[i]);
    Serial.print(" ");
  }
  Serial.println();

}

void handleInputMode() {
  uint8_t shiftInput[NUM_BOARDS];
  readInputShiftRegister(shiftInput, NUM_BOARDS);

  displayInputStates(shiftInput);
}
 


void setup(){
  pinMode(SHIFT_OUT_OE, OUTPUT);
  digitalWrite(SHIFT_OUT_OE, LOW);

  Serial.begin(115200);

  delay(1000);

  pinMode(LED_BUILTIN, OUTPUT);

  Serial.println("SBC");
  setBoardCount();
  Serial.println(NUM_BOARDS);

  Serial.print("Board Version: ");
  Serial.println(BOARD_VERISON);

  Serial.print("FW Version: ");
  Serial.println(FW_VERSION);

  Serial.print("Ident: ");
  Serial.println(RECEIVER_IDENT);

  for(int i = 0; i < NUM_BOARDS ; i++){
    delay(250);
    digitalWrite(LED_BUILTIN, 1);
    delay(250);
    digitalWrite(LED_BUILTIN,0);
  }

  strip.begin();
  strip.clear();
  strip.show();

  strip.updateLength(NUM_LEDS);

  testLEDStrip();
  
  
  pinMode(SHIFT_OUT_CLOCK, OUTPUT);
  pinMode(SHIFT_OUT_LATCH, OUTPUT);
  pinMode(SHIFT_OUT_DATA, OUTPUT);

    
  pinMode(SHIFT_IN_CLOCK, OUTPUT);
  pinMode(SHIFT_IN_LATCH, OUTPUT);
  pinMode(SHIFT_IN_DATA, INPUT);

  writeOutputShiftRegister({},0);
  
  if(BOARD_VERISON < 6){
    SPI.begin(36, 37, 35);
  }else{
    SPI.begin(35, 33, 34);
  }
  while(!radio.begin()){
    Serial.println("ERROR: Radio not responding!");
    delay(5000);
  }
  radio.setDataRate(RF24_250KBPS);

  if(BOARD_VERISON < 6){
    radio.setPALevel(RF24_PA_HIGH);
  }else{
    radio.setPALevel(RF24_PA_MAX);
  }
  radio.setChannel(85);
  radio.setRetries(15, 15);
  pinMode(15, OUTPUT);
 
  mesh.releaseAddress();
  mesh.setNodeID(NODE_ID);
  while(!mesh.begin()){
    Serial.println("ERROR: Mesh start failed!");
    incrementFailedTXCtAndMaybeChangeTXP();
    testLEDStrip_pulsingBlue();
  }
  zeroTargets();
  testLEDStrip_pulsingGreen();
  Serial.println("SUCCESS: Receiver started!");
  Serial.print("My name is ");
  Serial.println(RECEIVER_IDENT);

}
 
void loop(){
  mesh.update();
  network.update();

  runPlayLoop();

  uint64_t now = getSynchronizedTime();
 
  
  while(network.available()){
    RF24NetworkHeader header;
    uint8_t buf[32];
    network.read(header, &buf, sizeof(buf));
    uint8_t mType = buf[0];
    gotCommand = true;
    timedOut = false;
    switch(mType){
      case MANUAL_FIRE:
        handleManualFire((ManualFireMessage*)buf);
        break;
      case CLOCK_SYNC:
        handleClockSync((ClockSyncMessage*)buf);
        break;
      case START_LOAD:
        handleStartLoad((StartLoadMessage*)buf);
        break;
      case SHOW_LOAD:
        handleShowLoad((ShowLoadMessage*)buf);
        break;
      case SHOW_START:
        handleShowStart((ShowStartMessage*)buf);
        break;
      case GENERIC_PLAY:
      case GENERIC_STOP:
      case GENERIC_RESET:
      case GENERIC_PAUSE:
        handleGeneric((GenericMessage*)buf);
        break;
      case RESET_DVC:
        resetSystem();
      default:
        Serial.print("Unknown message type: ");
        Serial.println(mType);
        break;
    }
    Serial.println("Cmd in status out");
    sendStatus();

    if(mType == SHOW_START){
      testLEDStrip_smoothWave();
    }

    if(mType == GENERIC_RESET){
      testLEDStrip_smootherSweep();
    }
    lastCmdReceived = now;
  }

  uint16_t lst = 2000;
  if(getSynchronizedTime()<showStartTime && isPlaying){
    lst = 500;
  }

  uint64_t lastSyncTime = now;
  if(lastSyncTime%lst == 0 && lastSyncLightTime != now){
    lastSyncLightTime= lastSyncTime;
    digitalWrite(LED_BUILTIN, LOW);
  }

  uint16_t flashTime = 100;
  if(isPlaying){
    if(now<showStartTime){
      flashTime = 900;
    }else{
      flashTime = 300;
    }
  }else if(startReady){
    flashTime = 400;
  }

  if((lastSyncTime+flashTime) % lst == 0 && lastSyncLightTime != now){
    lastSyncLightTime= lastSyncTime;
    digitalWrite(LED_BUILTIN, HIGH);
  }

  
  if(now - lastCmdReceived > 10000 && gotCommand && !timedOut){
    Serial.println("Disconnect detected. Will try to ping again.");
    if(isPlaying){
      Serial.println("Disonnected while playing. Stopping show.");
      testLEDStrip_flashingPurple();
      isPlaying=false;
    }
    gotCommand=false;
    timedOut=true;
     

  }

  bool doRefresh=false;
  for (uint8_t i = 0; i < 128; i++) {
    if (targetFiring[i]) {
        if (now - fireStartTime[i] >= FIRE_MS_DURATION) {
          targetFiring[i] = false;
          doRefresh=true;
        }
    }
  }

  if(doRefresh){
    refreshFiring();
  }

  if(!isPlaying && (millis() - lastInputModeRunTime > INPUT_MODE_INTERVAL)){
    handleInputMode();
    lastInputModeRunTime = millis();
  }
 
  
  if(millis() - lastStatus > STATUS_INTERVAL && !gotCommand){
    if(timedOut){
      mesh.renewAddress();
      while(!mesh.begin()){
        incrementFailedTXCtAndMaybeChangeTXP();
        testLEDStrip_pulsingBlue();
      }
      Serial.println("Timed out status send");
    }
    Serial.println("TOS");
    sendStatus();
    lastStatus = millis();
    txForgivenessCt++;

    if(txForgivenessCt > 30){
      if(failed_tx_ct > 0){
        Serial.print(RECEIVER_IDENT);
        Serial.println(": Failed TX count forgiven.");
        failed_tx_ct = 0;
      }
    }
    
  }

}
