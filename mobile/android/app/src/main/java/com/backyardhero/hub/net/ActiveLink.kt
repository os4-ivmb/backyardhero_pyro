package com.backyardhero.hub.net

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * The transport [com.backyardhero.hub.session.HubSession] talks to.
 * Wireless and USB stay constructed, and only the selected one is running.
 */
class ActiveLink(
    private val scope: CoroutineScope,
    private val wifi: HubClient,
    private val usb: UsbLink,
) : DongleLink {
    private val _mode = MutableStateFlow(LinkMode.WIRELESS)
    val mode: StateFlow<LinkMode> = _mode.asStateFlow()

    val usbStatus: StateFlow<UsbStatus> = usb.status

    private val _state = MutableStateFlow<LinkState>(LinkState.NoHub)
    override val state: StateFlow<LinkState> = _state.asStateFlow()

    private val _lines = MutableSharedFlow<String>(extraBufferCapacity = 512)
    override val lines: SharedFlow<String> = _lines.asSharedFlow()

    private var applied: LinkMode? = null
    private var forwardJob: Job? = null

    fun setMode(mode: LinkMode) {
        if (applied == mode) return
        applied = mode
        _mode.value = mode
        forwardJob?.cancel()
        when (mode) {
            LinkMode.WIRELESS -> {
                usb.setEnabled(false)
                wifi.setEnabled(true)
            }
            LinkMode.USB -> {
                wifi.setEnabled(false)
                usb.setEnabled(true)
            }
        }
        // Drop the previous transport's Connected before the new one reports,
        // so the session treats the switch as a fresh link.
        _state.value = LinkState.NoHub
        val src = current()
        forwardJob = scope.launch {
            launch { src.state.collect { _state.value = it } }
            launch { src.lines.collect { _lines.tryEmit(it) } }
        }
    }

    override fun send(line: String): Boolean = current().send(line)

    fun reconnectWifi() = wifi.reconnect()

    fun holdUsb() = usb.hold()

    fun resumeUsb() = usb.resume()

    fun requestUsbPermission() = usb.requestPermission()

    fun close() {
        forwardJob?.cancel()
        forwardJob = null
        applied = null
        wifi.setEnabled(false)
        usb.setEnabled(false)
    }

    private fun current(): DongleLink = when (_mode.value) {
        LinkMode.WIRELESS -> wifi
        LinkMode.USB -> usb
    }
}
