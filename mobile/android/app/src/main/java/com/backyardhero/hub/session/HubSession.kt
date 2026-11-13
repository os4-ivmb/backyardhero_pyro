package com.backyardhero.hub.session

import android.content.Context
import com.backyardhero.hub.net.DongleLink
import com.backyardhero.hub.net.LinkState
import com.backyardhero.hub.proto.BscFire
import com.backyardhero.hub.proto.Cmd
import com.backyardhero.hub.proto.DongleTick
import com.backyardhero.hub.proto.GpioStatus
import com.backyardhero.hub.proto.Inbound
import com.backyardhero.hub.proto.LedState
import com.backyardhero.hub.proto.LineParser
import com.backyardhero.hub.proto.LoadLed
import com.backyardhero.hub.proto.ReceiverUpdate
import com.backyardhero.hub.proto.RunLed
import com.backyardhero.hub.proto.WifiConfig
import com.backyardhero.hub.show.Show
import com.backyardhero.hub.show.StepFireMode
import com.backyardhero.hub.show.swapZone
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** Same freshness rule as the daemon (LATENCY_TO_CONSIDER_ONLINE_MS). */
const val RECEIVER_ONLINE_MS = 8_000L
/** Daemon timings (pc_daemon.py / BYHProtocolHandler.py). */
private const val SHOW_LEAD_IN_MS = 25_000L
private const val ABORT_PRE_START_MS = 10_000L
private const val LOAD_TIMEOUT_MS = 60_000L
private const val LOAD_RESEND_MS = 5_000L
private const val SEND_SPACING_MS = 30L
private const val STEP_LOCKOUT_MS = 250L

data class ReceiverState(
    val ident: String,
    val node: Int? = null,
    /** 0-256 scale from the receiver. */
    val battery: Int? = null,
    val showId: Int? = null,
    val loadComplete: Boolean = false,
    val startReady: Boolean = false,
    /** Phone clock time the receiver was last heard. */
    val lastSeenMs: Long? = null,
    val latencyMs: Int? = null,
    val successPct: Int? = null,
    val fw: Int? = null,
    val boardVersion: Int? = null,
    val numBoards: Int? = null,
    val noBoardsDetected: Boolean? = null,
    val cuesAvailable: Int? = null,
    val fireDurationMs: Int? = null,
    val continuity: LongArray? = null,
) {
    fun online(nowMs: Long): Boolean = lastSeenMs != null && nowMs - lastSeenMs < RECEIVER_ONLINE_MS
    fun ageMs(nowMs: Long): Long? = lastSeenMs?.let { nowMs - it }
    val batteryPct: Int? get() = battery?.let { (it * 100 / 256).coerceIn(0, 100) }

    /** Cues to draw: the receiver's reported count, else 8 per board, else 16. */
    val cueCount: Int
        get() = cuesAvailable?.takeIf { it > 0 }
            ?: numBoards?.takeIf { it > 0 && noBoardsDetected != true }?.let { it * 8 }
            ?: 16

    /** null when no continuity data has arrived yet. */
    fun hasContinuity(target: Int): Boolean? {
        val c = continuity ?: return null
        val bit = target - 1
        val idx = bit / 64
        if (bit < 0 || idx >= c.size) return null
        return (c[idx] ushr (bit % 64)) and 1L == 1L
    }

    fun continuityCount(): Int = (1..cueCount).count { hasContinuity(it) == true }
}

data class Switches(
    val known: Boolean = false,
    val armed: Boolean = false,
    val startEngaged: Boolean = false,
    val manualEngaged: Boolean = false,
)

data class DongleState(
    val lastTickPhoneMs: Long? = null,
    val fw: Int? = null,
    val rfChannel: Int? = null,
    val queue: Int = 0,
    val queueMax: Int = 0,
    val avgLatencyMs: Int = 0,
) {
    fun silent(nowMs: Long): Boolean = lastTickPhoneMs == null || nowMs - lastTickPhoneMs > 3_000
}

enum class ShowPhase { IDLE, LOADING, LOADED, LOAD_ERROR, STARTING, COUNTDOWN, RUNNING, PAUSED, COMPLETE }

data class ShowState(
    val phase: ShowPhase = ShowPhase.IDLE,
    /** The show on the receivers (or being loaded). */
    val show: Show? = null,
    val loadStartedMs: Long? = null,
    /** Epoch ms the receivers start the show at. */
    val startAtMs: Long? = null,
    val pausedAtMs: Long? = null,
    val message: String? = null,
    /** Index into [Show.groupedSteps]. Equal to the step count means the sequence is finished. */
    val sequenceIndex: Int = 0,
    val sequenceFiring: Boolean = false,
) {
    val hasShowLoaded: Boolean
        get() = show != null && phase in setOf(
            ShowPhase.LOADING, ShowPhase.LOADED, ShowPhase.STARTING, ShowPhase.COUNTDOWN,
            ShowPhase.RUNNING, ShowPhase.PAUSED, ShowPhase.COMPLETE,
        )
    val isLive: Boolean get() = phase in setOf(ShowPhase.STARTING, ShowPhase.COUNTDOWN, ShowPhase.RUNNING, ShowPhase.PAUSED)
}

data class LogLine(val atMs: Long, val outbound: Boolean, val text: String)

/**
 * Plays the role of the host daemon for one hub connection: keeps the
 * receiver table from the dongle's status lines, mirrors the physical
 * switches, and runs show load / start / stop and manual fire with the same
 * commands and timing the daemon uses.
 */
class HubSession(
    context: Context,
    private val scope: CoroutineScope,
    private val client: DongleLink,
) {
    private val prefs = context.getSharedPreferences("hub_session", Context.MODE_PRIVATE)

    private val _receivers = MutableStateFlow<Map<String, ReceiverState>>(emptyMap())
    val receivers: StateFlow<Map<String, ReceiverState>> = _receivers.asStateFlow()

    /** Idents the app registers with the dongle on every connect. */
    private val _registered = MutableStateFlow(prefs.getStringSet(KEY_RECEIVERS, emptySet())!!.toSortedSet())
    val registered: StateFlow<Set<String>> = _registered.asStateFlow()

    /** Bilusocn zone numbers. Transmit-only; never registered on the dongle. */
    private val _bilusocn = MutableStateFlow(loadBilusocn())
    val bilusocn: StateFlow<Set<Int>> = _bilusocn.asStateFlow()

    /** Indexes into [Show.bilusocnCues] already transmitted for the live show. */
    private val radioFired = mutableSetOf<Int>()
    /** Bumped when a new show run starts so a cancelled run cannot mark cues fired. */
    private var radioRun = 0
    private var lastStepFireMs = 0L

    private val _switches = MutableStateFlow(Switches())
    val switches: StateFlow<Switches> = _switches.asStateFlow()

    /** Header input 5–8 bound to sequence step fire. 0 means none. */
    private val _stepInput = MutableStateFlow(
        prefs.getInt(KEY_STEP_INPUT, 0).let { if (it in STEP_INPUT_MIN..STEP_INPUT_MAX) it else 0 }
    )
    val stepInput: StateFlow<Int> = _stepInput.asStateFlow()
    private val _stepListen = MutableStateFlow(false)
    val stepListen: StateFlow<Boolean> = _stepListen.asStateFlow()
    private var stepListenJob: Job? = null
    private var auxKnown = false
    private var auxClosed = BooleanArray(8)
    private val auxLockoutUntil = LongArray(8)

    private val _dongle = MutableStateFlow(DongleState())
    val dongle: StateFlow<DongleState> = _dongle.asStateFlow()

    private val _show = MutableStateFlow(ShowState())
    val show: StateFlow<ShowState> = _show.asStateFlow()

    private val _wifi = MutableStateFlow<WifiConfig?>(null)
    val wifi: StateFlow<WifiConfig?> = _wifi.asStateFlow()

    /** Dongle status-pixel brightness, 1–100. Persisted on the phone; applied on each config push. */
    private val _ledBrightness = MutableStateFlow(
        prefs.getInt(KEY_LED_BRIGHTNESS, DEFAULT_LED_BRIGHTNESS).coerceIn(1, 100)
    )
    val ledBrightness: StateFlow<Int> = _ledBrightness.asStateFlow()

    private val _log = MutableStateFlow<List<LogLine>>(emptyList())
    val log: StateFlow<List<LogLine>> = _log.asStateFlow()

    private val _events = MutableSharedFlow<String>(extraBufferCapacity = 32)
    /** Short user-facing notices (toasts / snackbars). */
    val events: SharedFlow<String> = _events.asSharedFlow()

    /** Phone ms minus dongle ms, from the last status tick. */
    private var dongleClockOffset: Long? = null
    private var showJob: Job? = null
    private var lastLed: LedState? = null
    private var wasConnected = false

    fun start() {
        scope.launch { client.lines.collect { handleLine(it) } }
        scope.launch {
            client.state.collect { st ->
                val connected = st is LinkState.Connected
                if (connected && !wasConnected) onConnected()
                if (!connected && wasConnected) onDisconnected()
                wasConnected = connected
            }
        }
        scope.launch {
            while (isActive) {
                pushLedState(force = false)
                delay(1000)
            }
        }
    }

    // ------------------------------------------------------------------
    // Connection lifecycle
    // ------------------------------------------------------------------

    private fun onConnected() {
        lastLed = null
        scope.launch {
            send(Cmd.msync(System.currentTimeMillis()))
            delay(SEND_SPACING_MS)
            for (ident in _registered.value) {
                send(Cmd.register(ident))
                delay(SEND_SPACING_MS)
            }
            send(Cmd.WIFI_GET)
            pushLedState(force = true)
        }
    }

    private fun onDisconnected() {
        _switches.value = Switches()
        _dongle.update { it.copy(lastTickPhoneMs = null) }
    }

    private fun send(line: String): Boolean {
        val ok = client.send(line)
        appendLog(LogLine(System.currentTimeMillis(), true, if (ok) line else "(not sent) $line"))
        return ok
    }

    // ------------------------------------------------------------------
    // Inbound
    // ------------------------------------------------------------------

    private fun handleLine(line: String) {
        val now = System.currentTimeMillis()
        when (val msg = LineParser.parse(line)) {
            is Inbound.Tick -> onTick(msg.tick, now)
            is Inbound.RxUpd -> mergeReceiver(msg.update, now, seenNow = msg.freshLatency, fromTick = false)
            is Inbound.RxCfg -> mergeReceiver(msg.update, now, seenNow = false, fromTick = false)
            is Inbound.Gpio -> onGpio(msg.status)
            is Inbound.Wifi -> {
                _wifi.value = msg.cfg
                appendLog(LogLine(now, false, line))
                if (!msg.cfg.ok) _events.tryEmit(msg.cfg.err ?: "WiFi settings rejected")
            }
            is Inbound.Warn -> {
                appendLog(LogLine(now, false, line))
                _events.tryEmit(msg.message)
            }
            is Inbound.Hello -> appendLog(LogLine(now, false, line))
            is Inbound.Text -> {
                appendLog(LogLine(now, false, msg.line))
                if (msg.line.startsWith("CV") || msg.line.startsWith("C?") || msg.line.startsWith("ERR")) {
                    _events.tryEmit("Dongle: ${msg.line}")
                }
            }
            is Inbound.OtherJson -> appendLog(LogLine(now, false, line))
        }
        afterStateChange(now)
    }

    private fun onTick(tick: DongleTick, now: Long) {
        dongleClockOffset = now - tick.timestamp
        _dongle.value = DongleState(
            lastTickPhoneMs = now,
            fw = tick.fw,
            rfChannel = tick.rfChannel,
            queue = tick.queue,
            queueMax = tick.queueMax,
            avgLatencyMs = tick.avgLatencyMs,
        )
        for (r in tick.receivers) mergeReceiver(r, now, seenNow = false, fromTick = true)
    }

    private fun mergeReceiver(u: ReceiverUpdate, now: Long, seenNow: Boolean, fromTick: Boolean) {
        if (u.ident.isBlank()) return
        val offset = dongleClockOffset
        val seen: Long? = when {
            seenNow -> now
            // rxupd without a fresh latency sample can carry a stale t; ignore it.
            !fromTick && u.latencyMs == null && u.fw == null -> null
            u.lastMessageDongleMs != null && u.lastMessageDongleMs > 0 && offset != null ->
                (u.lastMessageDongleMs + offset).coerceAtMost(now)
            else -> null
        }
        _receivers.update { map ->
            val old = map[u.ident] ?: ReceiverState(ident = u.ident)
            val merged = old.copy(
                node = u.node ?: old.node,
                battery = u.battery ?: old.battery,
                showId = u.showId ?: old.showId,
                loadComplete = u.loadComplete ?: old.loadComplete,
                startReady = u.startReady ?: old.startReady,
                lastSeenMs = maxOfNullable(old.lastSeenMs, seen),
                latencyMs = u.latencyMs ?: old.latencyMs,
                successPct = u.successPct ?: old.successPct,
                fw = u.fw ?: old.fw,
                boardVersion = u.boardVersion ?: old.boardVersion,
                numBoards = u.numBoards ?: old.numBoards,
                noBoardsDetected = u.noBoardsDetected ?: old.noBoardsDetected,
                cuesAvailable = u.cuesAvailable ?: old.cuesAvailable,
                fireDurationMs = u.fireDurationMs ?: old.fireDurationMs,
                continuity = u.continuity ?: old.continuity,
            )
            map + (u.ident to merged)
        }
    }

    private fun maxOfNullable(a: Long?, b: Long?): Long? = when {
        a == null -> b
        b == null -> a
        else -> maxOf(a, b)
    }

    /** gpio_status levels are active-low: 0 = switch engaged. */
    private fun onGpio(g: GpioStatus) {
        val prev = _switches.value
        val next = Switches(
            known = true,
            armed = g.armed == 0,
            startEngaged = g.startStop == 0,
            manualEngaged = g.manFire == 0,
        )
        val wasListening = _stepListen.value
        _switches.value = next
        if (wasListening && next.armed) {
            cancelStepButtonBind()
            _events.tryEmit("Binding cancelled — the arm switch is on")
        }
        g.inputs?.let { noteAuxInputs(it, wasListening, next.armed) }
        if (!prev.known) return
        onSwitchEdges(prev, next)
    }

    /**
     * First sample is the baseline. Later, a closed edge on inputs 5–8 either
     * finishes a bind or fires the current sequence step. A second edge on
     * the same input inside [STEP_BUTTON_LOCKOUT_MS] is dropped.
     */
    private fun noteAuxInputs(levels: List<Int>, listening: Boolean, armed: Boolean) {
        val closed = BooleanArray(8) { i -> levels.getOrNull(i) == 0 }
        if (!auxKnown) {
            auxClosed = closed
            auxKnown = true
            return
        }
        val now = System.currentTimeMillis()
        for (i in 4..7) {
            if (!closed[i] || auxClosed[i]) continue
            if (now < auxLockoutUntil[i]) continue
            auxLockoutUntil[i] = now + STEP_BUTTON_LOCKOUT_MS
            val input = i + 1
            if (listening) {
                if (!armed) bindStepInput(input)
                break
            } else if (_stepInput.value == input) {
                onHardwareStepPress()
            }
        }
        auxClosed = closed
    }

    fun beginStepButtonBind() {
        if (_switches.value.armed) {
            _events.tryEmit("Turn the arm switch off to bind a button")
            return
        }
        _stepListen.value = true
        stepListenJob?.cancel()
        stepListenJob = scope.launch {
            delay(STEP_BIND_TIMEOUT_MS)
            if (_stepListen.value) {
                _stepListen.value = false
                _events.tryEmit("No button press on inputs 5–8")
            }
        }
    }

    fun cancelStepButtonBind() {
        stepListenJob?.cancel()
        _stepListen.value = false
    }

    fun clearStepButton() {
        cancelStepButtonBind()
        _stepInput.value = 0
        prefs.edit().remove(KEY_STEP_INPUT).apply()
    }

    private fun bindStepInput(input: Int) {
        stepListenJob?.cancel()
        _stepListen.value = false
        _stepInput.value = input
        prefs.edit().putInt(KEY_STEP_INPUT, input).apply()
        _events.tryEmit("Input $input fires the step")
    }

    /** Bound button pressed. Same gates as Fire step, without a toast on each bump. */
    private fun onHardwareStepPress() {
        if (sequenceBlockedReason() != null) return
        fireSequenceStep(announceBlock = false)
    }

    /** Same reactions as pc_daemon.py monitor_switch. */
    private fun onSwitchEdges(prev: Switches, next: Switches) {
        val show = _show.value
        if (prev.manualEngaged != next.manualEngaged && next.manualEngaged && show.isLive) {
            stopShow("Manual fire switch engaged")
        }
        if (prev.armed != next.armed && !next.armed && show.isLive) {
            stopShow("Disarmed")
        }
        if (prev.startEngaged != next.startEngaged) {
            if (!next.armed) {
                _events.tryEmit("Start switch changed while disarmed — ignored")
                return
            }
            if (next.startEngaged) {
                when {
                    next.manualEngaged -> _events.tryEmit("Manual fire is on — show not started")
                    show.phase == ShowPhase.LOADED -> startShow()
                    show.phase == ShowPhase.PAUSED -> resumeShow()
                }
            } else {
                when (show.phase) {
                    ShowPhase.RUNNING -> pauseShow()
                    ShowPhase.STARTING, ShowPhase.COUNTDOWN -> stopShow("Start switch released")
                    else -> {}
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Receivers
    // ------------------------------------------------------------------

    fun addReceivers(idents: Collection<String>) {
        val clean = idents.map { it.trim() }.filter { it.isNotEmpty() && !it.contains(' ') }
        if (clean.isEmpty()) return
        val added = clean.filter { it !in _registered.value }
        _registered.update { (it + clean).toSortedSet() }
        prefs.edit().putStringSet(KEY_RECEIVERS, _registered.value.toSet()).apply()
        scope.launch {
            for (ident in added) {
                send(Cmd.register(ident))
                delay(SEND_SPACING_MS)
            }
        }
    }

    fun removeReceiver(ident: String) {
        _registered.update { (it - ident).toSortedSet() }
        prefs.edit().putStringSet(KEY_RECEIVERS, _registered.value.toSet()).apply()
        _receivers.update { it - ident }
        send(Cmd.forget(ident))
    }

    private fun loadBilusocn(): Set<Int> =
        prefs.getStringSet(KEY_BILUSOCN, emptySet())!!
            .mapNotNull { it.toIntOrNull() }
            .filter { it in BscFire.ZONE_MIN..BscFire.ZONE_MAX }
            .toSortedSet()

    private fun persistBilusocn() {
        prefs.edit().putStringSet(KEY_BILUSOCN, _bilusocn.value.map { it.toString() }.toSet()).apply()
    }

    fun refreshReceiverConfig(ident: String) {
        send(Cmd.rxcfg(ident))
    }

    fun addBilusocn(zones: Collection<Int>) {
        val clean = zones.filter { it in BscFire.ZONE_MIN..BscFire.ZONE_MAX }
        if (clean.isEmpty()) return
        _bilusocn.update { (it + clean).toSortedSet() }
        persistBilusocn()
    }

    fun removeBilusocn(zone: Int) {
        _bilusocn.update { (it - zone).toSortedSet() }
        persistBilusocn()
    }

    // ------------------------------------------------------------------
    // Manual fire
    // ------------------------------------------------------------------

    /** null when allowed, else why not (same gates as the host). */
    fun manualFireBlockedReason(): String? {
        val sw = _switches.value
        return when {
            client.state.value !is LinkState.Connected -> "Not connected to the hub"
            !sw.known -> "Waiting for switch status from the hub"
            _show.value.hasShowLoaded -> "Unload the show to use manual fire"
            !sw.armed -> "Arm switch is off"
            !sw.startEngaged -> "Start switch is off"
            !sw.manualEngaged -> "Manual fire switch is off"
            else -> null
        }
    }

    fun fire(ident: String, target: Int): Boolean {
        val blocked = manualFireBlockedReason()
        if (blocked != null) {
            _events.tryEmit(blocked)
            return false
        }
        return send(Cmd.fire(ident, target))
    }

    /** Direct 433 MHz fire. The zone is not a polled receiver. */
    fun fireBilusocn(zone: Int, target: Int): Boolean {
        val blocked = manualFireBlockedReason()
        if (blocked != null) {
            _events.tryEmit(blocked)
            return false
        }
        val line = Cmd.fire433(zone, target)
        if (line == null) {
            _events.tryEmit("Zone $zone cue $target can't be encoded")
            return false
        }
        return send(line)
    }

    // ------------------------------------------------------------------
    // Manual sequence (step fire). Not loaded onto receivers.
    // ------------------------------------------------------------------

    /** Same physical gates as manual fire, without the "unload the show" check. */
    fun sequenceBlockedReason(): String? {
        val sw = _switches.value
        val st = _show.value
        val show = st.show
        val steps = show?.groupedSteps().orEmpty()
        return when {
            client.state.value !is LinkState.Connected -> "Not connected to the hub"
            show == null || !show.isSequence || st.phase != ShowPhase.LOADED -> "Load a sequence first"
            st.sequenceFiring -> "A step is still firing"
            st.sequenceIndex >= steps.size -> "Every step has been fired"
            !sw.known -> "Waiting for switch status from the hub"
            !sw.armed -> "Arm switch is off"
            !sw.startEngaged -> "Start switch is off"
            !sw.manualEngaged -> "Manual fire switch is off"
            else -> null
        }
    }

    fun fireSequenceStep(announceBlock: Boolean = true) {
        val now = System.currentTimeMillis()
        if (now - lastStepFireMs < STEP_LOCKOUT_MS) return
        val blocked = sequenceBlockedReason()
        if (blocked != null) {
            if (announceBlock) _events.tryEmit(blocked)
            return
        }
        val show = _show.value.show ?: return
        val groups = show.groupedSteps()
        val index = _show.value.sequenceIndex
        val (step, cues) = groups.getOrNull(index) ?: return
        lastStepFireMs = now
        _show.update { it.copy(sequenceIndex = index + 1, sequenceFiring = cues.isNotEmpty(), message = null) }
        if (cues.isEmpty()) return
        showJob?.cancel()
        showJob = scope.launch {
            try {
                val gap = if (step.fireMode == StepFireMode.STAGGERED) step.intervalMs.toLong() else 0L
                cues.forEachIndexed { n, cue ->
                    if (n > 0 && gap > 0) delay(gap)
                    if (sequenceGateLost()) {
                        _events.tryEmit("Step cancelled — a switch turned off")
                        return@launch
                    }
                    transmitCue(cue)
                    if (gap == 0L && n < cues.lastIndex) delay(SEND_SPACING_MS)
                }
            } finally {
                _show.update { it.copy(sequenceFiring = false) }
            }
        }
    }

    fun cancelSequenceFire() {
        if (!_show.value.sequenceFiring) return
        showJob?.cancel()
        _show.update {
            it.copy(sequenceFiring = false, message = "Remaining cues in this step were cancelled")
        }
    }

    /** Move the step cursor. Cancels cues from the current step that haven't been sent. */
    fun jogSequence(delta: Int) {
        val show = _show.value.show ?: return
        if (!show.isSequence) return
        if (_show.value.sequenceFiring) showJob?.cancel()
        val last = show.groupedSteps().size
        _show.update {
            it.copy(
                sequenceFiring = false,
                sequenceIndex = (it.sequenceIndex + delta).coerceIn(0, last),
                message = null,
            )
        }
    }

    /**
     * Point every cue aimed at [from] at [toRaw] on the loaded show.
     * Timeline shows are reloaded so the new receiver gets the cues and the
     * old one is reset. Returns the updated show, or null if the swap was refused.
     */
    fun swapLoadedReceiver(from: String, toRaw: String): Show? {
        val st = _show.value
        val show = st.show
        when {
            show == null -> { _events.tryEmit("Load a show first"); return null }
            st.isLive || st.sequenceFiring -> { _events.tryEmit("Stop the show before swapping a receiver"); return null }
            st.phase != ShowPhase.LOADED && st.phase != ShowPhase.LOAD_ERROR && st.phase != ShowPhase.COMPLETE -> {
                _events.tryEmit("Wait until the show finishes loading")
                return null
            }
        }
        val current = show ?: return null
        val (updated, err) = current.swapZone(from, toRaw)
        if (err != null) { _events.tryEmit(err); return null }
        if (!updated.isSequence && _switches.value.startEngaged) {
            _events.tryEmit("Turn the start switch off before swapping")
            return null
        }
        val moved = current.cues.zip(updated.cues).firstOrNull { (old, new) -> old.zone != new.zone }?.second
        val dest = moved?.zone
        if (dest != null) {
            if (moved?.native == true) addReceivers(listOf(dest)) else dest.toIntOrNull()?.let { addBilusocn(listOf(it)) }
        }
        val fromWasNative = current.cues.any { it.zone == from && it.native }
        if (!updated.isSequence && fromWasNative && dest != from) {
            scope.launch { send(Cmd.reset(from)) }
        }
        if (updated.isSequence) {
            _show.update { it.copy(show = updated, message = "$from is now ${dest ?: toRaw.trim()}") }
        } else {
            loadShow(updated)
        }
        _events.tryEmit("$from replaced with ${dest ?: toRaw.trim()}")
        return updated
    }

    private fun sequenceGateLost(): Boolean {
        val sw = _switches.value
        return client.state.value !is LinkState.Connected || !sw.armed || !sw.startEngaged || !sw.manualEngaged
    }

    private fun transmitCue(cue: com.backyardhero.hub.show.ShowCue): Boolean {
        val line = if (cue.native) {
            Cmd.fire(cue.zone, cue.target)
        } else {
            cue.zone.toIntOrNull()?.let { Cmd.fire433(it, cue.target) }
        }
        if (line == null) {
            _events.tryEmit("Can't fire ${cue.zone} cue ${cue.target}")
            return false
        }
        return send(line)
    }

    // ------------------------------------------------------------------
    // Show load / start / stop
    // ------------------------------------------------------------------

    fun loadShow(show: Show) {
        val st = _show.value
        if (st.isLive) { _events.tryEmit("Stop the running show first"); return }
        if (!show.isSequence && _switches.value.startEngaged) {
            _events.tryEmit("Turn the start switch off before loading")
            return
        }
        if (show.isSequence) {
            loadSequence(show)
            return
        }
        if (show.nativeCues.isEmpty() && show.bilusocnCues.isEmpty()) {
            _events.tryEmit("This show has no cues")
            return
        }
        addReceivers(show.receivers)
        addBilusocn(show.bilusocnZones)
        val skippedZones = show.bilusocnCues.mapNotNull { it.zone.toIntOrNull() }
            .filter { it !in BscFire.ZONE_MIN..BscFire.ZONE_MAX }
            .distinct()
        if (skippedZones.isNotEmpty()) {
            _events.tryEmit("Bilusocn zones ${skippedZones.joinToString()} can't be encoded (use 1–${BscFire.ZONE_MAX})")
        }
        radioFired.clear()
        radioRun++
        showJob?.cancel()
        val note = radioNote(show)
        if (show.nativeCues.isEmpty()) {
            _show.value = ShowState(phase = ShowPhase.LOADED, show = show, message = note)
            _events.tryEmit("433 MHz show ready — cues fire from this phone")
            return
        }
        _show.value = ShowState(
            phase = ShowPhase.LOADING,
            show = show,
            loadStartedMs = System.currentTimeMillis(),
            message = note,
        )
        showJob = scope.launch { runLoad(show) }
    }

    private fun loadSequence(show: Show) {
        if (show.steps.isEmpty()) { _events.tryEmit("This sequence has no steps"); return }
        val previous = _show.value.show
        showJob?.cancel()
        radioRun++
        radioFired.clear()
        if (previous != null && !previous.isSequence) {
            scope.launch { previous.receivers.forEach { send(Cmd.reset(it)); delay(SEND_SPACING_MS) } }
        }
        addReceivers(show.receivers)
        addBilusocn(show.bilusocnZones)
        _show.value = ShowState(
            phase = ShowPhase.LOADED,
            show = show,
            message = "Manual sequence. Fire each step from this phone — nothing is loaded onto the receivers.",
        )
    }

    private fun radioNote(show: Show): String? = when {
        show.bilusocnCues.isEmpty() -> null
        else -> "${show.bilusocnCues.size} 433 MHz cues fire from this phone while the show runs. Keep it open."
    }

    private suspend fun runLoad(show: Show) {
        val started = System.currentTimeMillis()
        delay(200)
        for (ident in show.receivers) {
            sendLoad(show, ident, skipStartLoad = false)
        }
        var lastResend = System.currentTimeMillis()
        while (scope.isActive) {
            delay(500)
            val pending = pendingLoad(show)
            if (pending.isEmpty()) {
                _show.update { it.copy(phase = ShowPhase.LOADED) }
                _events.tryEmit("Show loaded on ${show.receivers.size} receiver(s)")
                return
            }
            val now = System.currentTimeMillis()
            if (now - started > LOAD_TIMEOUT_MS) {
                for (ident in pending) {
                    send(Cmd.reset(ident))
                    delay(SEND_SPACING_MS)
                }
                _show.update {
                    it.copy(phase = ShowPhase.LOAD_ERROR, message = "Load timed out on ${pending.joinToString()}")
                }
                return
            }
            if (now - lastResend > LOAD_RESEND_MS) {
                lastResend = now
                for (ident in pending) {
                    val alreadyStarted = _receivers.value[ident]?.showId == show.id
                    sendLoad(show, ident, skipStartLoad = alreadyStarted)
                }
            }
        }
    }

    private suspend fun sendLoad(show: Show, ident: String, skipStartLoad: Boolean) {
        val cues = show.cuesFor(ident)
        if (!skipStartLoad) {
            send(Cmd.startLoad(ident, cues.size, show.id))
            delay(50)
        }
        for (chunk in cues.chunked(Cmd.SHOW_LOADN_MAX_CUES)) {
            send(Cmd.showLoadN(ident, chunk.map { it.fireTimeMs to it.target }))
            delay(SEND_SPACING_MS)
        }
    }

    fun pendingLoad(show: Show): List<String> = show.receivers.filter { ident ->
        val r = _receivers.value[ident]
        r == null || r.showId != show.id || !r.loadComplete
    }

    /** Issues to show the operator before starting; empty when all good. */
    fun precheck(): List<String> {
        val show = _show.value.show ?: return listOf("No show loaded")
        val now = System.currentTimeMillis()
        val issues = mutableListOf<String>()
        for (ident in show.receivers) {
            val r = _receivers.value[ident]
            when {
                r == null || !r.online(now) -> issues += "$ident is offline"
                (r.batteryPct ?: 100) < 20 -> issues += "$ident battery ${r.batteryPct}%"
            }
            if (r != null) {
                val open = show.cuesFor(ident).count { r.hasContinuity(it.target) == false }
                if (open > 0) issues += "$ident: $open cue(s) without continuity"
            }
        }
        return issues
    }

    fun startBlockedReason(): String? {
        val sw = _switches.value
        val st = _show.value
        return when {
            client.state.value !is LinkState.Connected -> "Not connected to the hub"
            st.phase != ShowPhase.LOADED -> "Load a show first"
            !sw.known -> "Waiting for switch status from the hub"
            !sw.armed -> "Arm switch is off"
            sw.manualEngaged -> "Manual fire switch is on"
            else -> null
        }
    }

    fun startShow() {
        val blocked = startBlockedReason()
        if (blocked != null) { _events.tryEmit(blocked); return }
        val show = _show.value.show ?: return
        if (show.isSequence) { _events.tryEmit("Fire sequence steps with the step button"); return }
        showJob?.cancel()
        radioFired.clear()
        val run = ++radioRun
        _show.update { it.copy(phase = ShowPhase.STARTING, message = null, pausedAtMs = null) }
        showJob = scope.launch { runShow(show, run) }
    }

    private suspend fun runShow(show: Show, run: Int) {
        send(Cmd.msync(System.currentTimeMillis()))
        delay(200)
        val startAt = System.currentTimeMillis() + SHOW_LEAD_IN_MS
        _show.update { it.copy(phase = ShowPhase.STARTING, startAtMs = startAt) }
        invalidateStartReady(show)
        broadcastShowStart(show, startAt, repeat = 6)

        // Wait for every receiver to report startReady.
        var lastRetry = System.currentTimeMillis()
        while (scope.isActive) {
            val notReady = show.receivers.filter { _receivers.value[it]?.startReady != true }
            if (notReady.isEmpty()) break
            val now = System.currentTimeMillis()
            if (now > startAt - ABORT_PRE_START_MS) {
                stopShow("Not ready in time: ${notReady.joinToString()}")
                return
            }
            if (now - lastRetry > 2_000) {
                lastRetry = now
                for (ident in notReady) {
                    send(Cmd.showStart(ident, startAt, show.id, repeat = 5))
                    delay(SEND_SPACING_MS)
                }
            }
            delay(200)
        }

        _show.update { it.copy(phase = ShowPhase.COUNTDOWN) }
        while (scope.isActive && System.currentTimeMillis() < startAt) {
            for (ident in show.receivers) {
                send(Cmd.play(ident))
                delay(SEND_SPACING_MS)
            }
            val remaining = startAt - System.currentTimeMillis()
            delay(minOf(3_000L, remaining.coerceAtLeast(0)))
        }

        _show.update { it.copy(phase = ShowPhase.RUNNING) }
        runUntilShowEnd(show, startAt, run)
    }

    /**
     * Bilusocn cues are not stored on a receiver. Transmit each one when show
     * time reaches it, the same way the host daemon's schedule calls
     * `fire_item` for `BILUSOCN_433_TX_ONLY` rows.
     */
    private suspend fun runRadioCues(show: Show, startAt: Long, run: Int) {
        val cues = show.bilusocnCues
        for ((index, cue) in cues.withIndex()) {
            if (run != radioRun || index in radioFired) continue
            val wait = startAt + cue.fireTimeMs - System.currentTimeMillis()
            if (wait > 0) delay(wait)
            coroutineContext.ensureActive()
            if (run != radioRun) return
            val zone = cue.zone.toIntOrNull()
            val line = zone?.let { Cmd.fire433(it, cue.target) }
            if (line == null) {
                _events.tryEmit("Bilusocn zone ${cue.zone} cue ${cue.target} can't be encoded")
                radioFired += index
                continue
            }
            if (send(line)) radioFired += index
        }
    }

    private suspend fun runUntilShowEnd(show: Show, startAt: Long, run: Int) {
        coroutineScope {
            val radio = launch { runRadioCues(show, startAt, run) }
            val endAt = startAt + show.lastCueMs + 3_000
            while (isActive && System.currentTimeMillis() < endAt) delay(250)
            radio.join()
        }
        _show.update { cur ->
            if (cur.phase == ShowPhase.RUNNING) cur.copy(phase = ShowPhase.COMPLETE, message = "Show complete") else cur
        }
    }

    private fun invalidateStartReady(show: Show) {
        _receivers.update { map ->
            map.mapValues { (k, v) -> if (k in show.receivers) v.copy(startReady = false) else v }
        }
    }

    private suspend fun broadcastShowStart(show: Show, startAt: Long, repeat: Int) {
        for (ident in show.receivers) {
            send(Cmd.showStart(ident, startAt, show.id, repeat))
            delay(SEND_SPACING_MS)
        }
    }

    fun pauseShow() {
        val st = _show.value
        val show = st.show ?: return
        if (st.phase != ShowPhase.RUNNING) return
        showJob?.cancel()
        _show.update { it.copy(phase = ShowPhase.PAUSED, pausedAtMs = System.currentTimeMillis()) }
        scope.launch { show.receivers.forEach { send(Cmd.pause(it)); delay(SEND_SPACING_MS) } }
    }

    fun resumeShow() {
        val st = _show.value
        val show = st.show ?: return
        if (st.phase != ShowPhase.PAUSED) return
        if (!_switches.value.armed) { _events.tryEmit("Arm switch is off"); return }
        val pausedFor = System.currentTimeMillis() - (st.pausedAtMs ?: System.currentTimeMillis())
        val startAt = (st.startAtMs ?: System.currentTimeMillis()) + pausedFor
        val run = radioRun
        _show.update { it.copy(phase = ShowPhase.RUNNING, startAtMs = startAt, pausedAtMs = null) }
        showJob = scope.launch {
            show.receivers.forEach { send(Cmd.play(it)); delay(SEND_SPACING_MS) }
            runUntilShowEnd(show, startAt, run)
        }
    }

    fun stopShow(reason: String? = null) {
        val st = _show.value
        val show = st.show ?: return
        if (show.isSequence) {
            showJob?.cancel()
            _show.update { it.copy(sequenceFiring = false, message = reason ?: "Stopped") }
            return
        }
        radioRun++
        showJob?.cancel()
        val wasLive = st.isLive
        _show.update {
            it.copy(
                phase = if (wasLive) ShowPhase.LOADED else it.phase,
                startAtMs = null,
                pausedAtMs = null,
                message = reason?.let { r -> "Stopped: $r" } ?: "Stopped",
            )
        }
        if (reason != null) _events.tryEmit("Show stopped: $reason")
        scope.launch { show.receivers.forEach { send(Cmd.stop(it)); delay(SEND_SPACING_MS) } }
        // Receivers need a fresh load after a stop; mirror the host by
        // treating the show as loaded only once they report it again.
        if (wasLive) {
            showJob = scope.launch { runLoad(show) }
            _show.update { it.copy(phase = ShowPhase.LOADING) }
        }
    }

    fun unloadShow() {
        val st = _show.value
        val show = st.show ?: return
        if (st.isLive) stopShow("Unloaded")
        val sequence = show.isSequence
        radioRun++
        showJob?.cancel()
        radioFired.clear()
        _show.value = ShowState()
        if (!sequence) {
            scope.launch { show.receivers.forEach { send(Cmd.reset(it)); delay(SEND_SPACING_MS) } }
        }
    }

    // ------------------------------------------------------------------
    // Hub WiFi settings
    // ------------------------------------------------------------------

    fun requestWifiConfig() { send(Cmd.WIFI_GET) }
    fun setWifi(ssid: String?, pass: String?) { send(Cmd.wifiSet(ssid, pass)) }
    fun resetWifi() { send(Cmd.WIFI_RESET) }

    /** Same 0–100 host slider; 0 is stored/sent as 1, matching the daemon. */
    fun setLedBrightness(value: Int) {
        val next = value.coerceIn(1, 100)
        if (next == _ledBrightness.value) {
            pushLedState(force = true)
            return
        }
        _ledBrightness.value = next
        prefs.edit().putInt(KEY_LED_BRIGHTNESS, next).apply()
        pushLedState(force = true)
    }

    // ------------------------------------------------------------------
    // Dongle status pixels
    // ------------------------------------------------------------------

    private fun afterStateChange(@Suppress("UNUSED_PARAMETER") now: Long) {
        pushLedState(force = false)
    }

    private fun pushLedState(force: Boolean) {
        if (client.state.value !is LinkState.Connected) return
        val st = _show.value
        val sw = _switches.value
        val led = LedState(
            showLoad = when (st.phase) {
                ShowPhase.LOADING -> LoadLed.LOADING
                ShowPhase.LOAD_ERROR -> LoadLed.LOAD_ERROR
                ShowPhase.IDLE -> LoadLed.OFF
                else -> LoadLed.LOADED
            },
            showRun = when {
                st.phase == ShowPhase.RUNNING -> RunLed.RUNNING
                st.phase == ShowPhase.COUNTDOWN -> RunLed.COUNTDOWN
                st.phase == ShowPhase.STARTING -> RunLed.PRECHECK
                st.phase == ShowPhase.PAUSED -> RunLed.PAUSED
                sw.manualEngaged -> RunLed.MANUAL_FIRE
                sw.armed && st.phase == ShowPhase.LOADED -> RunLed.ARMED
                else -> RunLed.OFF
            },
            error = if (st.phase == ShowPhase.LOAD_ERROR) 1 else 0,
            arm = if (sw.armed) 1 else 0,
            brightness = _ledBrightness.value,
        )
        if (!force && led == lastLed) return
        lastLed = led
        send(Cmd.config(led))
    }

    private fun appendLog(line: LogLine) {
        _log.update { (it + line).takeLast(300) }
    }

    companion object {
        private const val KEY_RECEIVERS = "receivers"
        private const val KEY_BILUSOCN = "bilusocn"
        private const val KEY_STEP_INPUT = "step_input"
        private const val KEY_LED_BRIGHTNESS = "led_brightness"
        private const val DEFAULT_LED_BRIGHTNESS = 50
        private const val STEP_INPUT_MIN = 5
        private const val STEP_INPUT_MAX = 8
        private const val STEP_BUTTON_LOCKOUT_MS = 400L
        private const val STEP_BIND_TIMEOUT_MS = 15_000L
    }
}
