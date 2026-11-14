package com.backyardhero.hub.proto

import com.backyardhero.hub.net.bool
import com.backyardhero.hub.net.int
import com.backyardhero.hub.net.long
import com.backyardhero.hub.net.str
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/**
 * Dongle line protocol, mirroring what the host daemon sends over USB
 * (host/pythings/pc_daemon/protocol_handler/BYHProtocolHandler.py).
 *
 * Positions on the wire are 0-based (show / UI targets are 1-based).
 * Times in showloadn are ms from show t=0; showstart / msync use epoch ms.
 */
object Cmd {
    fun msync(epochMs: Long) = "msync 0 $epochMs"
    fun register(ident: String) = "sync $ident 0 1"
    fun forget(ident: String) = "forget $ident"
    fun fire(ident: String, target1Based: Int) = "fire $ident ${target1Based - 1}"

    /** Bilusocn 433 MHz fire. Null when the zone/target cannot be encoded. */
    fun fire433(zone: Int, target1Based: Int): String? {
        val pkt = BscFire.packet(zone, target1Based) ?: return null
        return "433fire $pkt"
    }
    fun startLoad(ident: String, cueCount: Int, showId: Int) = "startload $ident $cueCount $showId"

    /** Up to 6 (timeMs, target1Based) pairs. */
    fun showLoadN(ident: String, cues: List<Pair<Long, Int>>, repeat: Int = 2): String {
        require(cues.size in 1..SHOW_LOADN_MAX_CUES)
        val sb = StringBuilder("showloadn ").append(ident).append(' ').append(cues.size)
        for ((t, target) in cues) sb.append(' ').append(t).append(' ').append(target - 1)
        sb.append(' ').append(repeat)
        return sb.toString()
    }

    fun showStart(ident: String, startEpochMs: Long, showId: Int, repeat: Int) =
        "showstart $ident $startEpochMs 0 $showId $repeat"

    /**
     * [atEpochMs] is the synchronized time the play / pause takes effect at
     * (dongles and receivers with timed pause); 0 = on arrival.
     */
    fun play(ident: String, atEpochMs: Long = 0, repeat: Int = 5) = "play $ident $atEpochMs $repeat"
    fun pause(ident: String, atEpochMs: Long = 0, repeat: Int = 5) = "pause $ident $atEpochMs $repeat"
    fun stop(ident: String, repeat: Int = 5) = "stop $ident 0 $repeat"
    fun reset(ident: String) = "reset $ident 0"
    fun rxcfg(ident: String) = "rxcfg $ident"

    const val WIFI_GET = "wifi_get"
    const val WIFI_RESET = "wifi_reset"
    fun wifiSet(ssid: String?, pass: String?): String {
        val o = buildJsonObject {
            if (ssid != null) put("ssid", ssid)
            if (pass != null) put("pass", pass)
        }
        return "wifi_set $o"
    }

    /** Dongle status-pixel / config line (same keys as the daemon's led_states). */
    fun config(state: LedState): String = buildJsonObject {
        put("daemon_act", state.daemonAct)
        put("web_act_state", state.webAct)
        put("tx_active", state.txActive)
        put("show_load_state", state.showLoad)
        put("show_run_state", state.showRun)
        put("error_state", state.error)
        put("arm_state", state.arm)
        put("led_brightness", state.brightness.coerceIn(1, 100))
    }.toString()

    const val SHOW_LOADN_MAX_CUES = 6
}

/**
 * Bilusocn 433 MHz packet, matching
 * `BSCFireTranslator.translate_zone_target_to_tx_pkg` (repetition 8).
 *
 * Zone 1 cue 1 encodes as `>>111000110111101001111110:8<<`.
 * Zones above 123 make the host's encoder negative, so they are refused.
 */
object BscFire {
    const val ZONE_MIN = 1
    const val ZONE_MAX = 123
    const val CUES = 12

    fun packet(zone: Int, target: Int, repetition: Int = 8): String? {
        if (zone !in ZONE_MIN..ZONE_MAX || target !in 1..15 || repetition !in 1..99) return null
        val adjZone = 123 - zone
        val adjTarget = 15 - target
        val bits = (0xe3L shl 16) or (adjZone.toLong() shl 8) or (7L shl 4) or adjTarget.toLong()
        return ">>${bits.toString(2)}:$repetition<<"
    }
}

/** Values from host/pythings/pc_daemon/led_control/__init__.py. */
data class LedState(
    val daemonAct: Int = 1,
    val webAct: Int = 1,
    val txActive: Int = 2,
    val showLoad: Int = LoadLed.OFF,
    val showRun: Int = RunLed.OFF,
    val error: Int = 0,
    val arm: Int = 0,
    /** 1–100; firmware maps this onto the NeoPixel PWM range. */
    val brightness: Int = 50,
)

object LoadLed { const val OFF = 0; const val LOADED = 1; const val LOADING = 2; const val LOAD_ERROR = 3 }
object RunLed {
    const val OFF = 0; const val RUNNING = 1; const val MANUAL_FIRE = 2; const val STOPPED = 3
    const val PAUSED = 4; const val ARMED = 5; const val PRECHECK = 7; const val COUNTDOWN = 8
}

// ---------------------------------------------------------------------------
// Inbound lines
// ---------------------------------------------------------------------------

data class ReceiverUpdate(
    val ident: String,
    val node: Int?,
    val battery: Int?,
    val showId: Int?,
    val loadComplete: Boolean?,
    val startReady: Boolean?,
    val lastMessageDongleMs: Long?,
    val latencyMs: Int?,
    val successPct: Int?,
    val fw: Int?,
    val boardVersion: Int?,
    val numBoards: Int?,
    val noBoardsDetected: Boolean?,
    val cuesAvailable: Int?,
    val fireDurationMs: Int?,
    /** Two uint64 masks as raw bits: cue N (1-based) is bit (N-1)%64 of mask (N-1)/64. */
    val continuity: LongArray?,
    /**
     * `pf`: bit 0 playing, bit 1 paused. Only sent for receivers that report
     * it, so null means "unknown", not "idle".
     */
    val stateFlags: Int? = null,
    /** `rt`: average auto-retries per delivered frame x10 (link margin). */
    val retryAvgX10: Int? = null,
    /** `rc`: receiver capability bits (bit 0 status flags, bit 1 timed pause). */
    val rxCaps: Int? = null,
)

data class DongleTick(
    val timestamp: Long,
    val queue: Int,
    val queueMax: Int,
    val fw: Int,
    val rfChannel: Int,
    val avgLatencyMs: Int,
    val receivers: List<ReceiverUpdate>,
    /** Capability bits; bit 0 = the dongle acknowledges `#<seq>` commands. */
    val caps: Int = 0,
)

data class GpioStatus(
    val startStop: Int,
    val armed: Int,
    val manFire: Int,
    /** Active-low levels for header inputs 1–8. Null on firmware that doesn't send them. */
    val inputs: List<Int>? = null,
)

data class WifiConfig(
    val ok: Boolean,
    val err: String?,
    val ssid: String,
    val ssidDefault: Boolean,
    val passSet: Boolean,
    val passDefault: Boolean,
    val hubActive: Boolean,
    val activeSsid: String?,
    val apChannel: Int?,
    val rebootRequired: Boolean,
)

sealed interface Inbound {
    data class Tick(val tick: DongleTick) : Inbound
    data class RxUpd(val update: ReceiverUpdate, val freshLatency: Boolean) : Inbound
    data class RxCfg(val update: ReceiverUpdate) : Inbound
    data class Gpio(val status: GpioStatus) : Inbound
    data class Wifi(val cfg: WifiConfig) : Inbound
    data class Hello(val fw: Int?) : Inbound
    data class Warn(val message: String) : Inbound
    /** `K <seq> <result> <queue>`: 1 delivered, 0 not delivered, 2 dropped, 3 rejected. */
    data class Ack(val seq: Int, val result: Int, val queue: Int?) : Inbound
    /** Any non-JSON line (C+ acks, CV / C? errors, INFO / WARN / ERR text). */
    data class Text(val line: String) : Inbound
    data class OtherJson(val obj: JsonObject) : Inbound
}

object LineParser {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    fun parse(line: String): Inbound {
        val t = line.trim()
        if (t.startsWith("K ")) {
            val p = t.split(' ')
            val seq = p.getOrNull(1)?.toIntOrNull()
            val result = p.getOrNull(2)?.toIntOrNull()
            if (seq != null && result != null) return Inbound.Ack(seq, result, p.getOrNull(3)?.toIntOrNull())
        }
        if (!t.startsWith("{")) return Inbound.Text(t)
        val o = runCatching { json.parseToJsonElement(t).jsonObject }.getOrNull() ?: return Inbound.Text(t)
        if (o.str("gpio") == "gpio_status") {
            return Inbound.Gpio(
                GpioStatus(
                    startStop = o.int("start_stop") ?: 1,
                    armed = o.int("armed") ?: 1,
                    manFire = o.int("man_fire") ?: 1,
                    inputs = (o["inputs"] as? JsonArray)?.map { el ->
                        (el as? JsonPrimitive)?.content?.toDoubleOrNull()?.toInt() ?: 1
                    },
                )
            )
        }
        return when (o.str("type")) {
            null -> if (o.containsKey("timestamp") && o.containsKey("receivers")) Inbound.Tick(parseTick(o)) else Inbound.OtherJson(o)
            "rxupd" -> Inbound.RxUpd(parseReceiver(o), o.containsKey("x"))
            "rxcfg" -> Inbound.RxCfg(parseReceiver(o))
            "wifi_cfg" -> Inbound.Wifi(parseWifi(o))
            "hello" -> Inbound.Hello(o.int("fw"))
            "hub_warn" -> Inbound.Warn(o.str("msg") ?: "Hub warning")
            else -> Inbound.OtherJson(o)
        }
    }

    private fun parseTick(o: JsonObject): DongleTick {
        val rx = (o["receivers"] as? JsonArray)?.mapNotNull { (it as? JsonObject)?.let(::parseReceiver) } ?: emptyList()
        return DongleTick(
            timestamp = o.long("timestamp") ?: 0,
            queue = o.int("q") ?: 0,
            queueMax = o.int("qmax") ?: 0,
            fw = o.int("fw") ?: 0,
            rfChannel = o.int("ch") ?: 0,
            avgLatencyMs = o.int("l") ?: 0,
            receivers = rx,
            caps = o.int("caps") ?: 0,
        )
    }

    private fun parseReceiver(o: JsonObject): ReceiverUpdate {
        // uint64 masks; kept as raw bits in a LongArray.
        val c = (o["c"] as? JsonArray)?.let { arr ->
            LongArray(arr.size) { i -> (arr[i] as? JsonPrimitive)?.content?.toULongOrNull()?.toLong() ?: 0L }
        }
        return ReceiverUpdate(
            ident = o.str("i") ?: "",
            node = o.int("n"),
            battery = o.int("b"),
            showId = o.int("s"),
            loadComplete = o.bool("l"),
            startReady = o.bool("r"),
            lastMessageDongleMs = o.long("t"),
            latencyMs = o.int("x"),
            successPct = o.int("sp"),
            fw = o.int("fw"),
            boardVersion = o.int("bv"),
            numBoards = o.int("nb"),
            noBoardsDetected = o.bool("nbd"),
            cuesAvailable = o.int("ca"),
            fireDurationMs = o.int("fd"),
            continuity = c,
            stateFlags = o.int("pf"),
            retryAvgX10 = o.int("rt"),
            rxCaps = o.int("rc"),
        )
    }

    private fun parseWifi(o: JsonObject) = WifiConfig(
        ok = o.bool("ok") ?: true,
        err = o.str("err"),
        ssid = o.str("ssid") ?: "",
        ssidDefault = o.bool("ssid_default") ?: false,
        passSet = o.bool("pass_set") ?: false,
        passDefault = o.bool("pass_default") ?: false,
        hubActive = o.bool("hub_active") ?: false,
        activeSsid = o.str("active_ssid"),
        apChannel = o.int("ap_channel"),
        rebootRequired = o.bool("reboot_required") ?: false,
    )
}
