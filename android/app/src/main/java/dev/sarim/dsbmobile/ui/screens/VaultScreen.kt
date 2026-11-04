package dev.sarim.dsbmobile.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.Upload
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.core.content.FileProvider
import dev.sarim.dsbmobile.DsbViewModel
import dev.sarim.dsbmobile.data.VaultLogin
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
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun VaultScreen(
    vm: DsbViewModel,
    onTab: (String) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var confirmDelete by remember { mutableStateOf<VaultLogin?>(null) }

    fun writeExport(uri: Uri?) {
        if (uri == null) return
        runCatching {
            context.contentResolver.openOutputStream(uri)?.use { out ->
                out.write(vm.exportJson().toByteArray(Charsets.UTF_8))
            }
        }.onSuccess {
            Toast.makeText(context, "Vault exported", Toast.LENGTH_SHORT).show()
        }.onFailure {
            Toast.makeText(context, "Export failed: ${it.message}", Toast.LENGTH_LONG).show()
        }
    }

    val createDoc = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        writeExport(uri)
    }
    val openDoc = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            runCatching {
                val text = context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() } ?: ""
                val entries = vm.parseImport(text)
                val added = vm.importVault(entries)
                Toast.makeText(context, "$added login(s) imported", Toast.LENGTH_SHORT).show()
            }.onFailure {
                Toast.makeText(context, "Import failed: ${it.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    Column(Modifier.fillMaxSize().background(Dsb.Bg).statusBarsPadding()) {
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp),
        ) {
            Spacer(Modifier.height(18.dp))
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Display("VAULT", size = 38)
                    Spacer(Modifier.height(2.dp))
                    Mono("AES-256-GCM · ANDROID KEYSTORE", size = 8, letterSpacing = 1.1f)
                }
                Box(
                    Modifier
                        .size(38.dp)
                        .border(1.dp, Dsb.Lime, RoundedCornerShape(6.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Outlined.Lock, null, tint = Dsb.Lime, modifier = Modifier.size(16.dp))
                }
            }

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
                        Mono("BACKUP & HANDOFF", size = 8, letterSpacing = 1.6f)
                        Icon(Icons.Outlined.Share, null, tint = Dsb.Lime, modifier = Modifier.size(14.dp))
                    }
                    Spacer(Modifier.height(8.dp))
                    Display("${vm.vault.size} LOGINS", size = 24)
                    Spacer(Modifier.height(4.dp))
                    Body(
                        "Export a JSON backup, share it with another device, or import a vault someone sent you.",
                        size = 11,
                        color = Dsb.Muted,
                    )
                    Spacer(Modifier.height(14.dp))
                    LimeAction("EXPORT BACKUP", icon = Icons.Outlined.Download) {
                        val stamp = SimpleDateFormat("yyyyMMdd-HHmm", Locale.US).format(Date())
                        createDoc.launch("dsb-vault-$stamp.json")
                    }
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Box(Modifier.weight(1f)) {
                            OutlineAction("SHARE", icon = Icons.Outlined.Share) {
                                scope.launch {
                                    runCatching {
                                        val file = File(context.cacheDir, "dsb-vault.json")
                                        file.writeText(vm.exportJson())
                                        val uri = FileProvider.getUriForFile(
                                            context,
                                            "${context.packageName}.files",
                                            file,
                                        )
                                        val send = Intent(Intent.ACTION_SEND).apply {
                                            type = "application/json"
                                            putExtra(Intent.EXTRA_STREAM, uri)
                                            putExtra(Intent.EXTRA_SUBJECT, "DSB Mobile vault")
                                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                                        }
                                        context.startActivity(Intent.createChooser(send, "Share vault"))
                                    }.onFailure {
                                        Toast.makeText(context, "Share failed: ${it.message}", Toast.LENGTH_LONG).show()
                                    }
                                }
                            }
                        }
                        Box(Modifier.weight(1f)) {
                            OutlineAction("IMPORT", icon = Icons.Outlined.Upload) {
                                openDoc.launch(arrayOf("application/json", "text/plain", "*/*"))
                            }
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    OutlineAction(
                        text = if (vm.pushProgress != null) {
                            "PUSHING ${vm.pushProgress!!.first + 1}/${vm.pushProgress!!.second}"
                        } else {
                            "PUSH ALL TO THIS BRIDGE"
                        },
                        enabled = vm.vault.isNotEmpty() && vm.active != null && vm.pushProgress == null,
                    ) {
                        scope.launch {
                            val (ok, total) = vm.pushAll()
                            vm.notice = "$ok / $total logins pushed"
                        }
                    }
                }
            }

            Spacer(Modifier.height(22.dp))
            SectionLabel("SAVED LOGINS")
            Spacer(Modifier.height(4.dp))
            if (vm.vault.isEmpty()) {
                Spacer(Modifier.height(10.dp))
                Body("No logins saved on this phone yet.", size = 13, color = Dsb.Muted)
            } else {
                vm.vault.sortedByDescending { it.addedAt }.forEachIndexed { index, entry ->
                    VaultRow(
                        entry = entry,
                        onCopy = {
                            copyToClipboard(context, entry.token)
                            Toast.makeText(context, "Token copied", Toast.LENGTH_SHORT).show()
                        },
                        onDelete = { confirmDelete = entry },
                    )
                    if (index != vm.vault.lastIndex) Hairline()
                }
            }

            Spacer(Modifier.height(18.dp))
            Row(
                Modifier
                    .fillMaxWidth()
                    .border(1.dp, Dsb.Line, RoundedCornerShape(6.dp))
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.Lock, null, tint = Dsb.Muted, modifier = Modifier.size(13.dp))
                Body(
                    "Backups are plaintext JSON once exported. Delete them after the handoff.",
                    size = 10,
                    color = Dsb.Muted,
                )
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
        DsbBottomBar(current = "vault", onSelect = onTab)
    }

    confirmDelete?.let { entry ->
        Dialog(onDismissRequest = { confirmDelete = null }) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(Dsb.Surface, RoundedCornerShape(10.dp))
                    .border(1.dp, Dsb.Line, RoundedCornerShape(10.dp))
                    .padding(18.dp),
            ) {
                Display("DELETE LOGIN?", size = 20)
                Spacer(Modifier.height(8.dp))
                Body("The token stays on the bridge; only this phone's copy is removed.", size = 12, color = Dsb.Muted)
                Spacer(Modifier.height(16.dp))
                OutlineAction("CANCEL", tint = Dsb.Muted) { confirmDelete = null }
                Spacer(Modifier.height(8.dp))
                LimeAction("DELETE") {
                    vm.deleteVault(entry.id)
                    confirmDelete = null
                }
            }
        }
    }
}

@Composable
private fun VaultRow(entry: VaultLogin, onCopy: () -> Unit, onDelete: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(56.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            StatusDot(
                when (entry.lastState) {
                    "ready" -> Dsb.Lime
                    "expired" -> Dsb.Red
                    else -> Dsb.Muted
                },
            )
            Column {
                Mono(entry.label.ifBlank { entry.accountId?.take(8) ?: "login" }, size = 11, color = Dsb.Text, letterSpacing = 0.4f)
                Mono(entry.maskedToken, size = 9)
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
            Mono(
                entry.lastVerifiedAt.takeIf { it > 0 }?.let { relativeTime(it) } ?: "new",
                size = 8,
                color = Dsb.Muted,
            )
            Spacer(Modifier.size(4.dp))
            Box(Modifier.size(34.dp).clickable(onClick = onCopy), contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.ContentCopy, "Copy token", tint = Dsb.Muted, modifier = Modifier.size(14.dp))
            }
            Box(Modifier.size(34.dp).clickable(onClick = onDelete), contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.DeleteOutline, "Delete copy", tint = Dsb.Muted, modifier = Modifier.size(14.dp))
            }
        }
    }
}

private fun copyToClipboard(context: Context, text: String) {
    val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    manager.setPrimaryClip(ClipData.newPlainText("DeepSeek token", text))
}

@Suppress("unused")
private fun tokenPreview(entry: VaultLogin): String =
    if (entry.lastVerifiedAt > 0) "${shortTime(entry.lastVerifiedAt)} · ${entry.maskedToken}" else entry.maskedToken
