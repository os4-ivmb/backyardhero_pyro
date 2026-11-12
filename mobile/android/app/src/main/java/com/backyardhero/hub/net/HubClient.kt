package com.backyardhero.hub.net

import android.net.Network
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

data class HubInfo(
    val ssid: String,
    val fw: Int,
    val apChannel: Int,
    val ip: String,
    val wsPath: String,
    val wsPort: Int,
    val clients: Int,
    val maxClients: Int,
) {
    companion object {
        fun parse(o: JsonObject): HubInfo = HubInfo(
            ssid = o.str("ssid") ?: "",
            fw = o.int("fw") ?: 0,
            apChannel = o.int("ap_channel") ?: 0,
            ip = o.str("ip") ?: HubDefaults.HOST,
            wsPath = o.str("ws_path") ?: HubDefaults.WS_PATH,
            wsPort = o.int("ws_port") ?: HubDefaults.PORT,
            clients = o.int("clients") ?: 0,
            maxClients = o.int("max_clients") ?: 0,
        )
    }
}

sealed interface LinkState {
    /** Short name for the status bar. The hub SSID, or "USB". */
    val label: String

    /** Nothing is connected: no hub answered, or no serial dongle is open. */
    data object NoHub : LinkState {
        override val label = "No hub"
    }

    data class Connecting(override val label: String, val info: HubInfo? = null) : LinkState
    data class Connected(override val label: String, val info: HubInfo? = null) : LinkState
    data class Reconnecting(
        override val label: String,
        val reason: String,
        val info: HubInfo? = null,
    ) : LinkState
}

/**
 * Finds the hub on any of the phone's WiFi networks and keeps one WebSocket
 * open to it. Every text message from the hub is one dongle protocol line.
 */
class HubClient(private val scope: CoroutineScope) : DongleLink {
    private val json = Json { ignoreUnknownKeys = true }

    private val _state = MutableStateFlow<LinkState>(LinkState.NoHub)
    override val state: StateFlow<LinkState> = _state.asStateFlow()

    private val _lines = MutableSharedFlow<String>(extraBufferCapacity = 512)
    override val lines: SharedFlow<String> = _lines.asSharedFlow()

    @Volatile private var candidates: List<Network> = emptyList()
    @Volatile private var enabled = false
    private val candidateUpdates = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    private var loopJob: Job? = null
    @Volatile private var socket: WebSocket? = null
    @Volatile private var socketNetwork: Network? = null
    @Volatile private var socketOpen = false
    @Volatile private var socketClosed = true

    /** When false the probe loop stays down so a USB session can own the dongle. */
    fun setEnabled(on: Boolean) {
        enabled = on
        if (!on) {
            loopJob?.cancel()
            loopJob = null
            closeSocket("stopped")
            _state.value = LinkState.NoHub
        } else if (loopJob?.isActive != true) {
            loopJob = scope.launch { runLoop() }
        }
    }

    /** Networks to try, in order (an in-app joined hub network first). */
    fun setCandidates(networks: List<Network>) {
        candidates = networks
        candidateUpdates.tryEmit(Unit)
        if (!enabled) return
        val current = socketNetwork
        if (current != null && current !in networks) {
            closeSocket("WiFi network went away")
        }
        if (loopJob?.isActive != true) loopJob = scope.launch { runLoop() }
    }

    fun stop() = setEnabled(false)

    /** Send one protocol line. Returns false if not connected. */
    override fun send(line: String): Boolean {
        val ws = socket ?: return false
        if (!socketOpen) return false
        return ws.send(line)
    }

    /** Force an immediate reconnect attempt. */
    fun reconnect() {
        closeSocket("reconnect requested")
    }

    private suspend fun runLoop() {
        var backoffMs = 1000L
        while (scope.isActive) {
            if (socket != null && !socketClosed) {
                delay(500)
                continue
            }
            val found = probeAll()
            if (found == null) {
                _state.value = LinkState.NoHub
                withTimeoutOrNull(2000) { candidateUpdates.first() }
                continue
            }
            val (network, info) = found
            _state.value = LinkState.Connecting(info.linkLabel(), info)
            openSocket(network, info)
            // Wait for open or failure.
            val deadline = System.currentTimeMillis() + 6000
            while (!socketOpen && !socketClosed && System.currentTimeMillis() < deadline) delay(100)
            if (socketOpen) {
                backoffMs = 1000L
            } else {
                closeSocket("connect timed out")
                _state.value = LinkState.Reconnecting(info.linkLabel(), "Couldn't open the hub connection", info)
                delay(backoffMs)
                backoffMs = (backoffMs * 2).coerceAtMost(8000L)
            }
        }
    }

    private suspend fun probeAll(): Pair<Network, HubInfo>? {
        for (network in candidates) {
            val info = probe(network) ?: continue
            return network to info
        }
        return null
    }

    private suspend fun probe(network: Network): HubInfo? = withContext(Dispatchers.IO) {
        val client = httpFor(network, connectTimeoutMs = 1500, readTimeoutMs = 2000)
        val req = Request.Builder().url("http://${HubDefaults.HOST}:${HubDefaults.PORT}/api/info").build()
        runCatching {
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val body = resp.body?.string() ?: return@use null
                val o = json.parseToJsonElement(body).jsonObject
                if (o.str("role") != "hub_dongle") return@use null
                HubInfo.parse(o)
            }
        }.getOrNull()
    }

    private fun openSocket(network: Network, info: HubInfo) {
        val client = httpFor(network, connectTimeoutMs = 3000, readTimeoutMs = 0)
            .newBuilder()
            .pingInterval(10, TimeUnit.SECONDS)
            .build()
        val host = info.ip.ifBlank { HubDefaults.HOST }
        val req = Request.Builder().url("ws://$host:${info.wsPort}${info.wsPath}").build()
        socketOpen = false
        socketClosed = false
        socketNetwork = network
        socket = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (webSocket != socket) return
                socketOpen = true
                _state.value = LinkState.Connected(info.linkLabel(), info)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket != socket) return
                for (line in text.split('\n')) {
                    val t = line.trimEnd('\r')
                    if (t.isNotEmpty()) _lines.tryEmit(t)
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                onDropped(webSocket, info, "Hub closed the connection ($code ${reason.ifBlank { "" }})".trim())
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                onDropped(webSocket, info, "Connection closed")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                onDropped(webSocket, info, t.message ?: "Connection failed")
            }
        })
    }

    private fun onDropped(ws: WebSocket, info: HubInfo, reason: String) {
        if (ws != socket) return
        socketOpen = false
        socketClosed = true
        socket = null
        socketNetwork = null
        if (!enabled) return
        _state.value = LinkState.Reconnecting(info.linkLabel(), reason, info)
    }

    private fun HubInfo.linkLabel() = ssid.ifBlank { "Hub" }

    private fun closeSocket(reason: String) {
        val ws = socket
        socket = null
        socketNetwork = null
        socketOpen = false
        socketClosed = true
        ws?.close(1000, reason.take(100))
    }

    private fun httpFor(network: Network, connectTimeoutMs: Long, readTimeoutMs: Long): OkHttpClient =
        OkHttpClient.Builder()
            .socketFactory(network.socketFactory)
            .connectTimeout(connectTimeoutMs, TimeUnit.MILLISECONDS)
            .readTimeout(readTimeoutMs, TimeUnit.MILLISECONDS)
            .retryOnConnectionFailure(false)
            .build()
}

internal fun JsonObject.str(key: String): String? =
    (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString || it.content != "null" }?.content

internal fun JsonObject.int(key: String): Int? =
    (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toDoubleOrNull()?.toInt()

internal fun JsonObject.long(key: String): Long? =
    (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.content?.let { it.toLongOrNull() ?: it.toDoubleOrNull()?.toLong() }

internal fun JsonObject.bool(key: String): Boolean? {
    val p = this[key] as? kotlinx.serialization.json.JsonPrimitive ?: return null
    return when (p.content) {
        "true", "1" -> true
        "false", "0" -> false
        else -> null
    }
}
