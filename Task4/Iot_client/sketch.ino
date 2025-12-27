#include <Arduino.h>
#include "esp32-hal-ledc.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <time.h>

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>

static const int PIN_POT = 34;

static const int PIN_BTN_MODE = 12;
static const int PIN_BTN_TOGGLE = 13;

static const int PIN_RELAY_IN = 26;

static const int PIN_BUZZER = 27;
static const int PIN_LED_ALERT = 32;

static const int PIN_I2C_SDA = 21;
static const int PIN_I2C_SCL = 22;

static const int OLED_W = 128;
static const int OLED_H = 64;
Adafruit_SSD1306 display(OLED_W, OLED_H, &Wire, -1);

static const char* WIFI_SSID = "Wokwi-GUEST";
static const char* WIFI_PASS = "";
static const char* API_BASE = "https://ark-pzpi-23-7-varchenko-mykola.onrender.com";

static const char* USER_EMAIL = "test2@mail.com";
static const char* USER_PASSWORD = "password123";
static const int APPLIANCE_ID = 1;

static const uint32_t BUZZ_INIT_FREQ = 2000;
static const uint8_t BUZZ_RES_BITS = 8;

struct HttpResp {
  int status;
  String body;
};

struct Button {
  uint8_t pin;
  bool lastStable;
  bool lastRaw;
  uint32_t lastChangeMs;
};

static Button btnMode { (uint8_t)PIN_BTN_MODE, false, false, 0 };
static Button btnToggle { (uint8_t)PIN_BTN_TOGGLE, false, false, 0 };

static String gToken = "";

static bool gRelayOn = false;
static double sessionKwh = 0.0;

static uint8_t modeIndex = 0;
static const uint32_t AUTO_SEND_PERIOD_MS = 30000;
static uint32_t lastAutoSendMs = 0;
static const uint32_t LIMITS_POLL_PERIOD_MS = 10000;

static bool gLimitBlocked = false;
static bool gAnyThreshold = false;
static bool gAnyExceeded = false;
static float gMaxPercentUsed = -1.0f;

static bool gAlertOn = false;
static bool gForceStop = false;
static bool gSending = false;

static bool lastAlertState = false;

static QueueHandle_t qSend = nullptr;
static portMUX_TYPE gMux = portMUX_INITIALIZER_UNLOCKED;
enum NetCmdType : uint8_t {
  CMD_LOGIN = 1,
  CMD_POLL_LIMITS = 2
};

struct NetCmd {
  NetCmdType type;
};

static QueueHandle_t qCmd = nullptr;

static void enqueueCmd(NetCmdType t) {
  if (!qCmd) return;
  NetCmd c { t };
  xQueueSend(qCmd, &c, 0);
}


static bool wifiConnected();
static void connectWiFi(uint32_t timeoutMs);
static void initTimeKyiv();

static void beep(uint16_t freq, uint16_t durationMs);
static void setAlert(bool on);

static bool buttonPressed(Button& b);

static String buildDateISO();
static String todayISO();

static void uiPrintCentered(const String& s, int y);
static void drawUI(float powerKw);

static float readPowerKw();
static void relaySet(bool on);

static HttpResp httpJson(const char* method, const String& path, const String& jsonBody, bool auth);
static bool apiLogin();
static bool apiPostConsumption(double kwh);
static void apiPollAllLimitsProgress();

static void enqueueConsumption(double kwh);
static void netTask(void*);

static String buildDateISO() {
  const char* m = __DATE__;
  const char* months = "JanFebMarAprMayJunJulAugSepOctNovDec";
  char monStr[4];
  memcpy(monStr, m, 3);
  monStr[3] = 0;

  int month = (strstr(months, monStr) - months) / 3 + 1;
  int day = atoi(m + 4);
  int year = atoi(m + 7);

  char buf[11];
  snprintf(buf, sizeof(buf), "%04d-%02d-%02d", year, month, day);
  return String(buf);
}

static String todayISO() {
  struct tm t;
  if (getLocalTime(&t, 200)) {
    char buf[11];
    snprintf(buf, sizeof(buf), "%04d-%02d-%02d", t.tm_year + 1900, t.tm_mon + 1, t.tm_mday);
    return String(buf);
  }
  return buildDateISO();
}

static void initTimeKyiv() {
  configTime(2 * 3600, 0, "pool.ntp.org", "time.google.com");
  struct tm t;
  if (getLocalTime(&t, 3000)) {
    Serial.println("Time OK");
  } else {
    Serial.println("Time FAILED (fallback date will be used)");
  }
}

static bool wifiConnected() {
  return WiFi.status() == WL_CONNECTED;
}

static void connectWiFi(uint32_t timeoutMs) {
  if (wifiConnected()) return;

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.print("WiFi connecting");
  uint32_t start = millis();
  while (!wifiConnected() && (millis() - start) < timeoutMs) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  Serial.println(wifiConnected() ? "WiFi OK" : "WiFi FAILED");
}

static void beep(uint16_t freq, uint16_t durationMs) {
  ledcWriteTone(PIN_BUZZER, freq);
  delay(durationMs);
  ledcWriteTone(PIN_BUZZER, 0);
}

static void setAlert(bool on) {
  digitalWrite(PIN_LED_ALERT, on ? HIGH : LOW);
  if (on && !lastAlertState) {
    beep(2000, 150);
  }
  lastAlertState = on;
}

static bool buttonPressed(Button& b) {
  const uint32_t now = millis();
  const bool rawPressed = (digitalRead(b.pin) == LOW);

  if (rawPressed != b.lastRaw) {
    b.lastRaw = rawPressed;
    b.lastChangeMs = now;
  }

  if ((now - b.lastChangeMs) > 40) {
    if (b.lastStable != rawPressed) {
      b.lastStable = rawPressed;
      if (b.lastStable) return true;
    }
  }
  return false;
}

static void uiPrintCentered(const String& s, int y) {
  int16_t x1, y1;
  uint16_t w, h;
  display.getTextBounds(s, 0, y, &x1, &y1, &w, &h);
  int x = (OLED_W - (int)w) / 2;
  display.setCursor(x < 0 ? 0 : x, y);
  display.print(s);
}

static void drawUI(float powerKw) {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(0, 0);
  display.print("EnergyTracker IoT");

  display.setCursor(0, 12);
  display.print("WiFi:");
  display.print(wifiConnected() ? "OK" : "NO");

  display.setCursor(52, 12);
  display.print("JWT:");
  display.print(gToken.length() > 0 ? "OK" : "NO");

  display.setCursor(96, 12);
  display.print("S:");
  display.print(gSending ? "Y" : "N");

  display.setCursor(0, 22);
  display.print("Mode:");
  display.print(modeIndex == 0 ? "manual" : "auto");

  display.setCursor(0, 32);
  display.print("Relay:");
  if (gLimitBlocked) display.print("BLOCK");
  else display.print(gRelayOn ? "ON" : "OFF");

  display.setCursor(0, 42);
  display.print("P=");
  display.print(powerKw, 2);
  display.print("kW ");

  display.print("E=");
  display.print(sessionKwh, 3);
  display.print("kWh");

  display.setCursor(0, 52);
  display.print("Limit:");
  if (gMaxPercentUsed < 0) display.print("--");
  else {
    display.print(gMaxPercentUsed, 1);
    display.print("%");
  }
  if (gAnyExceeded) display.print(" EXC");
  else if (gAnyThreshold) display.print(" THR");

  display.display();
}

static float readPowerKw() {
  int raw = analogRead(PIN_POT);
  float kw = (raw / 4095.0f) * 2.5f;
  if (kw < 0) kw = 0;
  return kw;
}

static void relaySet(bool on) {
  gRelayOn = on;
  digitalWrite(PIN_RELAY_IN, on ? HIGH : LOW);
}

static void enqueueConsumption(double kwh) {
  if (!qSend) return;
  double k = round(kwh * 1000.0) / 1000.0;
  if (k < 0.001) return;
  xQueueSend(qSend, &k, 0);
}

static HttpResp httpJson(const char* method, const String& path, const String& jsonBody, bool auth) {
  HttpResp r;
  r.status = -1;
  r.body = "";

  if (!wifiConnected()) return r;

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.setTimeout(8000);

  String url = String(API_BASE) + path;
  if (!http.begin(client, url)) return r;

  http.addHeader("Content-Type", "application/json");
  if (auth && gToken.length() > 0) {
    http.addHeader("Authorization", "Bearer " + gToken);
  }

  int code = -1;
  String m = String(method);

  if (m == "GET") code = http.GET();
  else if (m == "POST") code = http.POST(jsonBody);
  else {
    http.end();
    return r;
  }

  r.status = code;
  if (code > 0) r.body = http.getString();

  http.end();
  return r;
}

static bool apiLogin() {
  StaticJsonDocument<256> doc;
  doc["email"] = USER_EMAIL;
  doc["password"] = USER_PASSWORD;

  String body;
  serializeJson(doc, body);

  HttpResp r = httpJson("POST", "/api/auth/login", body, false);
  if (r.status != 200) {
    Serial.print("Login failed: ");
    Serial.print(r.status);
    Serial.print(" body=");
    Serial.println(r.body);
    return false;
  }

  StaticJsonDocument<512> resp;
  if (deserializeJson(resp, r.body)) return false;

  const char* token = resp["token"];
  if (!token || String(token).length() == 0) return false;

  gToken = String(token);
  Serial.println("Login OK");
  return true;
}

static bool apiPostConsumption(double kwh) {
  StaticJsonDocument<512> doc;
  doc["appliance_id"] = APPLIANCE_ID;
  doc["consumption_kwh"] = kwh;
  doc["record_date"] = todayISO();
  doc["notes"] = "ESP32 session";

  String body;
  serializeJson(doc, body);

  HttpResp r = httpJson("POST", "/api/consumption", body, true);
  if (r.status == 201) return true;

  Serial.print("Post consumption failed: ");
  Serial.print(r.status);
  Serial.print(" body=");
  Serial.println(r.body);

  if (r.status == 401) {
    gToken = "";
    if (apiLogin()) {
      HttpResp r2 = httpJson("POST", "/api/consumption", body, true);
      return r2.status == 201;
    }
  }
  return false;
}

static void apiPollAllLimitsProgress() {
  String path = "/api/limits?date=" + todayISO();
  HttpResp r = httpJson("GET", path, "", true);

  if (r.status == 401) {
    gToken = "";
    if (apiLogin()) {
      r = httpJson("GET", path, "", true);
    }
  }
  if (r.status != 200) return;

  DynamicJsonDocument listDoc(4096);
  if (deserializeJson(listDoc, r.body)) return;
  if (!listDoc.is<JsonArray>()) return;

  bool thrAny = false;
  bool excAny = false;
  float maxPct = -1.0f;

  for (JsonObject lim : listDoc.as<JsonArray>()) {
    int id = lim["id"] | -1;
    if (id <= 0) continue;

    String p = "/api/limits/" + String(id) + "/progress";
    HttpResp pr = httpJson("GET", p, "", true);
    if (pr.status != 200) continue;

    DynamicJsonDocument pd(2048);
    if (deserializeJson(pd, pr.body)) continue;

    float pct = pd["percent_used"] | -1.0f;
    bool thr = pd["threshold_reached"] | false;
    bool exc = pd["limit_exceeded"] | false;

    if (pct > maxPct) maxPct = pct;
    thrAny = thrAny || thr;
    excAny = excAny || exc;
  }

  portENTER_CRITICAL(&gMux);
  gAnyThreshold = thrAny;
  gAnyExceeded = excAny;
  gMaxPercentUsed = maxPct;
  gAlertOn = thrAny || excAny;

  gLimitBlocked = excAny;

  if (excAny) gForceStop = true;
  portEXIT_CRITICAL(&gMux);
}

static void netTask(void*) {
  uint32_t lastPollMs = 0;

  for (;;) {
    if (!wifiConnected()) {
      vTaskDelay(pdMS_TO_TICKS(300));
      continue;
    }

    NetCmd cmd;
    while (qCmd && xQueueReceive(qCmd, &cmd, 0) == pdTRUE) {
      if (cmd.type == CMD_LOGIN) {
        apiLogin();
      } else if (cmd.type == CMD_POLL_LIMITS) {
        apiPollAllLimitsProgress();
      }
    }

    if (gToken.length() == 0) {
      apiLogin();
    }

    double kwh = 0.0;
    if (qSend && xQueueReceive(qSend, &kwh, pdMS_TO_TICKS(50)) == pdTRUE) {
      portENTER_CRITICAL(&gMux);
      gSending = true;
      portEXIT_CRITICAL(&gMux);

      apiPostConsumption(kwh);

      portENTER_CRITICAL(&gMux);
      gSending = false;
      portEXIT_CRITICAL(&gMux);
    }

    uint32_t now = millis();
    if (now - lastPollMs > LIMITS_POLL_PERIOD_MS) {
      lastPollMs = now;
      apiPollAllLimitsProgress();
    }

    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

void setup() {
  Serial.begin(115200);

  pinMode(PIN_BTN_MODE, INPUT_PULLUP);
  pinMode(PIN_BTN_TOGGLE, INPUT_PULLUP);

  pinMode(PIN_RELAY_IN, OUTPUT);
  relaySet(false);

  pinMode(PIN_LED_ALERT, OUTPUT);
  digitalWrite(PIN_LED_ALERT, LOW);

  if (!ledcAttach(PIN_BUZZER, BUZZ_INIT_FREQ, BUZZ_RES_BITS)) {
    Serial.println("LEDC attach failed for buzzer");
  }
  ledcWriteTone(PIN_BUZZER, 0);

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("OLED init failed");
  } else {
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    uiPrintCentered("Booting...", 28);
    display.display();
  }

  connectWiFi(15000);
  initTimeKyiv();

  qSend = xQueueCreate(6, sizeof(double));
  qCmd = xQueueCreate(6, sizeof(NetCmd));
  
  xTaskCreatePinnedToCore(netTask, "net", 12288, nullptr, 1, nullptr, 0);

  lastAutoSendMs = millis();
}

void loop() {
  const uint32_t now = millis();
  static uint32_t lastLoopMs = millis();
  const uint32_t dtMs = now - lastLoopMs;
  lastLoopMs = now;

  if (!wifiConnected()) {
    connectWiFi(8000);
  }

  float powerKw = readPowerKw();

  if (gRelayOn) {
    double dtHours = (double)dtMs / 3600000.0;
    sessionKwh += (double)powerKw * dtHours;
  }

  portENTER_CRITICAL(&gMux);
  bool alertOn = gAlertOn;
  bool forceStop = gForceStop;
  if (gForceStop) gForceStop = false;
  portEXIT_CRITICAL(&gMux);

  setAlert(alertOn);

  if (forceStop && gRelayOn) {
    relaySet(false);
    beep(900, 120);
    enqueueConsumption(sessionKwh);
    sessionKwh = 0.0;
    beep(2000, 250);
    Serial.println("LIMIT EXCEEDED -> STOP");
  }

  if (buttonPressed(btnMode)) {
    modeIndex = (modeIndex + 1) % 2;
    beep(1200, 80);
  }

  if (buttonPressed(btnToggle)) {
    if (gLimitBlocked) {
      beep(400, 120);
      Serial.println("Blocked: limit exceeded");
    } else {
      if (!gRelayOn) {
        if (gMaxPercentUsed < 0) {
          enqueueCmd(CMD_LOGIN);
          enqueueCmd(CMD_POLL_LIMITS);
        }

        sessionKwh = 0.0;
        relaySet(true);
        beep(1800, 80);
      } else {
        relaySet(false);
        beep(900, 120);
        enqueueConsumption(sessionKwh);
        sessionKwh = 0.0;
      }
    }
  }

  if (modeIndex == 1 && gRelayOn) {
    if (now - lastAutoSendMs > AUTO_SEND_PERIOD_MS) {
      lastAutoSendMs = now;
      enqueueConsumption(sessionKwh);
      sessionKwh = 0.0;
    }
  }

  static uint32_t lastUiMs = 0;
  if (now - lastUiMs > 250) {
    lastUiMs = now;
    drawUI(powerKw);
  }

  delay(10);
}
