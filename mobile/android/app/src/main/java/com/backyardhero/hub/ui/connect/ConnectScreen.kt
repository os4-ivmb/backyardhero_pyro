package com.backyardhero.hub.ui.connect

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Router
import androidx.compose.material.icons.filled.Usb
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.backyardhero.hub.AppViewModel
import com.backyardhero.hub.net.HubDefaults
import com.backyardhero.hub.net.JoinState
import com.backyardhero.hub.net.LinkMode
import com.backyardhero.hub.net.LinkState
import com.backyardhero.hub.net.UsbStatus
import com.backyardhero.hub.net.WifiNetworkInfo
import com.backyardhero.hub.ui.theme.ByhColors

fun wifiScanPermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= 33) arrayOf(Manifest.permission.NEARBY_WIFI_DEVICES)
    else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)

private fun hasScanPermission(ctx: Context) = wifiScanPermissions().all {
    ContextCompat.checkSelfPermission(ctx, it) == PackageManager.PERMISSION_GRANTED
}

private fun locationOn(ctx: Context): Boolean {
    if (Build.VERSION.SDK_INT >= 33) return true
    val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    return lm.isLocationEnabled
}

@Composable
fun ConnectScreen(vm: AppViewModel) {
    val ctx = LocalContext.current
    val link by vm.client.state.collectAsStateWithLifecycle()
    val mode by vm.client.mode.collectAsStateWithLifecycle()
    val networks by vm.wifi.scanResults.collectAsStateWithLifecycle()
    val scanning by vm.wifi.scanning.collectAsStateWithLifecycle()
    val joinState by vm.wifi.joinState.collectAsStateWithLifecycle()

    var permissionGranted by remember { mutableStateOf(hasScanPermission(ctx)) }
    var joinTarget by remember { mutableStateOf<WifiNetworkInfo?>(null) }
    var showAll by remember { mutableStateOf(false) }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        permissionGranted = result.values.all { it }
        if (permissionGranted) vm.wifi.scan()
    }

    LaunchedEffect(permissionGranted, mode) {
        if (mode != LinkMode.WIRELESS) return@LaunchedEffect
        if (permissionGranted) vm.wifi.scan()
        else permissionLauncher.launch(wifiScanPermissions())
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(ByhColors.Background)
            .statusBarsPadding()
            .padding(16.dp)
    ) {
        Text("Backyard Hero Hub", fontSize = 24.sp, fontWeight = FontWeight.Bold, color = ByhColors.Text)
        Spacer(Modifier.height(4.dp))
        Text(
            if (mode == LinkMode.USB)
                "Plug the dongle into this phone's USB-C port. The app uses that serial connection."
            else
                "Join a hub dongle's WiFi network. The app connects automatically once it finds the hub.",
            color = ByhColors.TextDim, fontSize = 14.sp,
        )
        Spacer(Modifier.height(16.dp))
        LinkModeSelect(mode, vm::setLinkMode)
        Spacer(Modifier.height(16.dp))

        if (mode == LinkMode.USB) {
            UsbConnectBody(vm)
            return@Column
        }

        HubSearchCard(link, joinState, onRetryJoin = { vm.wifi.clearJoinError() })
        Spacer(Modifier.height(16.dp))

        when {
            !vm.wifi.wifiEnabled -> NoticeCard(
                "WiFi is off",
                "Turn on WiFi to find the hub.",
                "Turn on WiFi",
            ) { ctx.startActivity(Intent(Settings.Panel.ACTION_WIFI)) }

            !permissionGranted -> NoticeCard(
                "Allow WiFi scanning",
                "The app needs permission to list nearby WiFi networks and find hubs. " +
                    "You can also join the hub from WiFi settings instead.",
                "Allow",
            ) { permissionLauncher.launch(wifiScanPermissions()) }

            !locationOn(ctx) -> NoticeCard(
                "Location is off",
                "Android only returns WiFi scan results with location turned on.",
                "Location settings",
            ) { ctx.startActivity(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)) }
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (showAll) "Nearby networks" else "Nearby hubs",
                color = ByhColors.Text, fontWeight = FontWeight.SemiBold, fontSize = 16.sp,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { showAll = !showAll }) { Text(if (showAll) "Hubs only" else "Show all") }
            if (scanning) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            } else {
                IconButton(onClick = { vm.wifi.scan() }, enabled = permissionGranted) {
                    Icon(Icons.Filled.Refresh, contentDescription = "Scan", tint = ByhColors.TextDim)
                }
            }
        }

        val visible = if (showAll) networks else networks.filter { it.looksLikeHub }
        if (visible.isEmpty()) {
            Text(
                if (showAll) "No networks found yet." else
                    "No hubs found yet. Hubs broadcast as ${HubDefaults.SSID_PREFIX}XXXX unless renamed. " +
                        "Make sure the hub switch was on when it powered up, then rescan.",
                color = ByhColors.TextDim, fontSize = 14.sp, modifier = Modifier.padding(vertical = 12.dp),
            )
        }
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(visible, key = { it.ssid }) { net ->
                NetworkRow(net) { joinTarget = net }
            }
        }

        OutlinedButton(
            onClick = { ctx.startActivity(Intent(Settings.ACTION_WIFI_SETTINGS)) },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Open WiFi settings") }
    }

    joinTarget?.let { net ->
        JoinDialog(
            net = net,
            onDismiss = { joinTarget = null },
            onJoin = { pass ->
                vm.wifi.join(net.ssid, pass.ifEmpty { null })
                joinTarget = null
            },
            onOpenSettings = {
                joinTarget = null
                ctx.startActivity(Intent(Settings.Panel.ACTION_WIFI))
            },
        )
    }
}

@Composable
private fun UsbConnectBody(vm: AppViewModel) {
    val status by vm.client.usbStatus.collectAsStateWithLifecycle()
    val (title, detail, busy) = when (val s = status) {
        UsbStatus.Idle, UsbStatus.NoDevice -> Triple(
            "Waiting for a dongle",
            "Use a data cable and turn the board's power switch on. A hub dongle can stay in hub mode; the cable is the connection.",
            false,
        )
        is UsbStatus.NeedsPermission -> Triple(
            "Allow USB access",
            "Android asks once before the app can open the dongle's serial port.",
            false,
        )
        is UsbStatus.Opening -> Triple("Opening USB serial", s.name, true)
        is UsbStatus.Open -> Triple("USB connected", s.name, true)
        is UsbStatus.Error -> Triple(
            if (s.retrying) "Reconnecting" else "Couldn't open USB",
            s.message,
            s.retrying,
        )
        UsbStatus.Held -> Triple(
            "Disconnected",
            "The dongle can stay plugged in. Connect when you want the serial port again.",
            false,
        )
        UsbStatus.Unsupported -> Triple(
            "USB host isn't available",
            "This phone can't run a dongle from its USB-C port. Use Wireless instead.",
            false,
        )
    }
    Row(
        Modifier
            .fillMaxWidth()
            .background(ByhColors.Surface, RoundedCornerShape(12.dp))
            .border(1.dp, ByhColors.Outline, RoundedCornerShape(12.dp))
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (busy) CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
        else Icon(Icons.Filled.Usb, null, tint = ByhColors.Accent, modifier = Modifier.size(28.dp))
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = ByhColors.Text, fontWeight = FontWeight.SemiBold)
            Text(detail, color = ByhColors.TextDim, fontSize = 13.sp)
        }
    }
    Spacer(Modifier.height(12.dp))
    when (val s = status) {
        is UsbStatus.NeedsPermission -> Button(
            onClick = { vm.client.requestUsbPermission() },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Allow USB access") }
        is UsbStatus.Error -> if (!s.retrying) Button(
            onClick = { vm.client.resumeUsb() },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Try again") }
        UsbStatus.Held -> Button(
            onClick = { vm.client.resumeUsb() },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Connect") }
        UsbStatus.NoDevice, UsbStatus.Idle -> OutlinedButton(
            onClick = { vm.client.resumeUsb() },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Check again") }
        else -> Unit
    }
}

@Composable
private fun HubSearchCard(link: LinkState, join: JoinState, onRetryJoin: () -> Unit) {
    val (title, detail, busy) = when {
        link is LinkState.Connecting -> Triple("Hub found", "Connecting to ${link.label}…", true)
        link is LinkState.Reconnecting -> Triple("Hub found", "Retrying: ${link.reason}", true)
        join is JoinState.Joining -> Triple("Joining ${join.ssid}", "Confirm in the system dialog if asked.", true)
        join is JoinState.Joined -> Triple("Joined ${join.ssid}", "Looking for the hub server…", true)
        join is JoinState.Failed -> Triple("Couldn't join", join.reason, false)
        else -> Triple("Looking for a hub", "Checking the WiFi networks this phone is on…", true)
    }
    Row(
        Modifier
            .fillMaxWidth()
            .background(ByhColors.Surface, RoundedCornerShape(12.dp))
            .border(1.dp, ByhColors.Outline, RoundedCornerShape(12.dp))
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (busy) CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
        else Icon(Icons.Filled.Router, null, tint = ByhColors.Danger, modifier = Modifier.size(28.dp))
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = ByhColors.Text, fontWeight = FontWeight.SemiBold)
            Text(detail, color = ByhColors.TextDim, fontSize = 13.sp)
        }
        if (join is JoinState.Failed) TextButton(onClick = onRetryJoin) { Text("OK") }
    }
}

@Composable
private fun NoticeCard(title: String, body: String, action: String, onAction: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 16.dp)
            .background(ByhColors.SurfaceHigh, RoundedCornerShape(12.dp))
            .padding(16.dp)
    ) {
        Text(title, color = ByhColors.Warn, fontWeight = FontWeight.SemiBold)
        Text(body, color = ByhColors.TextDim, fontSize = 13.sp)
        Spacer(Modifier.height(8.dp))
        Button(onClick = onAction) { Text(action) }
    }
}

@Composable
private fun NetworkRow(net: WifiNetworkInfo, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(if (net.looksLikeHub) ByhColors.SurfaceHigh else ByhColors.Surface, RoundedCornerShape(10.dp))
            .border(1.dp, if (net.looksLikeHub) ByhColors.Accent else ByhColors.Outline, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.Wifi, null, tint = signalColor(net.signalBars))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(net.ssid, color = ByhColors.Text, fontWeight = FontWeight.Medium)
            Text(
                buildString {
                    if (net.looksLikeHub) append("Backyard Hero hub · ")
                    append("${net.levelDbm} dBm · ")
                    append(if (net.frequencyMhz > 4000) "5 GHz" else "2.4 GHz")
                },
                color = ByhColors.TextDim, fontSize = 12.sp,
            )
        }
        if (net.secured) Icon(Icons.Filled.Lock, null, tint = ByhColors.TextDim, modifier = Modifier.size(16.dp))
    }
}

private fun signalColor(bars: Int) = when {
    bars >= 3 -> ByhColors.Ok
    bars == 2 -> ByhColors.Warn
    else -> ByhColors.Danger
}

@Composable
private fun JoinDialog(
    net: WifiNetworkInfo,
    onDismiss: () -> Unit,
    onJoin: (String) -> Unit,
    onOpenSettings: () -> Unit,
) {
    var password by remember { mutableStateOf(if (net.looksLikeHub) HubDefaults.DEFAULT_PASSWORD else "") }
    var reveal by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Join ${net.ssid}") },
        text = {
            Column {
                Text(
                    "The app can join this network directly (Android will ask you to confirm), " +
                        "or you can join it from WiFi settings and come back.",
                    fontSize = 13.sp, color = ByhColors.TextDim,
                )
                if (net.secured) {
                    Spacer(Modifier.height(12.dp))
                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it },
                        label = { Text("Password") },
                        singleLine = true,
                        visualTransformation = if (reveal) VisualTransformation.None else PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        trailingIcon = {
                            TextButton(onClick = { reveal = !reveal }) { Text(if (reveal) "Hide" else "Show") }
                        },
                    )
                    if (net.looksLikeHub) {
                        Text(
                            "Prefilled with the hub's default password.",
                            fontSize = 12.sp, color = ByhColors.TextDim,
                        )
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = { onJoin(password) }, enabled = !net.secured || password.length >= 8) { Text("Join") }
        },
        dismissButton = {
            Box {
                TextButton(onClick = onOpenSettings) { Text("WiFi settings") }
            }
        },
    )
}
