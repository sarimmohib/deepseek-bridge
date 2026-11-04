package dev.sarim.dsbmobile.ui.screens

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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.sarim.dsbmobile.DsbViewModel
import dev.sarim.dsbmobile.data.ServerConfig
import dev.sarim.dsbmobile.ui.DsbField
import dev.sarim.dsbmobile.ui.Display
import dev.sarim.dsbmobile.ui.Hairline
import dev.sarim.dsbmobile.ui.LimeAction
import dev.sarim.dsbmobile.ui.Mono
import dev.sarim.dsbmobile.ui.Body
import dev.sarim.dsbmobile.ui.OutlineAction
import dev.sarim.dsbmobile.ui.SectionLabel
import dev.sarim.dsbmobile.ui.SignalSpine
import dev.sarim.dsbmobile.ui.Tag
import dev.sarim.dsbmobile.ui.shortTime
import dev.sarim.dsbmobile.ui.theme.Dsb
import kotlinx.coroutines.launch

const val DEFAULT_PROXY_URL = "http://desktop-drbedno.tailce34b1.ts.net/bridge"

@Composable
fun ConnectScreen(
    vm: DsbViewModel,
    onOpenConsole: () -> Unit,
) {
    var url by rememberSaveable { mutableStateOf(vm.active?.baseUrl ?: DEFAULT_PROXY_URL) }
    var key by rememberSaveable { mutableStateOf(vm.active?.apiKey ?: "") }
    var keyVisible by remember { mutableStateOf(false) }
    var manualToken by remember { mutableStateOf("") }
    var manualLabel by remember { mutableStateOf("") }
    var manualBusy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val normalized = remember(url) { vm.normalizeUrl(url) }
    val isProxy = remember(normalized) { ServerConfig(baseUrl = normalized).isProxy }
    val connected = vm.health?.ok == true
    val counts = vm.health?.accounts

    Column(
        Modifier
            .fillMaxSize()
            .background(Dsb.Bg)
            .statusBarsPadding()
            .navigationBarsPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp),
    ) {
        Spacer(Modifier.height(18.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Mono("DEEPSEEK BRIDGE", size = 9, letterSpacing = 2.4f)
            Mono("v0.1.0", size = 9)
        }

        Spacer(Modifier.height(26.dp))
        Display("LINK", size = 86)
        Spacer(Modifier.height(6.dp))
        Mono("TAILNET / LAN CONTROL", color = Dsb.Lime, size = 9, letterSpacing = 2.2f)

        Spacer(Modifier.height(26.dp))
        SectionLabel("ENDPOINT")
        Spacer(Modifier.height(8.dp))
        DsbField(
            value = url,
            onValueChange = { url = it },
            placeholder = "http://host:8787 or http://host/bridge",
            mono = true,
            keyboardType = KeyboardType.Uri,
        )
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            QuickChip("TAILNET PROXY") { url = DEFAULT_PROXY_URL }
            QuickChip("LOCAL 8787") { url = "http://127.0.0.1:8787" }
        }

        if (!isProxy) {
            Spacer(Modifier.height(18.dp))
            SectionLabel("API KEY")
            Spacer(Modifier.height(8.dp))
            DsbField(
                value = key,
                onValueChange = { key = it },
                placeholder = "sk-ds-…",
                mono = true,
                password = !keyVisible,
                trailing = {
                    IconButton(onClick = { keyVisible = !keyVisible }) {
                        Icon(
                            if (keyVisible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                            contentDescription = "Show key",
                            tint = Dsb.Muted,
                        )
                    }
                },
            )
        } else {
            Spacer(Modifier.height(8.dp))
            Mono("PROXY MODE · KEY IS INJECTED BY /bridge", size = 8, color = Dsb.Muted, letterSpacing = 1.2f)
        }

        Spacer(Modifier.height(18.dp))
        LimeAction(
            text = if (connected) "OPEN CONSOLE" else "CONNECT",
            icon = Icons.AutoMirrored.Outlined.ArrowForward,
            enabled = !vm.busy && url.isNotBlank(),
            onClick = {
                if (connected && vm.active != null) {
                    onOpenConsole()
                } else {
                    scope.launch {
                        if (vm.connect(url, key)) onOpenConsole()
                    }
                }
            },
        )

        if (vm.busy) {
            Spacer(Modifier.height(10.dp))
            Mono("PROBING…", size = 9, color = Dsb.Amber)
        }

        val error = vm.error
        if (error != null) {
            Spacer(Modifier.height(10.dp))
            Box(
                Modifier
                    .fillMaxWidth()
                    .border(1.dp, Dsb.Red, RoundedCornerShape(6.dp))
                    .padding(10.dp),
            ) {
                Body(error, size = 12, color = Dsb.Red)
            }
        }
        vm.notice?.let {
            Spacer(Modifier.height(10.dp))
            Body(it, size = 12, color = Dsb.Lime)
        }

        if (connected) {
            Spacer(Modifier.height(20.dp))
            Box(
                Modifier
                    .fillMaxWidth()
                    .background(Dsb.Surface, RoundedCornerShape(10.dp))
                    .border(1.dp, Dsb.Line, RoundedCornerShape(10.dp))
                    .padding(16.dp),
            ) {
                Column {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Column {
                            Display("REACHABLE", size = 30, color = Dsb.Lime)
                            Spacer(Modifier.height(2.dp))
                            Mono(vm.active?.label ?: normalized, size = 9)
                        }
                        Column(horizontalAlignment = Alignment.End) {
                            Mono("${vm.latencyMs ?: "—"} MS", size = 17, color = Dsb.Text, letterSpacing = 0.5f)
                            Mono("ROUND TRIP", size = 8, letterSpacing = 1.4f)
                        }
                    }
                    Spacer(Modifier.height(12.dp))
                    Hairline()
                    Spacer(Modifier.height(12.dp))
                    SignalSpine(vm.accounts, height = 30)
                    Spacer(Modifier.height(10.dp))
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Mono(
                            "${counts?.count ?: 0} TOKENS · ${counts?.ready ?: 0} READY",
                            size = 9,
                        )
                        Mono(
                            (vm.health?.mode ?: "direct").uppercase(),
                            size = 9,
                            color = Dsb.Lime,
                            letterSpacing = 1.4f,
                        )
                    }
                }
            }
        }

        if (vm.servers.isNotEmpty()) {
            Spacer(Modifier.height(26.dp))
            SectionLabel("RECENT")
            Spacer(Modifier.height(2.dp))
            vm.servers.sortedByDescending { it.lastUsedAt }.take(4).forEachIndexed { index, server ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .height(46.dp)
                        .clickable {
                            url = server.baseUrl
                            key = server.apiKey
                            scope.launch { if (vm.connect(server.baseUrl, server.apiKey)) onOpenConsole() }
                        },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Box(
                            Modifier
                                .size(6.dp)
                                .background(
                                    if (server.id == vm.activeId) Dsb.Lime else Dsb.Muted,
                                    RoundedCornerShape(3.dp),
                                ),
                        )
                        Mono(server.label, size = 10, color = Dsb.Text)
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Mono(if (server.isProxy) "PROXY" else shortTime(server.lastUsedAt), size = 9)
                        Icon(Icons.Outlined.ChevronRight, null, tint = Dsb.Muted, modifier = Modifier.size(13.dp))
                    }
                }
                if (index != vm.servers.take(4).lastIndex) Hairline()
            }
        }

        Spacer(Modifier.height(26.dp))
        SectionLabel("MANUAL LOGIN")
        Spacer(Modifier.height(6.dp))
        Body("Paste a userToken when the WebView cannot sign in.", size = 12, color = Dsb.Muted)
        Spacer(Modifier.height(10.dp))
        DsbField(manualToken, { manualToken = it }, "userToken", mono = true)
        Spacer(Modifier.height(8.dp))
        DsbField(manualLabel, { manualLabel = it }, "label (optional)")
        Spacer(Modifier.height(10.dp))
        OutlineAction(
            text = if (manualBusy) "REGISTERING…" else "REGISTER TOKEN",
            enabled = manualToken.trim().length >= 20 && vm.active != null && !manualBusy,
            onClick = {
                scope.launch {
                    manualBusy = true
                    try {
                        vm.addManualToken(manualToken, manualLabel)
                        manualToken = ""
                        manualLabel = ""
                    } catch (_: Exception) {
                        // vm.error carries the message
                    } finally {
                        manualBusy = false
                    }
                }
            },
        )

        Spacer(Modifier.height(28.dp))
        Hairline()
        Spacer(Modifier.height(10.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Mono("MODE", size = 9)
            Mono(if (isProxy) "TAILNET PROXY" else "DIRECT · KEY REQUIRED", size = 9, color = Dsb.Muted)
        }
        Spacer(Modifier.height(26.dp))
    }
}

@Composable
private fun QuickChip(label: String, onClick: () -> Unit) {
    Box(
        Modifier
            .border(1.dp, Dsb.Line, RoundedCornerShape(4.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 9.dp, vertical = 6.dp),
    ) {
        Mono(label, size = 8, color = Dsb.Muted, letterSpacing = 1.1f)
    }
}
