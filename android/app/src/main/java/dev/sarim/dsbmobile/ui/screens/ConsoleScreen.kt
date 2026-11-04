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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import dev.sarim.dsbmobile.DsbViewModel
import dev.sarim.dsbmobile.data.Account
import dev.sarim.dsbmobile.ui.Body
import dev.sarim.dsbmobile.ui.Display
import dev.sarim.dsbmobile.ui.DsbBottomBar
import dev.sarim.dsbmobile.ui.DsbIconButton
import dev.sarim.dsbmobile.ui.Hairline
import dev.sarim.dsbmobile.ui.LimeAction
import dev.sarim.dsbmobile.ui.MetricCell
import dev.sarim.dsbmobile.ui.Mono
import dev.sarim.dsbmobile.ui.OutlineAction
import dev.sarim.dsbmobile.ui.SectionLabel
import dev.sarim.dsbmobile.ui.SignalSpine
import dev.sarim.dsbmobile.ui.StatusDot
import dev.sarim.dsbmobile.ui.compactNumber
import dev.sarim.dsbmobile.ui.relativeTime
import dev.sarim.dsbmobile.ui.shortTime
import dev.sarim.dsbmobile.ui.theme.Dsb

@Composable
fun ConsoleScreen(
    vm: DsbViewModel,
    onAddAccount: () -> Unit,
    onTab: (String) -> Unit,
) {
    val health = vm.health
    val status = vm.status
    val expired = vm.accounts.count { it.isExpired }
    val ready = vm.accounts.count { it.isReady }

    Column(Modifier.fillMaxSize().background(Dsb.Bg).statusBarsPadding()) {
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp),
        ) {
            Spacer(Modifier.height(18.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column {
                    Display("CONSOLE", size = 38)
                    Spacer(Modifier.height(2.dp))
                    Mono(
                        "${vm.active?.label ?: "no server"} · ${health?.mode ?: "offline"}".uppercase(),
                        size = 9,
                        color = Dsb.Lime,
                        letterSpacing = 1.6f,
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    DsbIconButton(Icons.Outlined.Refresh, "Refresh", onClick = { vm.refresh() })
                    DsbIconButton(Icons.Outlined.Settings, "Settings", onClick = { onTab("setup") })
                }
            }

            if (expired > 0) {
                Spacer(Modifier.height(16.dp))
                Row(
                    Modifier
                        .fillMaxWidth()
                        .border(1.dp, Dsb.Amber, RoundedCornerShape(6.dp))
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(Icons.Outlined.Warning, null, tint = Dsb.Amber, modifier = Modifier.size(14.dp))
                    Mono("$expired LOGINS EXPIRED · ROTATION LIMITED", size = 9, color = Dsb.Amber, letterSpacing = 0.6f)
                }
            }

            Spacer(Modifier.height(20.dp))
            SignalSpine(vm.accounts)
            Spacer(Modifier.height(8.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Mono("$ready READY / $expired EXPIRED / ${vm.accounts.size} TOTAL", size = 9, maxLines = 1)
                Mono("SYNCED ${shortTime(vm.lastRefreshAt)}", size = 9)
            }

            Spacer(Modifier.height(20.dp))
            Column(
                Modifier
                    .fillMaxWidth()
                    .border(1.dp, Dsb.Line, RoundedCornerShape(8.dp)),
            ) {
                Row(Modifier.fillMaxWidth()) {
                    MetricCell("VERSION", health?.version ?: "—", Modifier.weight(1f))
                    Box(Modifier.size(width = 1.dp, height = 58.dp).background(Dsb.Line))
                    MetricCell("MODE", health?.mode?.uppercase() ?: "OFFLINE", Modifier.weight(1f), Dsb.Lime)
                }
                Hairline()
                Row(Modifier.fillMaxWidth()) {
                    val upstream = health?.upstream
                    MetricCell(
                        "UPSTREAM QUEUE",
                        "${upstream?.active ?: 0} / ${upstream?.max ?: 0}",
                        Modifier.weight(1f),
                    )
                    Box(Modifier.size(width = 1.dp, height = 58.dp).background(Dsb.Line))
                    MetricCell(
                        "CONTEXT WINDOW",
                        compactNumber(status?.capabilities?.contextWindow),
                        Modifier.weight(1f),
                    )
                }
            }

            Spacer(Modifier.height(18.dp))
            LimeAction("ADD ACCOUNT", icon = Icons.Outlined.Add, onClick = onAddAccount)
            Spacer(Modifier.height(8.dp))
            OutlineAction(
                text = if (vm.pushProgress != null) {
                    "CHECKING ${vm.pushProgress!!.first + 1}/${vm.pushProgress!!.second}"
                } else {
                    "RUN HEALTH CHECK"
                },
                icon = Icons.Outlined.PlayArrow,
                enabled = vm.pushProgress == null && vm.accounts.isNotEmpty(),
                onClick = { vm.verifyAll() },
            )
            vm.notice?.let {
                Spacer(Modifier.height(10.dp))
                Body(it, size = 12, color = Dsb.Lime)
            }
            vm.error?.let {
                Spacer(Modifier.height(10.dp))
                Body(it, size = 12, color = Dsb.Red)
            }

            Spacer(Modifier.height(22.dp))
            SectionLabel("LATEST")
            Spacer(Modifier.height(4.dp))
            val latest = vm.accounts.sortedByDescending { it.lastUsedAt ?: 0 }.take(3)
            if (latest.isEmpty()) {
                Body("No accounts on this bridge yet.", size = 12, color = Dsb.Muted)
            } else {
                latest.forEach { account -> LatestRow(account) }
            }

            Spacer(Modifier.height(24.dp))
        }
        DsbBottomBar(current = "console", onSelect = onTab)
    }
}

@Composable
private fun LatestRow(account: Account) {
    Row(
        Modifier.fillMaxWidth().height(34.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Mono(shortTime(account.lastUsedAt), size = 9)
            Mono(
                "${account.shortId} · ${account.stateLabel.lowercase()} · ${relativeTime(account.lastUsedAt)}",
                size = 10,
                color = Dsb.Text,
            )
        }
        StatusDot(Color(account.stateColor))
    }
}
