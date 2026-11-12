package com.backyardhero.hub.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.backyardhero.hub.AppViewModel
import com.backyardhero.hub.net.LinkMode
import com.backyardhero.hub.net.LinkState
import com.backyardhero.hub.ui.connect.LinkModeSelect
import com.backyardhero.hub.ui.theme.ByhColors
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HubSettingsSheet(vm: AppViewModel, onDismiss: () -> Unit) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val link by vm.client.state.collectAsStateWithLifecycle()
    val mode by vm.client.mode.collectAsStateWithLifecycle()
    val wifi by vm.session.wifi.collectAsStateWithLifecycle()
    val dongle by vm.session.dongle.collectAsStateWithLifecycle()
    val log by vm.session.log.collectAsStateWithLifecycle()

    var ssid by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }
    var confirmReset by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { vm.session.requestWifiConfig() }
    LaunchedEffect(wifi?.ssid) { if (ssid.isEmpty()) ssid = wifi?.ssid.orEmpty() }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, containerColor = ByhColors.Surface) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .navigationBarsPadding()
        ) {
            Text("Connection", color = ByhColors.Text, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(8.dp))
            LinkModeSelect(mode, vm::setLinkMode)
            Text(
                if (mode == LinkMode.USB)
                    "The dongle is plugged into this phone. A hub dongle can stay in hub mode."
                else
                    "The phone joins the hub's Wi-Fi.",
                color = ByhColors.TextDim, fontSize = 13.sp,
                modifier = Modifier.padding(top = 8.dp),
            )
            Spacer(Modifier.height(8.dp))
            val info = when (val l = link) {
                is LinkState.Connected -> l.info
                is LinkState.Connecting -> l.info
                is LinkState.Reconnecting -> l.info
                LinkState.NoHub -> null
            }
            if (mode == LinkMode.USB) {
                InfoLine("Link", "USB serial")
            } else {
                InfoLine("Network", info?.ssid ?: "—")
                InfoLine("WiFi channel", info?.apChannel?.toString() ?: "—")
                InfoLine("Hub firmware", info?.fw?.let { "v$it" } ?: "—")
            }
            InfoLine("nRF channel", dongle.rfChannel?.toString() ?: "—")
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = { vm.forgetHub(); onDismiss() }) {
                Text(if (mode == LinkMode.USB) "Disconnect" else "Disconnect / find another hub")
            }

            Spacer(Modifier.height(16.dp))
            HorizontalDivider(color = ByhColors.Outline)
            Spacer(Modifier.height(16.dp))

            Text("Hub WiFi network", color = ByhColors.Text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Text(
                "Changes apply the next time the hub powers up. The password is never sent back to the app.",
                color = ByhColors.TextDim, fontSize = 13.sp,
            )
            Spacer(Modifier.height(8.dp))
            val w = wifi
            if (w == null) {
                Text("Loading…", color = ByhColors.TextDim)
            } else {
                InfoLine("Stored name", w.ssid + if (w.ssidDefault) " (default)" else "")
                InfoLine("Password", if (w.passDefault) "default — change it" else "custom")
                if (w.rebootRequired) Text("Saved. Power-cycle the hub to apply.", color = ByhColors.Warn, fontSize = 13.sp)
                if (!w.ok && w.err != null) Text(w.err, color = ByhColors.Danger, fontSize = 13.sp)
            }
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = ssid,
                onValueChange = { ssid = it.take(32) },
                label = { Text("Network name") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = pass,
                onValueChange = { pass = it.take(63) },
                label = { Text("New password (leave blank to keep)") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                supportingText = { Text("8-63 characters") },
                modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val ssidChanged = ssid.isNotBlank() && ssid != wifi?.ssid
                val passValid = pass.isEmpty() || pass.length in 8..63
                Button(
                    onClick = {
                        vm.session.setWifi(if (ssidChanged) ssid else null, pass.ifEmpty { null })
                        pass = ""
                    },
                    enabled = link is LinkState.Connected && passValid && (ssidChanged || pass.isNotEmpty()),
                ) { Text("Save") }
                TextButton(onClick = { confirmReset = true }, enabled = link is LinkState.Connected) {
                    Text("Reset to defaults")
                }
            }

            Spacer(Modifier.height(16.dp))
            HorizontalDivider(color = ByhColors.Outline)
            Spacer(Modifier.height(16.dp))

            Text("Console", color = ByhColors.Text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(6.dp))
            val listState = rememberLazyListState()
            LaunchedEffect(log.size) { if (log.isNotEmpty()) listState.scrollToItem(log.size - 1) }
            val fmt = remember { SimpleDateFormat("HH:mm:ss", Locale.US) }
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 260.dp)
                    .background(ByhColors.Background, RoundedCornerShape(8.dp))
                    .padding(8.dp),
            ) {
                items(log) { l ->
                    Text(
                        "${fmt.format(Date(l.atMs))} ${if (l.outbound) ">" else "<"} ${l.text}",
                        color = if (l.outbound) ByhColors.Info else ByhColors.TextDim,
                        fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }

    if (confirmReset) {
        AlertDialog(
            onDismissRequest = { confirmReset = false },
            title = { Text("Reset hub WiFi?") },
            text = { Text("The hub goes back to its default network name and password on its next power-up.") },
            confirmButton = { TextButton(onClick = { vm.session.resetWifi(); confirmReset = false }) { Text("Reset") } },
            dismissButton = { TextButton(onClick = { confirmReset = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun InfoLine(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Text(label, color = ByhColors.TextDim, fontSize = 13.sp, modifier = Modifier.weight(1f))
        Text(value, color = ByhColors.Text, fontSize = 13.sp)
    }
}
