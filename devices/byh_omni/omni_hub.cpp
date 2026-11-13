#include "omni_hub.h"
#include "omni_pins.h"

#include <WiFi.h>
#include <Preferences.h>
#include <SHA1Builder.h>
#include <base64.h>
#include <lwip/sockets.h>
#include <errno.h>

// Defaults used until a client stores its own settings with `wifi_set`.
// The SSID gets the last two MAC bytes appended so neighboring hubs differ.
#define HUB_DEFAULT_SSID_PREFIX "BYH-Hub-"
#define HUB_DEFAULT_PASSWORD    "backyardhero"

// AP address. /24 so joined phones land on 192.17.76.0/24 and DHCP starts
// at .2. The Android app probes this host (HubDefaults.HOST).
#define HUB_AP_IP_A 192
#define HUB_AP_IP_B 17
#define HUB_AP_IP_C 76
#define HUB_AP_IP_D 1

// Channels the AP may use (1-11 is legal everywhere the US rules apply).
#define HUB_WIFI_MIN_CHANNEL 1
#define HUB_WIFI_MAX_CHANNEL 11

#define HUB_HTTP_PORT           80
#define HUB_MAX_CONNECTIONS     4      // HTTP + WebSocket sockets in flight
#define HUB_MAX_WS_CLIENTS      2      // newest connection evicts the oldest
#define HUB_IN_BUFFER           2048   // per socket; caps a single WS frame
#define HUB_WS_MSG_BUFFER       2048   // reassembly of fragmented messages
#define HUB_WS_TX_BUFFER        16384  // per WS client; overflow drops lines
#define HUB_HTTP_TIMEOUT_MS     3000
#define HUB_WS_PING_INTERVAL_MS 5000
#define HUB_WS_IDLE_TIMEOUT_MS  20000
#define HUB_MAX_LINE            600

namespace omni_hub {
namespace {

const char* KEY_SSID = "wifi_ssid";
const char* KEY_PASS = "wifi_pass";
const char* KEY_RFCH = "hub_rfch";
const char* WS_GUID  = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

enum SlotState : uint8_t { SLOT_FREE = 0, SLOT_HTTP, SLOT_WS };

enum WsOpcode : uint8_t {
  WS_OP_CONT  = 0x0,
  WS_OP_TEXT  = 0x1,
  WS_OP_BIN   = 0x2,
  WS_OP_CLOSE = 0x8,
  WS_OP_PING  = 0x9,
  WS_OP_PONG  = 0xA
};

struct Slot {
  NetworkClient client;
  SlotState state = SLOT_FREE;
  bool      closeRequested = false;
  uint16_t  closeCode = 1000;
  uint32_t  openedMs = 0;
  uint32_t  lastRxMs = 0;
  uint32_t  lastPingMs = 0;
  uint32_t  wsSeq = 0;
  uint8_t*  in = nullptr;
  uint16_t  inLen = 0;
  char*     msg = nullptr;
  uint16_t  msgLen = 0;
  bool      msgActive = false;
  bool      msgOverflow = false;
  uint8_t*  tx = nullptr;
  uint16_t  txHead = 0;
  uint16_t  txLen = 0;
};

Preferences prefs;
Slot slots[HUB_MAX_CONNECTIONS];
NetworkServer server(HUB_HTTP_PORT, HUB_MAX_CONNECTIONS);
HubConfig hubCfg;
bool started = false;
bool settingsChanged = false;
uint8_t activeChannel = 0;
char activeSsid[33] = "";
uint32_t wsSeqCounter = 0;

// ---------------------------------------------------------------------------
// Persisted settings
// ---------------------------------------------------------------------------

void defaultSsid(char* out, size_t cap) {
  uint64_t mac = ESP.getEfuseMac();
  snprintf(out, cap, "%s%02X%02X", HUB_DEFAULT_SSID_PREFIX,
           (unsigned)((mac >> 32) & 0xFF), (unsigned)((mac >> 40) & 0xFF));
}

void loadWifi(char* ssid, size_t ssidCap, char* pass, size_t passCap,
              bool* customSsid, bool* customPass) {
  prefs.begin(OMNI_NVS_NAMESPACE, true);
  size_t gotSsid = prefs.getString(KEY_SSID, ssid, ssidCap);
  size_t gotPass = prefs.getString(KEY_PASS, pass, passCap);
  prefs.end();
  *customSsid = gotSsid > 0 && ssid[0] != '\0';
  *customPass = gotPass > 0 && pass[0] != '\0';
  if (!*customSsid) defaultSsid(ssid, ssidCap);
  if (!*customPass) strlcpy(pass, HUB_DEFAULT_PASSWORD, passCap);
}

uint8_t pickApChannel(uint8_t nrfChannel) {
  int nrfMhz = 2400 + nrfChannel;
  uint8_t best = HUB_WIFI_MIN_CHANNEL;
  int bestDist = -1;
  for (uint8_t ch = HUB_WIFI_MIN_CHANNEL; ch <= HUB_WIFI_MAX_CHANNEL; ch++) {
    int dist = abs((2407 + 5 * ch) - nrfMhz);
    if (dist > bestDist) { bestDist = dist; best = ch; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Socket plumbing. Teardown only happens from loop(), never from inside a
// line dispatch, so a slot can't be freed while its buffers are in use.
// ---------------------------------------------------------------------------

void ringWrite(Slot& s, const uint8_t* data, size_t len) {
  size_t tail = (s.txHead + s.txLen) % HUB_WS_TX_BUFFER;
  size_t first = HUB_WS_TX_BUFFER - tail;
  if (first > len) first = len;
  memcpy(s.tx + tail, data, first);
  if (len > first) memcpy(s.tx, data + first, len - first);
  s.txLen += len;
}

bool enqueueFrame(Slot& s, uint8_t opcode, const uint8_t* data, size_t len) {
  if (s.state != SLOT_WS || s.tx == nullptr || s.closeRequested) return false;
  uint8_t hdr[4];
  size_t hdrLen;
  hdr[0] = 0x80 | opcode;
  if (len < 126) {
    hdr[1] = (uint8_t)len;
    hdrLen = 2;
  } else if (len <= 0xFFFF) {
    hdr[1] = 126;
    hdr[2] = (uint8_t)(len >> 8);
    hdr[3] = (uint8_t)(len & 0xFF);
    hdrLen = 4;
  } else {
    return false;
  }
  if ((size_t)(HUB_WS_TX_BUFFER - s.txLen) < hdrLen + len) return false;
  ringWrite(s, hdr, hdrLen);
  if (len > 0) ringWrite(s, data, len);
  return true;
}

void drain(Slot& s) {
  if (s.tx == nullptr) return;
  int fd = s.client.fd();
  if (fd < 0) { s.closeRequested = true; return; }
  while (s.txLen > 0) {
    size_t chunk = HUB_WS_TX_BUFFER - s.txHead;
    if (chunk > s.txLen) chunk = s.txLen;
    int n = send(fd, s.tx + s.txHead, chunk, MSG_DONTWAIT);
    if (n > 0) {
      s.txHead = (s.txHead + n) % HUB_WS_TX_BUFFER;
      s.txLen -= n;
      continue;
    }
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
    s.closeRequested = true;
    break;
  }
}

// For the small HTTP / handshake responses, which always fit in the socket
// send buffer of a fresh connection.
void sendDirect(Slot& s, const char* data, size_t len) {
  int fd = s.client.fd();
  if (fd < 0) return;
  size_t sent = 0;
  for (int tries = 0; sent < len && tries < 20; tries++) {
    int n = send(fd, data + sent, len - sent, MSG_DONTWAIT);
    if (n > 0) { sent += n; continue; }
    if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK) return;
    delay(1);
  }
}

void teardown(Slot& s) {
  if (s.state == SLOT_WS && s.tx != nullptr) {
    uint8_t code[2] = { (uint8_t)(s.closeCode >> 8), (uint8_t)(s.closeCode & 0xFF) };
    s.closeRequested = false;
    enqueueFrame(s, WS_OP_CLOSE, code, sizeof(code));
    drain(s);
  }
  s.client.stop();
  s.client = NetworkClient();
  free(s.tx);
  free(s.msg);
  s.tx = nullptr;
  s.msg = nullptr;
  s.state = SLOT_FREE;
  s.closeRequested = false;
  s.closeCode = 1000;
  s.inLen = 0;
  s.msgLen = 0;
  s.msgActive = false;
  s.msgOverflow = false;
  s.txHead = 0;
  s.txLen = 0;
}

void requestClose(Slot& s, uint16_t code) {
  s.closeRequested = true;
  s.closeCode = code;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

int findHeaderEnd(const uint8_t* buf, uint16_t len) {
  for (int i = 0; i + 3 < len; i++) {
    if (buf[i] == '\r' && buf[i + 1] == '\n' && buf[i + 2] == '\r' && buf[i + 3] == '\n') return i;
  }
  return -1;
}

// Case-insensitive header lookup in a NUL-terminated request head.
bool headerValue(const char* head, const char* name, char* out, size_t cap) {
  size_t nameLen = strlen(name);
  const char* line = strstr(head, "\r\n");
  while (line != nullptr) {
    line += 2;
    if (strncasecmp(line, name, nameLen) == 0 && line[nameLen] == ':') {
      const char* v = line + nameLen + 1;
      while (*v == ' ' || *v == '\t') v++;
      const char* e = strstr(v, "\r\n");
      size_t n = e ? (size_t)(e - v) : strlen(v);
      while (n > 0 && (v[n - 1] == ' ' || v[n - 1] == '\t')) n--;
      if (n >= cap) n = cap - 1;
      memcpy(out, v, n);
      out[n] = '\0';
      return true;
    }
    line = strstr(line, "\r\n");
  }
  return false;
}

bool containsTokenCI(const char* haystack, const char* token) {
  size_t t = strlen(token);
  for (const char* p = haystack; *p; p++) {
    if (strncasecmp(p, token, t) == 0) return true;
  }
  return false;
}

void buildInfo(JsonDocument& d) {
  d["device"]      = "byh_omni";
  d["role"]        = "hub_dongle";
  d["fw"]          = hubCfg.fwVersion;
  d["bt"]          = 1;  // board type: omni (see byh_omni.ino BOARD_TYPE_*)
  d["ident"]       = hubCfg.ident;
  d["ssid"]        = activeSsid;
  d["ap_channel"]  = activeChannel;
  d["ip"]          = WiFi.softAPIP().toString();
  d["ws_path"]     = "/ws";
  d["ws_port"]     = HUB_HTTP_PORT;
  d["clients"]     = clientCount();
  d["max_clients"] = HUB_MAX_WS_CLIENTS;
}

void sendHttpResponse(Slot& s, const char* status, const char* contentType, const char* body) {
  char head[256];
  size_t bodyLen = body ? strlen(body) : 0;
  int n = snprintf(head, sizeof(head),
                   "HTTP/1.1 %s\r\n"
                   "Content-Type: %s\r\n"
                   "Content-Length: %u\r\n"
                   "Access-Control-Allow-Origin: *\r\n"
                   "Access-Control-Allow-Methods: GET, OPTIONS\r\n"
                   "Access-Control-Allow-Headers: *\r\n"
                   "Cache-Control: no-store\r\n"
                   "Connection: close\r\n\r\n",
                   status, contentType, (unsigned)bodyLen);
  if (n > 0) sendDirect(s, head, (size_t)n);
  if (bodyLen > 0) sendDirect(s, body, bodyLen);
}

void sendHello(Slot& s) {
  JsonDocument d;
  d["type"] = "hello";
  buildInfo(d);
  char buf[384];
  size_t n = serializeJson(d, buf, sizeof(buf));
  if (n > 0 && n < sizeof(buf)) enqueueFrame(s, WS_OP_TEXT, (const uint8_t*)buf, n);
}

void evictOldestWsIfFull() {
  uint8_t count = 0;
  int oldest = -1;
  for (int i = 0; i < HUB_MAX_CONNECTIONS; i++) {
    if (slots[i].state != SLOT_WS) continue;
    count++;
    if (oldest < 0 || slots[i].wsSeq < slots[oldest].wsSeq) oldest = i;
  }
  if (count >= HUB_MAX_WS_CLIENTS && oldest >= 0) {
    slots[oldest].closeCode = 1001;
    teardown(slots[oldest]);
  }
}

bool upgradeToWebSocket(Slot& s, const char* key) {
  char* msg = (char*)malloc(HUB_WS_MSG_BUFFER);
  uint8_t* tx = (uint8_t*)malloc(HUB_WS_TX_BUFFER);
  if (msg == nullptr || tx == nullptr) {
    free(msg);
    free(tx);
    return false;
  }

  SHA1Builder sha;
  sha.begin();
  sha.add((const uint8_t*)key, strlen(key));
  sha.add((const uint8_t*)WS_GUID, strlen(WS_GUID));
  sha.calculate();
  uint8_t digest[20];
  sha.getBytes(digest);
  String accept = base64::encode(digest, sizeof(digest));

  char resp[192];
  int n = snprintf(resp, sizeof(resp),
                   "HTTP/1.1 101 Switching Protocols\r\n"
                   "Upgrade: websocket\r\n"
                   "Connection: Upgrade\r\n"
                   "Sec-WebSocket-Accept: %s\r\n\r\n",
                   accept.c_str());
  sendDirect(s, resp, (size_t)n);

  s.msg = msg;
  s.tx = tx;
  s.txHead = 0;
  s.txLen = 0;
  s.state = SLOT_WS;
  s.wsSeq = ++wsSeqCounter;
  s.lastRxMs = millis();
  s.lastPingMs = s.lastRxMs;
  return true;
}

void processHttp(Slot& s) {
  int end = findHeaderEnd(s.in, s.inLen);
  if (end < 0) {
    if (s.inLen >= HUB_IN_BUFFER - 1) {
      sendHttpResponse(s, "431 Request Header Fields Too Large", "text/plain", "");
      requestClose(s, 1000);
    } else if (millis() - s.openedMs > HUB_HTTP_TIMEOUT_MS) {
      requestClose(s, 1000);
    }
    return;
  }

  char* head = (char*)s.in;
  head[end] = '\0';
  uint16_t consumed = (uint16_t)(end + 4);

  char method[8] = "";
  char path[64] = "";
  sscanf(head, "%7s %63s", method, path);
  char* query = strchr(path, '?');
  if (query) *query = '\0';

  char upgrade[32] = "";
  char key[64] = "";
  bool isUpgrade = headerValue(head, "upgrade", upgrade, sizeof(upgrade)) &&
                   containsTokenCI(upgrade, "websocket") &&
                   headerValue(head, "sec-websocket-key", key, sizeof(key));

  if (strcmp(method, "GET") == 0 && isUpgrade) {
    evictOldestWsIfFull();
    if (!upgradeToWebSocket(s, key)) {
      sendHttpResponse(s, "503 Service Unavailable", "text/plain", "out of memory");
      requestClose(s, 1000);
      return;
    }
    uint16_t leftover = s.inLen - consumed;
    if (leftover > 0) memmove(s.in, s.in + consumed, leftover);
    s.inLen = leftover;
    sendHello(s);
    drain(s);
    return;
  }

  if (strcmp(method, "OPTIONS") == 0) {
    sendHttpResponse(s, "204 No Content", "text/plain", "");
  } else if (strcmp(method, "GET") == 0 && (strcmp(path, "/api/info") == 0 || strcmp(path, "/") == 0)) {
    JsonDocument d;
    buildInfo(d);
    char body[384];
    size_t n = serializeJson(d, body, sizeof(body));
    body[n < sizeof(body) ? n : sizeof(body) - 1] = '\0';
    sendHttpResponse(s, "200 OK", "application/json", body);
  } else {
    sendHttpResponse(s, "404 Not Found", "text/plain", "not found");
  }
  requestClose(s, 1000);
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

void dispatchMessage(const char* data, size_t len) {
  static char line[HUB_MAX_LINE];
  size_t start = 0;
  for (size_t i = 0; i <= len; i++) {
    bool atEnd = (i == len);
    if (!atEnd && data[i] != '\n' && data[i] != '\r') continue;
    size_t segLen = i - start;
    if (segLen > 0 && segLen < sizeof(line)) {
      memcpy(line, data + start, segLen);
      line[segLen] = '\0';
      if (hubCfg.onLine) hubCfg.onLine(line);
    }
    start = i + 1;
  }
}

void appendMessage(Slot& s, const uint8_t* p, size_t len) {
  if (s.msgOverflow) return;
  if ((size_t)s.msgLen + len > HUB_WS_MSG_BUFFER) {
    s.msgOverflow = true;
    return;
  }
  memcpy(s.msg + s.msgLen, p, len);
  s.msgLen += len;
}

void handleFrame(Slot& s, bool fin, uint8_t op, uint8_t* p, size_t len) {
  switch (op) {
    case WS_OP_TEXT:
    case WS_OP_BIN:
      if (s.msgActive) { requestClose(s, 1002); return; }
      if (fin) {
        dispatchMessage((const char*)p, len);
      } else {
        s.msgActive = true;
        s.msgOverflow = false;
        s.msgLen = 0;
        appendMessage(s, p, len);
      }
      break;
    case WS_OP_CONT:
      if (!s.msgActive) { requestClose(s, 1002); return; }
      appendMessage(s, p, len);
      if (fin) {
        s.msgActive = false;
        if (!s.msgOverflow) dispatchMessage(s.msg, s.msgLen);
        s.msgLen = 0;
      }
      break;
    case WS_OP_PING:
      enqueueFrame(s, WS_OP_PONG, p, len);
      break;
    case WS_OP_PONG:
      break;
    case WS_OP_CLOSE:
      requestClose(s, 1000);
      break;
    default:
      requestClose(s, 1002);
      break;
  }
}

void processWsFrames(Slot& s) {
  while (s.inLen >= 2 && !s.closeRequested) {
    uint8_t b0 = s.in[0];
    uint8_t b1 = s.in[1];
    bool fin = (b0 & 0x80) != 0;
    uint8_t op = b0 & 0x0F;
    bool masked = (b1 & 0x80) != 0;
    uint64_t plen = b1 & 0x7F;
    size_t pos = 2;
    if (plen == 126) {
      if (s.inLen < 4) return;
      plen = ((uint16_t)s.in[2] << 8) | s.in[3];
      pos = 4;
    } else if (plen == 127) {
      if (s.inLen < 10) return;
      plen = 0;
      for (int k = 0; k < 8; k++) plen = (plen << 8) | s.in[2 + k];
      pos = 10;
    }
    // RFC 6455: client frames must be masked.
    if (!masked) { requestClose(s, 1002); return; }
    // readInto() keeps one byte spare, so the largest frame is 2+8+4+payload
    // within HUB_IN_BUFFER - 1.
    if (plen > HUB_IN_BUFFER - 15) { requestClose(s, 1009); return; }
    size_t frameLen = pos + 4 + (size_t)plen;
    if (s.inLen < frameLen) return;

    uint8_t* mask = s.in + pos;
    uint8_t* payload = s.in + pos + 4;
    for (size_t k = 0; k < plen; k++) payload[k] ^= mask[k & 3];
    handleFrame(s, fin, op, payload, (size_t)plen);

    uint16_t rest = s.inLen - frameLen;
    if (rest > 0) memmove(s.in, s.in + frameLen, rest);
    s.inLen = rest;
  }
}

void readInto(Slot& s) {
  int avail = s.client.available();
  if (avail <= 0) return;
  size_t room = HUB_IN_BUFFER - 1 - s.inLen;
  if (room == 0) return;
  if ((size_t)avail > room) avail = room;
  int n = s.client.read(s.in + s.inLen, avail);
  if (n > 0) {
    s.inLen += n;
    s.lastRxMs = millis();
  }
}

void acceptNew() {
  for (int guard = 0; guard < HUB_MAX_CONNECTIONS; guard++) {
    NetworkClient c = server.accept();
    if (!c) return;
    int freeIdx = -1;
    for (int i = 0; i < HUB_MAX_CONNECTIONS; i++) {
      if (slots[i].state == SLOT_FREE) { freeIdx = i; break; }
    }
    if (freeIdx < 0) {
      c.stop();
      continue;
    }
    Slot& s = slots[freeIdx];
    c.setNoDelay(true);
    s.client = c;
    s.state = SLOT_HTTP;
    s.closeRequested = false;
    s.openedMs = millis();
    s.inLen = 0;
  }
}

}  // namespace

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

bool begin(const HubConfig& cfg) {
  hubCfg = cfg;

  char ssid[33];
  char pass[64];
  bool customSsid, customPass;
  loadWifi(ssid, sizeof(ssid), pass, sizeof(pass), &customSsid, &customPass);
  activeChannel = pickApChannel(cfg.nrfChannel);

  for (int i = 0; i < HUB_MAX_CONNECTIONS; i++) {
    slots[i].in = (uint8_t*)malloc(HUB_IN_BUFFER);
    if (slots[i].in == nullptr) return false;
  }

  WiFi.persistent(false);
  WiFi.mode(WIFI_AP);
  const IPAddress apIp(HUB_AP_IP_A, HUB_AP_IP_B, HUB_AP_IP_C, HUB_AP_IP_D);
  const IPAddress apSubnet(255, 255, 255, 0);
  if (!WiFi.softAPConfig(apIp, apIp, apSubnet)) {
    Serial.println(F("HUB: softAPConfig failed"));
    return false;
  }
  if (!WiFi.softAP(ssid, pass, activeChannel, 0, HUB_MAX_CONNECTIONS)) {
    Serial.println(F("HUB: softAP start failed"));
    return false;
  }
  strlcpy(activeSsid, ssid, sizeof(activeSsid));

  server.begin();
  server.setNoDelay(true);
  started = true;

  Serial.print(F("HUB: AP \""));
  Serial.print(activeSsid);
  Serial.print(F("\" on WiFi ch "));
  Serial.print(activeChannel);
  Serial.print(F(" (nRF ch "));
  Serial.print(cfg.nrfChannel);
  Serial.print(F(") at "));
  Serial.println(WiFi.softAPIP());
  if (!customPass) Serial.println(F("HUB: using the default WiFi password -- change it with wifi_set"));
  return true;
}

void loop() {
  if (!started) return;
  acceptNew();
  uint32_t now = millis();
  for (int i = 0; i < HUB_MAX_CONNECTIONS; i++) {
    Slot& s = slots[i];
    if (s.state == SLOT_FREE) continue;
    if (!s.client.connected()) {
      s.closeCode = 1006;
      teardown(s);
      continue;
    }
    readInto(s);
    if (s.state == SLOT_HTTP) {
      processHttp(s);
    }
    if (s.state == SLOT_WS) {
      processWsFrames(s);
      // Sample after upgrade. lastRxMs is stamped with millis() during the
      // handshake, which is later than the `now` captured at the top of
      // loop(). An unsigned subtract would wrap and look like a 49-day idle
      // gap, so every new socket was closed (code 1001) in the same pass.
      now = millis();
      if (now - s.lastRxMs > HUB_WS_IDLE_TIMEOUT_MS) {
        requestClose(s, 1001);
      } else if (now - s.lastPingMs > HUB_WS_PING_INTERVAL_MS) {
        s.lastPingMs = now;
        enqueueFrame(s, WS_OP_PING, nullptr, 0);
      }
      drain(s);
    }
    if (s.closeRequested) teardown(s);
  }
}

uint8_t clientCount() {
  uint8_t n = 0;
  for (int i = 0; i < HUB_MAX_CONNECTIONS; i++) {
    if (slots[i].state == SLOT_WS && !slots[i].closeRequested) n++;
  }
  return n;
}

uint8_t stationCount() {
  return started ? WiFi.softAPgetStationNum() : 0;
}

uint8_t sendLine(const char* data, size_t len) {
  uint8_t queued = 0;
  for (int i = 0; i < HUB_MAX_CONNECTIONS; i++) {
    Slot& s = slots[i];
    if (enqueueFrame(s, WS_OP_TEXT, (const uint8_t*)data, len)) {
      queued++;
      drain(s);
    }
  }
  return queued;
}

int writeSpace() {
  int best = -1;
  for (int i = 0; i < HUB_MAX_CONNECTIONS; i++) {
    const Slot& s = slots[i];
    if (s.state != SLOT_WS || s.tx == nullptr || s.closeRequested) continue;
    int space = (int)(HUB_WS_TX_BUFFER - s.txLen) - 4;
    if (space < 0) space = 0;
    if (best < 0 || space < best) best = space;
  }
  return best < 0 ? 0 : best;
}

void flush(uint32_t timeoutMs) {
  uint32_t start = millis();
  while (millis() - start < timeoutMs) {
    bool pending = false;
    for (int i = 0; i < HUB_MAX_CONNECTIONS; i++) {
      Slot& s = slots[i];
      if (s.state != SLOT_WS || s.closeRequested) continue;
      drain(s);
      if (s.txLen > 0) pending = true;
    }
    if (!pending) return;
    delay(1);
  }
}

void wifiDescribe(JsonDocument& out) {
  char ssid[33];
  char pass[64];
  bool customSsid, customPass;
  loadWifi(ssid, sizeof(ssid), pass, sizeof(pass), &customSsid, &customPass);
  out["type"]         = "wifi_cfg";
  out["ssid"]         = ssid;
  out["ssid_default"] = !customSsid;
  // The password itself is never reported.
  out["pass_set"]     = true;
  out["pass_default"] = !customPass;
  out["hub_active"]   = started;
  if (started) {
    out["active_ssid"] = activeSsid;
    out["ap_channel"]  = activeChannel;
    out["clients"]     = clientCount();
  }
  out["reboot_required"] = settingsChanged;
}

bool wifiSet(const char* ssid, const char* pass, const char** err) {
  // A null field keeps the currently effective value.
  char curSsid[33];
  char curPass[64];
  bool customSsid, customPass;
  loadWifi(curSsid, sizeof(curSsid), curPass, sizeof(curPass), &customSsid, &customPass);
  bool writeSsid = ssid != nullptr;
  bool writePass = pass != nullptr;
  if (!writeSsid) ssid = curSsid;
  if (!writePass) pass = curPass;
  size_t ssidLen = strlen(ssid);
  size_t passLen = strlen(pass);
  if (ssidLen < 1 || ssidLen > 32) { *err = "ssid must be 1-32 bytes"; return false; }
  for (size_t i = 0; i < ssidLen; i++) {
    if ((uint8_t)ssid[i] < 0x20 || ssid[i] == 0x7F) { *err = "ssid has control characters"; return false; }
  }
  if (passLen < 8 || passLen > 63) { *err = "password must be 8-63 characters"; return false; }
  for (size_t i = 0; i < passLen; i++) {
    if (pass[i] < 0x20 || pass[i] > 0x7E) { *err = "password must be printable ASCII"; return false; }
  }
  prefs.begin(OMNI_NVS_NAMESPACE, false);
  bool ok = true;
  if (writeSsid) ok &= prefs.putString(KEY_SSID, ssid) > 0;
  if (writePass) ok &= prefs.putString(KEY_PASS, pass) > 0;
  prefs.end();
  if (!ok) { *err = "nvs write failed"; return false; }
  settingsChanged = true;
  return true;
}

void wifiReset() {
  prefs.begin(OMNI_NVS_NAMESPACE, false);
  prefs.remove(KEY_SSID);
  prefs.remove(KEY_PASS);
  prefs.end();
  settingsChanged = true;
}

uint8_t storedNrfChannel(uint8_t fallback) {
  prefs.begin(OMNI_NVS_NAMESPACE, true);
  uint8_t ch = prefs.getUChar(KEY_RFCH, 0xFF);
  prefs.end();
  return ch <= 125 ? ch : fallback;
}

void noteNrfChannel(uint8_t ch) {
  if (ch > 125 || ch == storedNrfChannel(0xFF)) return;
  prefs.begin(OMNI_NVS_NAMESPACE, false);
  prefs.putUChar(KEY_RFCH, ch);
  prefs.end();
}

uint8_t apChannel() { return activeChannel; }

}  // namespace omni_hub
