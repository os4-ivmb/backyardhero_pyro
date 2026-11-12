package com.backyardhero.hub.net

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbManager
import android.os.Build
import com.hoho.android.usbserial.driver.CdcAcmSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import androidx.core.content.ContextCompat

/**
 * What the USB connect screen should show. [LinkState] stays the shared
 * connected / reconnecting signal the rest of the app already uses.
 */
sealed interface UsbStatus {
    data object Idle : UsbStatus
    data object Unsupported : UsbStatus
    data object NoDevice : UsbStatus
    data class NeedsPermission(val name: String) : UsbStatus
    data class Opening(val name: String) : UsbStatus
    data class Open(val name: String) : UsbStatus
    data class Error(val message: String, val retrying: Boolean) : UsbStatus
    data object Held : UsbStatus
}

/**
 * Phone-as-USB-host serial link to an Espressif dongle (Omni or os4).
 *
 * Both boards enumerate as USB CDC. A USB-mode dongle waits until the host
 * raises DTR (`Serial` becomes true). A hub-mode dongle keeps its Wi-Fi AP
 * and also accepts this same line protocol on the cable. The port drops for
 * a couple of seconds when the board reboots, so a loss is retried before
 * the connect screen takes over.
 */
class UsbLink(
    context: Context,
    private val scope: CoroutineScope,
) : DongleLink {
    private val appContext = context.applicationContext
    private val usbManager = appContext.getSystemService(Context.USB_SERVICE) as UsbManager
    private val hostSupported = appContext.packageManager.hasSystemFeature(PackageManager.FEATURE_USB_HOST)

    private val _state = MutableStateFlow<LinkState>(LinkState.NoHub)
    override val state: StateFlow<LinkState> = _state.asStateFlow()

    private val _lines = MutableSharedFlow<String>(extraBufferCapacity = 512)
    override val lines: SharedFlow<String> = _lines.asSharedFlow()

    private val _status = MutableStateFlow<UsbStatus>(UsbStatus.Idle)
    val status: StateFlow<UsbStatus> = _status.asStateFlow()

    private val gate = Mutex()
    private val ioLock = Any()
    private val rescanRequested = AtomicBoolean(false)
    private val retryScheduled = AtomicBoolean(false)
    private val readerGeneration = AtomicInteger(0)
    /** Bumped so a delayed close from Disconnect can't shut a newer open. */
    private val epoch = AtomicInteger(0)
    private val permissionAsked = AtomicBoolean(false)

    @Volatile private var enabled = false
    @Volatile private var held = false
    @Volatile private var denied = false
    @Volatile private var hadOpen = false
    @Volatile private var failures = 0
    @Volatile private var lostSince = 0L
    @Volatile private var openDeviceId = -1
    @Volatile private var port: UsbSerialPort? = null
    @Volatile private var connection: UsbDeviceConnection? = null
    @Volatile private var pendingDevice: UsbDevice? = null
    @Volatile private var receiverRegistered = false

    private val pending = ArrayList<Byte>(256)

    private val usbReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (!enabled || held) return
            when (intent.action) {
                ACTION_USB_PERMISSION -> {
                    val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    denied = !granted
                    scanAndOpen()
                }
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    denied = false
                    permissionAsked.set(false)
                    scanAndOpen()
                }
                UsbManager.ACTION_USB_DEVICE_ATTACHED -> scanAndOpen()
            }
        }
    }

    fun setEnabled(on: Boolean) {
        if (on) {
            if (enabled) return
            enabled = true
            held = false
            denied = false
            failures = 0
            lostSince = 0L
            hadOpen = false
            if (!hostSupported) {
                _status.value = UsbStatus.Unsupported
                _state.value = LinkState.NoHub
                return
            }
            registerReceiver()
            scanAndOpen()
        } else {
            epoch.incrementAndGet()
            enabled = false
            held = false
            unregisterReceiver()
            closePort()
            _state.value = LinkState.NoHub
            _status.value = UsbStatus.Idle
        }
    }

    /** User asked to drop the link while the cable can stay plugged in. */
    fun hold() {
        val ticket = epoch.incrementAndGet()
        held = true
        hadOpen = false
        failures = 0
        lostSince = 0L
        _state.value = LinkState.NoHub
        _status.value = UsbStatus.Held
        scope.launch(Dispatchers.IO) {
            gate.withLock {
                if (epoch.get() != ticket) return@withLock
                closePort()
            }
        }
    }

    /** Open again after [hold] or a failed attempt. */
    fun resume() {
        if (!enabled) return
        epoch.incrementAndGet()
        held = false
        denied = false
        permissionAsked.set(false)
        failures = 0
        lostSince = 0L
        scanAndOpen()
    }

    fun requestPermission() {
        if (!enabled || !hostSupported) return
        denied = false
        val device = pendingDevice ?: findDongle()
        if (device == null) {
            scanAndOpen()
            return
        }
        pendingDevice = device
        permissionAsked.set(true)
        askPermission(device)
    }

    override fun send(line: String): Boolean {
        val generation = readerGeneration.get()
        val p = port ?: return false
        return try {
            val bytes = (line + "\n").toByteArray(Charsets.UTF_8)
            synchronized(ioLock) {
                val current = port ?: return false
                current.write(bytes, WRITE_TIMEOUT_MS)
            }
            true
        } catch (e: Exception) {
            onIoFailure(e.message ?: "USB write failed", generation)
            false
        }
    }

    private fun scanAndOpen() {
        scope.launch(Dispatchers.IO) {
            if (!gate.tryLock()) {
                rescanRequested.set(true)
                return@launch
            }
            try {
                if (enabled && !held) openIfPossible()
            } finally {
                val again = rescanRequested.getAndSet(false)
                gate.unlock()
                if (again && enabled && !held) scanAndOpen()
            }
        }
    }

    private fun openIfPossible() {
        if (!enabled || held) return
        var watching = false
        var keepLooking = true
        try {
            val device = findDongle()
            if (device == null) {
                noteAbsent()
                return
            }
            lostSince = 0L
            if (pendingDevice?.deviceId != device.deviceId) {
                denied = false
                permissionAsked.set(false)
            }
            pendingDevice = device
            if (!usbManager.hasPermission(device)) {
                closePort()
                _state.value = LinkState.NoHub
                _status.value = UsbStatus.NeedsPermission(labelOf(device))
                if (!denied && permissionAsked.compareAndSet(false, true)) askPermission(device)
                return
            }
            denied = false
            if (port != null && openDeviceId == device.deviceId) {
                watching = true
                return
            }
            if (!enabled || held) return

            val name = labelOf(device)
            _state.value = LinkState.Connecting(name)
            _status.value = UsbStatus.Opening(name)
            closePort()
            val opened = openSerial(device)
            val keep = synchronized(ioLock) {
                if (!enabled || held) {
                    false
                } else {
                    connection = opened.connection
                    port = opened.port
                    openDeviceId = device.deviceId
                    true
                }
            }
            if (!keep) {
                runCatching { opened.port.close() }
                runCatching { opened.connection.close() }
                if (held) {
                    _state.value = LinkState.NoHub
                    _status.value = UsbStatus.Held
                }
                return
            }
            clearPending()
            hadOpen = true
            failures = 0
            _status.value = UsbStatus.Open(name)
            _state.value = LinkState.Connected(name)
            startReader(opened.port)
            watching = true
        } catch (e: Exception) {
            closePort()
            keepLooking = enabled && !held && failOpen(e.message ?: "Couldn't open USB serial")
        } finally {
            // Plug-in is easy to miss if the attach broadcast doesn't arrive.
            // An open port is watched by the read loop instead.
            if (keepLooking && !watching && enabled && !held) scheduleRetry(1_000)
        }
    }

    private fun noteAbsent() {
        val wasLive = hadOpen || port != null || _state.value is LinkState.Reconnecting
        closePort()
        pendingDevice = null
        if (!wasLive) {
            lostSince = 0L
            failures = 0
            _state.value = LinkState.NoHub
            _status.value = UsbStatus.NoDevice
            return
        }
        if (lostSince == 0L) lostSince = System.currentTimeMillis()
        if (System.currentTimeMillis() - lostSince < REENUM_WAIT_MS) {
            _state.value = LinkState.Reconnecting("USB", "USB disconnected")
            _status.value = UsbStatus.Error("Waiting for the dongle to come back", retrying = true)
            scheduleRetry(500)
        } else {
            hadOpen = false
            lostSince = 0L
            failures = 0
            _state.value = LinkState.NoHub
            _status.value = UsbStatus.NoDevice
        }
    }

    /** @return true while automatic retries should continue. */
    private fun failOpen(reason: String): Boolean {
        failures++
        val retrying = failures < MAX_FAILURES
        if (hadOpen && retrying) {
            _state.value = LinkState.Reconnecting("USB", reason)
        } else {
            if (!retrying) hadOpen = false
            _state.value = LinkState.NoHub
        }
        _status.value = UsbStatus.Error(reason, retrying)
        if (retrying) scheduleRetry((400L * failures).coerceAtMost(3_000L))
        return retrying
    }

    private fun onIoFailure(reason: String, generation: Int) {
        scope.launch(Dispatchers.IO) {
            val shouldRetry = gate.withLock {
                // A newer open owns the port. Closing it here would drop that link.
                if (!enabled || held || generation != readerGeneration.get()) return@withLock false
                if (port == null && connection == null) return@withLock false
                closePort()
                failures++
                val retrying = failures < MAX_FAILURES
                if (hadOpen && retrying) {
                    _state.value = LinkState.Reconnecting("USB", reason)
                } else {
                    if (!retrying) hadOpen = false
                    _state.value = LinkState.NoHub
                }
                _status.value = UsbStatus.Error(reason, retrying)
                retrying
            }
            if (shouldRetry) scheduleRetry((400L * failures).coerceAtMost(3_000L))
        }
    }

    private fun scheduleRetry(delayMs: Long) {
        if (!retryScheduled.compareAndSet(false, true)) return
        scope.launch {
            delay(delayMs)
            retryScheduled.set(false)
            if (enabled && !held) scanAndOpen()
        }
    }

    private fun findDongle(): UsbDevice? =
        usbManager.deviceList.values.firstOrNull { it.vendorId == ESPRESSIF_VID }

    private fun openSerial(device: UsbDevice): Opened {
        val connection = usbManager.openDevice(device)
            ?: throw IOException("The phone didn't open the USB device")
        try {
            val driver = UsbSerialProber.getDefaultProber().probeDevice(device)
                ?: CdcAcmSerialDriver(device)
            val serial = driver.ports.firstOrNull()
                ?: throw IOException("No serial port on this device")
            serial.open(connection)
            try {
                // Native USB CDC doesn't use the baud rate. DTR is what a
                // USB-mode dongle waits on before it leaves the boot loop.
                runCatching {
                    serial.setParameters(115200, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
                }
                serial.setDTR(true)
                runCatching { serial.setRTS(true) }
            } catch (e: Exception) {
                runCatching { serial.close() }
                throw e
            }
            return Opened(connection, serial)
        } catch (e: Exception) {
            runCatching { connection.close() }
            throw e
        }
    }

    private fun startReader(serial: UsbSerialPort) {
        val generation = readerGeneration.get()
        Thread({
            val buf = ByteArray(2048)
            try {
                while (generation == readerGeneration.get()) {
                    val n = serial.read(buf, READ_TIMEOUT_MS)
                    if (generation != readerGeneration.get()) break
                    if (n > 0) emitBytes(buf, n)
                }
            } catch (e: Exception) {
                if (generation == readerGeneration.get()) {
                    onIoFailure(e.message ?: "USB read failed", generation)
                }
            }
        }, "usb-dongle").apply {
            isDaemon = true
            start()
        }
    }

    private fun emitBytes(buf: ByteArray, n: Int) {
        synchronized(pending) {
            for (i in 0 until n) {
                val b = buf[i]
                if (b == '\n'.code.toByte()) {
                    if (pending.isNotEmpty() && pending.last() == '\r'.code.toByte()) {
                        pending.removeAt(pending.lastIndex)
                    }
                    if (pending.isNotEmpty()) {
                        val line = pending.toByteArray().toString(Charsets.UTF_8)
                        pending.clear()
                        if (line.isNotEmpty()) _lines.tryEmit(line)
                    }
                } else {
                    pending.add(b)
                    if (pending.size > 65_536) pending.clear()
                }
            }
        }
    }

    private fun clearPending() {
        synchronized(pending) { pending.clear() }
    }

    private fun closePort() {
        readerGeneration.incrementAndGet()
        val p: UsbSerialPort?
        val c: UsbDeviceConnection?
        synchronized(ioLock) {
            p = port
            c = connection
            port = null
            connection = null
            openDeviceId = -1
        }
        clearPending()
        try {
            p?.close()
        } catch (_: Exception) {
        }
        try {
            c?.close()
        } catch (_: Exception) {
        }
    }

    private fun askPermission(device: UsbDevice) {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        val intent = Intent(ACTION_USB_PERMISSION).setPackage(appContext.packageName)
        val pendingIntent = PendingIntent.getBroadcast(appContext, 0, intent, flags)
        usbManager.requestPermission(device, pendingIntent)
    }

    private fun registerReceiver() {
        if (receiverRegistered) return
        val filter = IntentFilter(ACTION_USB_PERMISSION).apply {
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        try {
            ContextCompat.registerReceiver(
                appContext,
                usbReceiver,
                filter,
                ContextCompat.RECEIVER_EXPORTED,
            )
            receiverRegistered = true
        } catch (e: Exception) {
            _state.value = LinkState.NoHub
            _status.value = UsbStatus.Error(e.message ?: "Couldn't listen for USB devices", retrying = false)
        }
    }

    private fun unregisterReceiver() {
        if (!receiverRegistered) return
        receiverRegistered = false
        runCatching { appContext.unregisterReceiver(usbReceiver) }
    }

    private fun labelOf(device: UsbDevice): String {
        val name = runCatching { device.productName }.getOrNull()?.takeIf { it.isNotBlank() }
        return name ?: "USB"
    }

    private data class Opened(val connection: UsbDeviceConnection, val port: UsbSerialPort)

    companion object {
        private const val ACTION_USB_PERMISSION = "com.backyardhero.hub.USB_PERMISSION"
        private const val ESPRESSIF_VID = 0x303A
        private const val REENUM_WAIT_MS = 8_000L
        private const val MAX_FAILURES = 6
        private const val READ_TIMEOUT_MS = 250
        private const val WRITE_TIMEOUT_MS = 1_000
    }
}
