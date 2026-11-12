package com.backyardhero.hub.net

import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/** Which physical path carries dongle protocol lines. */
enum class LinkMode {
    WIRELESS,
    USB;

    companion object {
        fun fromStored(value: String?): LinkMode = if (value == "usb") USB else WIRELESS
        fun stored(mode: LinkMode): String = if (mode == USB) "usb" else "wireless"
    }
}

/**
 * One dongle transport. [lines] are protocol lines with the trailing newline
 * already removed. [send] writes one line and returns false when the link is down.
 */
interface DongleLink {
    val state: StateFlow<LinkState>
    val lines: SharedFlow<String>
    fun send(line: String): Boolean
}
