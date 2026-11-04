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
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import dev.sarim.dsbmobile.DsbViewModel
import dev.sarim.dsbmobile.data.Account
import dev.sarim.dsbmobile.ui.Body
import dev.sarim.dsbmobile.ui.Display
import dev.sarim.dsbmobile.ui.DsbBottomBar
import dev.sarim.dsbmobile.ui.Hairline
import dev.sarim.dsbmobile.ui.LimeAction
import dev.sarim.dsbmobile.ui.Mono
import dev.sarim.dsbmobile.ui.OutlineAction
import dev.sarim.dsbmobile.ui.SectionLabel
import dev.sarim.dsbmobile.ui.StatusDot
import dev.sarim.dsbmobile.ui.relativeTime
import dev.sarim.dsbmobile.ui.shortTime
import dev.sarim.dsbmobile.ui.theme.Dsb
import kotlinx.coroutines.launch

@Composable
fun PoolScreen(
    vm: DsbViewModel,
    onAddAccount: () -> Unit,
    onRelogin: (String) -> Unit,
    onTab: (String) -> Unit,
) {
    var selected by remember { mutableStateOf<Account?>(null) }
    var confirmRemove by remember { mutableStateOf<Account?>(null) }
    val scope = rememberCoroutineScope()
    val ready = vm.accounts.count { it.isReady }
    val expired = vm.accounts.count { it.isExpired }
    val cooling = vm.accounts.count { it.cooling && !it.isExpired }

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
                    Display("POOL", size = 38)
                    Spacer(Modifier.height(2.dp))
                    Mono("${vm.accounts.size} LOGINS STORED", size = 9, letterSpacing = 1.6f)
                }
                Mono("$ready / ${vm.accounts.size}", size = 16, color = Dsb.Lime, letterSpacing = 1f)
            }

            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Legend("READY", Dsb.Lime)
                Legend("EXPIRED", Dsb.Red)
                Legend("COOLING", Dsb.Amber)
            }

            Spacer(Modifier.height(8.dp))
            if (vm.accounts.isEmpty()) {
                Spacer(Modifier.height(24.dp))
                Body("No accounts on this bridge. Register one below.", size = 13, color = Dsb.Muted)
            } else {
                vm.accounts.forEachIndexed { index, account ->
                    AccountRow(account) { selected = account }
                    if (index != vm.accounts.lastIndex) Hairline()
                }
            }

            Spacer(Modifier.height(16.dp))
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(Dsb.Surface, RoundedCornerShape(6.dp))
                    .border(1.dp, Dsb.Line, RoundedCornerShape(6.dp))
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(Icons.Outlined.Info, null, tint = Dsb.Amber, modifier = Modifier.size(13.dp))
                Body("Expired logins can be replaced without removing them.", size = 11, color = Dsb.Muted)
            }

            vm.notice?.let {
                Spacer(Modifier.height(10.dp))
                Body(it, size = 12, color = Dsb.Lime)
            }
            vm.error?.let {
                Spacer(Modifier.height(10.dp))
                Body(it, size = 12, color = Dsb.Red)
            }
            Spacer(Modifier.height(24.dp))
        }

        Column(Modifier.padding(horizontal = 24.dp).padding(bottom = 12.dp)) {
            LimeAction("REGISTER NEW", icon = Icons.Outlined.PersonAdd, onClick = onAddAccount)
        }
        DsbBottomBar(current = "pool", onSelect = onTab)
    }

    selected?.let { account ->
        AccountDialog(
            account = account,
            hasLocalToken = vm.vault.any { it.accountId == account.id },
            onDismiss = { selected = null },
            onTest = {
                selected = null
                val entry = vm.vault.firstOrNull { it.accountId == account.id }
                if (entry == null) {
                    vm.notice = "Token for ${account.shortId} is not stored on this phone"
                } else {
                    scope.launch { vm.verifyVault(entry) }
                }
            },
            onTestMessage = {
                selected = null
                vm.testMessage(account)
            },
            onRelogin = {
                selected = null
                onRelogin(account.id)
            },
            onRemove = {
                selected = null
                confirmRemove = account
            },
        )
    }

    confirmRemove?.let { account ->
        Dialog(onDismissRequest = { confirmRemove = null }) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(Dsb.Surface, RoundedCornerShape(10.dp))
                    .border(1.dp, Dsb.Line, RoundedCornerShape(10.dp))
                    .padding(18.dp),
            ) {
                Display("REMOVE ${account.shortId}?", size = 20)
                Spacer(Modifier.height(8.dp))
                Body("This deletes the login from the bridge. The vault copy stays unless you delete it there.", size = 12, color = Dsb.Muted)
                Spacer(Modifier.height(16.dp))
                OutlineAction("CANCEL", tint = Dsb.Muted) { confirmRemove = null }
                Spacer(Modifier.height(8.dp))
                LimeAction("REMOVE", enabled = !vm.busy) {
                    confirmRemove = null
                    scope.launch { vm.removeAccount(account) }
                }
            }
        }
    }

    vm.messageTest?.let { result ->
        Dialog(onDismissRequest = { vm.clearMessageTest() }) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(Dsb.Surface, RoundedCornerShape(10.dp))
                    .border(1.dp, Dsb.Line, RoundedCornerShape(10.dp))
                    .padding(18.dp),
            ) {
                SectionLabel("MESSAGE TEST")
                Spacer(Modifier.height(6.dp))
                Display(result.shortId, size = 24)
                Spacer(Modifier.height(10.dp))
                Mono("PROMPT", size = 8, color = Dsb.Muted)
                Spacer(Modifier.height(3.dp))
                Body(result.prompt, size = 12, color = Dsb.Text)
                Spacer(Modifier.height(12.dp))
                Mono(if (result.error == null) "ASSISTANT REPLY" else "FAILED", size = 8, color = Dsb.Muted)
                Spacer(Modifier.height(3.dp))
                if (result.error == null) {
                    Body(result.reply.ifBlank { "(empty reply)" }, size = 13, color = Dsb.Text, maxLines = 10)
                } else {
                    Body(result.error, size = 12, color = Dsb.Red, maxLines = 6)
                }
                Spacer(Modifier.height(12.dp))
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatusDot(if (result.error == null) Dsb.Lime else Dsb.Red)
                    Mono(
                        if (result.error == null) "${result.ms} MS · TOKEN WORKS" else "TOKEN FAILED",
                        size = 8,
                        color = if (result.error == null) Dsb.Lime else Dsb.Red,
                    )
                }
                Spacer(Modifier.height(14.dp))
                LimeAction("CLOSE") { vm.clearMessageTest() }
            }
        }
    }
}

@Composable
private fun Legend(label: String, color: Color) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        StatusDot(color)
        Mono(label, size = 9)
    }
}

@Composable
private fun AccountRow(account: Account, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(64.dp).clickable(onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Mono(account.shortId, size = 12, color = Dsb.Text, letterSpacing = 0.5f)
            Column {
                Mono(account.stateLabel, size = 8, color = Color(account.stateColor), letterSpacing = 0.9f)
                Mono(
                    "last used ${if (account.lastUsedAt != null) relativeTime(account.lastUsedAt) else "never"}",
                    size = 8,
                    color = Dsb.Muted,
                )
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Mono(shortTime(account.lastUsedAt), size = 8, color = Dsb.Muted)
            Icon(Icons.Outlined.ChevronRight, null, tint = Dsb.Muted, modifier = Modifier.size(14.dp))
        }
    }
}

@Composable
private fun AccountDialog(
    account: Account,
    hasLocalToken: Boolean,
    onDismiss: () -> Unit,
    onTest: () -> Unit,
    onTestMessage: () -> Unit,
    onRelogin: () -> Unit,
    onRemove: () -> Unit,
) {
    Dialog(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .background(Dsb.Surface, RoundedCornerShape(10.dp))
                .border(1.dp, Dsb.Line, RoundedCornerShape(10.dp))
                .padding(18.dp),
        ) {
            SectionLabel("ACCOUNT")
            Spacer(Modifier.height(6.dp))
            Display(account.shortId, size = 26)
            Spacer(Modifier.height(4.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                StatusDot(Color(account.stateColor))
                Mono(account.stateLabel, size = 9, color = Color(account.stateColor))
                Mono("· ${account.successCount} OK · ${account.failureCount} FAIL", size = 8)
            }
            account.lastError?.message?.let {
                Spacer(Modifier.height(8.dp))
                Body(it, size = 11, color = Dsb.Red, maxLines = 3)
            }
            Spacer(Modifier.height(16.dp))
            OutlineAction(
                if (hasLocalToken) "TEST LOGIN" else "TEST LOGIN (NO TOKEN HERE)",
                enabled = hasLocalToken,
                onClick = onTest,
            )
            Spacer(Modifier.height(8.dp))
            OutlineAction("TEST MESSAGE", onClick = onTestMessage)
            Spacer(Modifier.height(8.dp))
            OutlineAction("RELOGIN / REPLACE", onClick = onRelogin)
            Spacer(Modifier.height(8.dp))
            LimeAction("REMOVE", onClick = onRemove)
            Spacer(Modifier.height(10.dp))
            Mono("TAP OUTSIDE TO CLOSE", size = 8, color = Dsb.Muted)
        }
    }
}
