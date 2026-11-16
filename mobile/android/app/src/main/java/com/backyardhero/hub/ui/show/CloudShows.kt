package com.backyardhero.hub.ui.show

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.backyardhero.hub.cloud.CloudAccount
import com.backyardhero.hub.cloud.CloudShowInfo
import com.backyardhero.hub.show.Show
import com.backyardhero.hub.ui.clock
import com.backyardhero.hub.ui.theme.ByhColors
import kotlinx.coroutines.launch

/** The cloud builder account's shows, listed under the shows already on the phone. */
fun LazyListScope.cloudShowsSection(
    configured: Boolean,
    account: CloudAccount?,
    cloudShows: List<CloudShowInfo>?,
    localShows: List<Show>,
    loading: Boolean,
    downloading: String?,
    error: String?,
    onSignIn: () -> Unit,
    onSignOut: () -> Unit,
    onRefresh: () -> Unit,
    onDownload: (CloudShowInfo) -> Unit,
) {
    if (!configured) return
    item(key = "cloud-header") {
        Column(Modifier.padding(top = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        "Cloud builder shows", color = ByhColors.Text, fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                    if (account != null) {
                        Text(account.email, color = ByhColors.TextDim, fontSize = 12.sp, maxLines = 1)
                    }
                }
                if (account == null) {
                    Button(onClick = onSignIn) { Text("Sign in") }
                } else {
                    if (loading) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    } else {
                        IconButton(onClick = onRefresh) {
                            Icon(Icons.Filled.Refresh, contentDescription = "Refresh", tint = ByhColors.TextDim)
                        }
                    }
                    TextButton(onClick = onSignOut) { Text("Sign out") }
                }
            }
            if (account == null) {
                Text(
                    "Sign in with your cloud.backyard-hero.com account to download shows built in the cloud builder.",
                    color = ByhColors.TextDim, fontSize = 14.sp,
                )
            }
            error?.let { Text(it, color = ByhColors.Danger, fontSize = 13.sp) }
            if (account != null && cloudShows != null && cloudShows.isEmpty()) {
                Text("No shows in this account yet.", color = ByhColors.TextDim, fontSize = 14.sp)
            }
        }
    }
    if (account == null || cloudShows == null) return
    val downloaded = localShows.mapNotNull { s -> s.cloudId?.let { it to s } }.toMap()
    items(cloudShows, key = { "cloud-row-${it.id}" }) { info ->
        val local = downloaded[info.id]
        CloudShowRow(
            info = info,
            onPhone = local != null,
            stale = local != null && local.cloudUpdatedAt != info.updatedAt,
            busy = downloading == info.id,
            enabled = downloading == null,
            onDownload = { onDownload(info) },
        )
    }
}

@Composable
private fun CloudShowRow(
    info: CloudShowInfo,
    onPhone: Boolean,
    stale: Boolean,
    busy: Boolean,
    enabled: Boolean,
    onDownload: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(ByhColors.Surface, RoundedCornerShape(10.dp))
            .border(1.dp, ByhColors.Outline, RoundedCornerShape(10.dp))
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(info.name, color = ByhColors.Text, fontWeight = FontWeight.Medium)
            val (status, color) = when {
                stale -> "Changed in the cloud since download" to ByhColors.Warn
                onPhone -> "On this phone" to ByhColors.Ok
                else -> "Not downloaded" to ByhColors.TextDim
            }
            Text(
                "${clock((info.durationSec * 1000).toLong())} · $status",
                color = color, fontSize = 12.sp,
            )
        }
        when {
            busy -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            stale -> Button(onClick = onDownload, enabled = enabled) { Text("Update") }
            onPhone -> TextButton(onClick = onDownload, enabled = enabled) { Text("Re-download") }
            else -> OutlinedButton(onClick = onDownload, enabled = enabled) { Text("Download") }
        }
    }
}

/** [signIn] returns an error message, or null once signed in. */
@Composable
fun CloudSignInDialog(onDismiss: () -> Unit, signIn: suspend (String, String) -> String?) {
    val scope = rememberCoroutineScope()
    var email by rememberSaveable { mutableStateOf("") }
    // Not saveable: the password must not be written into saved instance state.
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Cloud builder sign-in") },
        text = {
            Column {
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    label = { Text("Email") },
                    singleLine = true,
                    enabled = !busy,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text("Password") },
                    singleLine = true,
                    enabled = !busy,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    modifier = Modifier.fillMaxWidth(),
                )
                error?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = ByhColors.Danger, fontSize = 13.sp)
                }
            }
        },
        confirmButton = {
            Button(
                enabled = !busy && email.isNotBlank() && password.isNotEmpty(),
                onClick = {
                    busy = true
                    error = null
                    scope.launch {
                        val failed = signIn(email, password)
                        busy = false
                        if (failed == null) onDismiss() else error = failed
                    }
                },
            ) { Text(if (busy) "Signing in…" else "Sign in") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Cancel") } },
    )
}
