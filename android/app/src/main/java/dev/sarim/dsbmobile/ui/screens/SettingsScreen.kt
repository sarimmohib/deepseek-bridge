package dev.sarim.dsbmobile.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import dev.sarim.dsbmobile.BuildConfig
import dev.sarim.dsbmobile.DsbViewModel
import dev.sarim.dsbmobile.ui.Body
import dev.sarim.dsbmobile.ui.Display
import dev.sarim.dsbmobile.ui.DsbBottomBar
import dev.sarim.dsbmobile.ui.Hairline
import dev.sarim.dsbmobile.ui.LimeAction
import dev.sarim.dsbmobile.ui.Mono
import dev.sarim.dsbmobile.ui.OutlineAction
import dev.sarim.dsbmobile.ui.SectionLabel
import dev.sarim.dsbmobile.ui.theme.Dsb

@Composable
fun SettingsScreen(
    vm: DsbViewModel,
    onEditServer: () -> Unit,
    onTab: (String) -> Unit,
) {
    val context = LocalContext.current
    val server = vm.active
    var confirmForget by remember { mutableStateOf(false) }
    var confirmClear by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize().background(Dsb.Bg).statusBarsPadding()) {
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp),
        ) {
            Spacer(Modifier.height(18.dp))
            Display("SETUP", size = 38)
            Spacer(Modifier.height(2.dp))
            Mono("SERVER · KEYS · LOCAL DATA", size = 9, letterSpacing = 1.6f)

            Spacer(Modifier.height(20.dp))
            SectionLabel("ACTIVE SERVER")
            Spacer(Modifier.height(8.dp))
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(Dsb.Surface, RoundedCornerShape(10.dp))
                    .border(1.dp, Dsb.Line, RoundedCornerShape(10.dp))
                    .padding(14.dp),
            ) {
                if (server == null) {
                    Body("No server selected.", size = 13, color = Dsb.Muted)
                } else {
                    Mono(server.baseUrl, size = 11, color = Dsb.Text, letterSpacing = 0.3f, maxLines = 2)
                    Spacer(Modifier.height(6.dp))
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Mono(if (server.isProxy) "TAILNET PROXY" else "DIRECT", size = 8, color = Dsb.Lime)
                        Mono("· ${vm.health?.version ?: "not connected"}", size = 8)
                        Mono("· ${vm.accounts.size} accounts", size = 8)
                    }
                    Spacer(Modifier.height(10.dp))
                    Hairline()
                    Spacer(Modifier.height(10.dp))
                    Row(
                        Modifier.fillMaxWidth().clickable {
                            copy(context, server.apiKey, "API key")
                        },
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Column {
                            Mono("API KEY", size = 8)
                            Spacer(Modifier.height(3.dp))
                            Mono(
                                if (server.apiKey.isBlank()) "injected by proxy" else server.apiKey.take(12) + "…" + server.apiKey.takeLast(4),
                                size = 11,
                                color = Dsb.Text,
                            )
                        }
                        Icon(Icons.Outlined.ContentCopy, null, tint = Dsb.Muted, modifier = Modifier.size(15.dp))
                    }
                }
            }

            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.weight(1f)) {
                    OutlineAction("TEST", icon = Icons.Outlined.Refresh) { vm.refresh() }
                }
                Box(Modifier.weight(1f)) {
                    OutlineAction("EDIT SERVER") { onEditServer() }
                }
            }
            Spacer(Modifier.height(8.dp))
            OutlineAction("OPEN BRIDGE DASHBOARD", icon = Icons.Outlined.OpenInNew) {
                val url = server?.let {
                    if (it.isProxy) it.baseUrl.trimEnd('/') + "/" else it.baseUrl.trimEnd('/') + "/"
                }
                if (url == null) {
                    Toast.makeText(context, "Select a server first", Toast.LENGTH_SHORT).show()
                } else {
                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                }
            }

            Spacer(Modifier.height(22.dp))
            SectionLabel("TERMINAL LOGIN")
            Spacer(Modifier.height(6.dp))
            Body(
                "The bridge also accepts tokens from the terminal. Copy a token from the WebView, or run this on the host:",
                size = 12,
                color = Dsb.Muted,
            )
            Spacer(Modifier.height(8.dp))
            Row(
                Modifier
                    .fillMaxWidth()
                    .border(1.dp, Dsb.Line, RoundedCornerShape(6.dp))
                    .clickable { copy(context, "deepseek login <token>", "command") }
                    .padding(horizontal = 12.dp, vertical = 11.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Mono("deepseek login <token>", size = 9, color = Dsb.Text, maxLines = 1, letterSpacing = 0.2f)
                Icon(Icons.Outlined.ContentCopy, null, tint = Dsb.Muted, modifier = Modifier.size(14.dp))
            }

            Spacer(Modifier.height(22.dp))
            SectionLabel("LOCAL DATA")
            Spacer(Modifier.height(6.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Mono("SAVED LOGINS", size = 9)
                Mono("${vm.vault.size}", size = 11, color = Dsb.Text)
            }
            Spacer(Modifier.height(8.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Mono("KNOWN SERVERS", size = 9)
                Mono("${vm.servers.size}", size = 11, color = Dsb.Text)
            }
            Spacer(Modifier.height(8.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Mono("ENCRYPTION", size = 9)
                Mono("AES-256-GCM / KEYSTORE", size = 9, color = Dsb.Lime)
            }

            Spacer(Modifier.height(12.dp))
            OutlineAction("CLEAR SAVED LOGINS", tint = Dsb.Red) { confirmClear = true }
            Spacer(Modifier.height(8.dp))
            OutlineAction("FORGET ACTIVE SERVER", tint = Dsb.Red, enabled = server != null) { confirmForget = true }

            Spacer(Modifier.height(22.dp))
            Hairline()
            Spacer(Modifier.height(10.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Mono("DSB MOBILE", size = 9, color = Dsb.Text)
                Mono("v${BuildConfig.VERSION_NAME}", size = 9)
            }
            Spacer(Modifier.height(4.dp))
            Body("Talks to deepseek-bridge over LAN or Tailscale. Tokens never leave the phone except to your own bridge.", size = 10, color = Dsb.Muted)
            Spacer(Modifier.height(26.dp))
        }
        DsbBottomBar(current = "setup", onSelect = onTab)
    }

    if (confirmClear) {
        Dialog(onDismissRequest = { confirmClear = false }) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(Dsb.Surface, RoundedCornerShape(10.dp))
                    .border(1.dp, Dsb.Line, RoundedCornerShape(10.dp))
                    .padding(18.dp),
            ) {
                Display("CLEAR SAVED LOGINS?", size = 20)
                Spacer(Modifier.height(8.dp))
                Body(
                    "This removes every token stored on this phone. The bridge keeps its accounts.",
                    size = 12,
                    color = Dsb.Muted,
                )
                Spacer(Modifier.height(16.dp))
                OutlineAction("CANCEL", tint = Dsb.Muted) { confirmClear = false }
                Spacer(Modifier.height(8.dp))
                LimeAction("CLEAR") {
                    vm.clearVault()
                    confirmClear = false
                    Toast.makeText(context, "Vault cleared", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    if (confirmForget && server != null) {
        Dialog(onDismissRequest = { confirmForget = false }) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(Dsb.Surface, RoundedCornerShape(10.dp))
                    .border(1.dp, Dsb.Line, RoundedCornerShape(10.dp))
                    .padding(18.dp),
            ) {
                Display("FORGET SERVER?", size = 20)
                Spacer(Modifier.height(8.dp))
                Body(server.baseUrl, size = 11, color = Dsb.Muted)
                Spacer(Modifier.height(16.dp))
                OutlineAction("CANCEL", tint = Dsb.Muted) { confirmForget = false }
                Spacer(Modifier.height(8.dp))
                LimeAction("FORGET") {
                    vm.forgetServer(server.id)
                    confirmForget = false
                    onEditServer()
                }
            }
        }
    }
}

private fun copy(context: Context, text: String, label: String) {
    val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    manager.setPrimaryClip(ClipData.newPlainText(label, text))
    Toast.makeText(context, "$label copied", Toast.LENGTH_SHORT).show()
}
