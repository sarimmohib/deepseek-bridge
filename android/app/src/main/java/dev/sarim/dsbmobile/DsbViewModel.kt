package dev.sarim.dsbmobile

import android.app.Application
import android.os.SystemClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.sarim.dsbmobile.data.Account
import dev.sarim.dsbmobile.data.AddAccountResponse
import dev.sarim.dsbmobile.data.BridgeClient
import dev.sarim.dsbmobile.data.BridgeException
import dev.sarim.dsbmobile.data.BridgeStatus
import dev.sarim.dsbmobile.data.CookieDto
import dev.sarim.dsbmobile.data.Health
import dev.sarim.dsbmobile.data.PersistedState
import dev.sarim.dsbmobile.data.ServerConfig
import dev.sarim.dsbmobile.data.Store
import dev.sarim.dsbmobile.data.VaultLogin
import kotlinx.coroutines.launch
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.UUID

class DsbViewModel(app: Application) : AndroidViewModel(app) {
    private val store = Store(app)
    private val client = BridgeClient()
    private var persisted: PersistedState = store.load()

    var servers by mutableStateOf(persisted.servers)
        private set
    var activeId by mutableStateOf(persisted.activeId)
        private set
    var vault by mutableStateOf(persisted.vault)
        private set

    var health by mutableStateOf<Health?>(null)
        private set
    var status by mutableStateOf<BridgeStatus?>(null)
        private set
    var accounts by mutableStateOf<List<Account>>(emptyList())
        private set

    var busy by mutableStateOf(false)
        private set
    var refreshing by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var notice by mutableStateOf<String?>(null)

    var latencyMs by mutableStateOf<Long?>(null)
        private set
    var lastRefreshAt by mutableStateOf(0L)
        private set
    var verifyingId by mutableStateOf<String?>(null)
        private set
    var testingId by mutableStateOf<String?>(null)
        private set
    var messageTest by mutableStateOf<MessageTest?>(null)
        private set
    var pushProgress by mutableStateOf<Pair<Int, Int>?>(null)
        private set

    data class MessageTest(
        val accountId: String,
        val shortId: String,
        val prompt: String,
        val reply: String,
        val reasoning: String,
        val ms: Long,
        val error: String? = null,
    )

    val active: ServerConfig? get() = servers.firstOrNull { it.id == activeId }

    fun clearNotice() {
        notice = null
    }

    fun clearError() {
        error = null
    }

    private fun persist() {
        persisted = PersistedState(servers, activeId, vault)
        store.save(persisted)
    }

    fun serverById(id: String?): ServerConfig? = servers.firstOrNull { it.id == id }

    fun normalizeUrl(raw: String): String {
        var url = raw.trim()
        if (url.isEmpty()) return url
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://$url"
        return url.trimEnd('/')
    }

    fun serverLabel(url: String): String = runCatching {
        val uri = java.net.URI(url)
        val path = uri.path?.takeIf { it.isNotBlank() && it != "/" } ?: ""
        (uri.host ?: url) + path
    }.getOrDefault(url)

    private fun upsertServerInternal(rawUrl: String, apiKey: String): ServerConfig {
        val url = normalizeUrl(rawUrl)
        val id = url.lowercase()
        val existing = servers.firstOrNull { it.id == id }
        val server = ServerConfig(
            id = id,
            baseUrl = url,
            apiKey = apiKey.trim(),
            label = serverLabel(url),
            lastUsedAt = System.currentTimeMillis(),
        )
        servers = if (existing == null) servers + server else servers.map { if (it.id == id) server else it }
        return server
    }

    fun rememberServer(rawUrl: String, apiKey: String): ServerConfig {
        val server = upsertServerInternal(rawUrl, apiKey)
        activeId = server.id
        persist()
        return server
    }

    fun setActive(id: String?) {
        activeId = id
        persist()
    }

    fun forgetServer(id: String) {
        servers = servers.filterNot { it.id == id }
        if (activeId == id) activeId = servers.firstOrNull()?.id
        persist()
    }

    fun humanError(error: Throwable): String = when (error) {
        is UnknownHostException -> "Host not found. Check the URL or tailnet connection."
        is ConnectException -> "Connection refused. Is the bridge running on that URL?"
        is SocketTimeoutException -> "Timed out. The bridge or the network did not answer."
        is BridgeException -> error.message ?: "Bridge error"
        else -> error.message ?: error.javaClass.simpleName
    }

    /** Probe + load everything for the active (or supplied) server. */
    suspend fun connect(rawUrl: String, apiKey: String): Boolean {
        busy = true
        error = null
        val started = SystemClock.elapsedRealtime()
        return try {
            val candidate = upsertServerInternal(rawUrl, apiKey)
            val h = client.health(candidate)
            if (!h.ok) throw BridgeException("The bridge answered, but /health was not ok", null, null)
            latencyMs = SystemClock.elapsedRealtime() - started
            activeId = candidate.id
            persist()
            health = h
            refreshInternal(candidate)
            true
        } catch (e: Exception) {
            error = humanError(e)
            false
        } finally {
            busy = false
        }
    }

    fun refresh() {
        val server = active ?: return
        viewModelScope.launch {
            refreshing = true
            try {
                refreshInternal(server)
            } catch (e: Exception) {
                error = humanError(e)
            } finally {
                refreshing = false
            }
        }
    }

    private suspend fun refreshInternal(server: ServerConfig) {
        error = null
        val h = client.health(server)
        health = h
        status = runCatching { client.status(server) }.getOrNull()
        val list = client.accounts(server)
        accounts = list.accounts
        lastRefreshAt = System.currentTimeMillis()
    }

    suspend fun addManualToken(token: String, label: String): AddAccountResponse {
        val server = active ?: throw BridgeException("No bridge selected", null, null)
        busy = true
        error = null
        try {
            val response = client.addAccount(server, token.trim(), emptyList(), "", label)
            val account = response.account
            if (account != null) {
                saveVault(
                    VaultLogin(
                        id = UUID.randomUUID().toString(),
                        accountId = account.id,
                        serverId = server.id,
                        label = label.ifBlank { account.shortId },
                        token = token.trim(),
                        addedAt = System.currentTimeMillis(),
                        lastVerifiedAt = System.currentTimeMillis(),
                        lastState = "ready",
                    ),
                )
            }
            runCatching { refreshInternal(server) }
            notice = "Token registered"
            return response
        } catch (e: Exception) {
            error = humanError(e)
            throw e
        } finally {
            busy = false
        }
    }

    fun saveCaptured(
        token: String,
        cookies: List<CookieDto>,
        userAgent: String,
        accountId: String?,
        label: String,
    ) {
        val server = active
        val existing = vault.firstOrNull { it.token == token }
        val entry = VaultLogin(
            id = existing?.id ?: UUID.randomUUID().toString(),
            accountId = accountId ?: existing?.accountId,
            serverId = server?.id ?: existing?.serverId,
            label = label.ifBlank { accountId?.take(8) ?: "account" },
            token = token,
            cookies = cookies,
            userAgent = userAgent,
            addedAt = existing?.addedAt ?: System.currentTimeMillis(),
            lastVerifiedAt = System.currentTimeMillis(),
            lastState = "ready",
            lastError = null,
        )
        saveVault(entry)
    }

    private fun saveVault(entry: VaultLogin) {
        vault = if (vault.any { it.id == entry.id }) {
            vault.map { if (it.id == entry.id) entry else it }
        } else {
            vault + entry
        }
        persist()
    }

    fun deleteVault(id: String) {
        vault = vault.filterNot { it.id == id }
        persist()
    }

    fun clearVault() {
        vault = emptyList()
        persist()
    }

    fun updateVault(entry: VaultLogin) {
        saveVault(entry)
    }

    suspend fun removeAccount(account: Account) {
        val server = active ?: return
        busy = true
        try {
            client.deleteAccount(server, account.id)
            vault = vault.map { if (it.accountId == account.id) it.copy(accountId = null) else it }
            persist()
            runCatching { refreshInternal(server) }
            notice = "Account ${account.shortId} removed"
        } catch (e: Exception) {
            error = humanError(e)
        } finally {
            busy = false
        }
    }

    /** Re-POST a stored token; the bridge dedupes it and verifies that exact account. */
    suspend fun verifyVault(entry: VaultLogin): Boolean {
        val server = active ?: return false
        verifyingId = entry.id
        return try {
            val response = client.addAccount(server, entry.token, entry.cookies, entry.userAgent, entry.label)
            val account = response.account
            val updated = entry.copy(
                accountId = account?.id ?: entry.accountId,
                serverId = server.id,
                lastVerifiedAt = System.currentTimeMillis(),
                lastState = "ready",
                lastError = null,
            )
            saveVault(updated)
            runCatching { refreshInternal(server) }
            notice = "Login ${entry.label.ifBlank { entry.id.take(6) }} is healthy"
            true
        } catch (e: Exception) {
            val updated = entry.copy(
                lastVerifiedAt = System.currentTimeMillis(),
                lastState = "expired",
                lastError = humanError(e),
            )
            saveVault(updated)
            error = humanError(e)
            false
        } finally {
            verifyingId = null
        }
    }

    fun clearMessageTest() {
        messageTest = null
    }

    /**
     * Send a real chat message with exactly this account's token. Unlike
     * verifyVault (a re-POST + /users/current check), this exercises the full
     * completion path, which is what proves a login can actually chat.
     */
    fun testMessage(account: Account, prompt: String = "Reply with exactly: OK") {
        val server = active ?: return
        viewModelScope.launch {
            testingId = account.id
            error = null
            try {
                val result = client.testMessage(server, account.id, prompt)
                messageTest = MessageTest(
                    accountId = account.id,
                    shortId = account.shortId,
                    prompt = prompt,
                    reply = result.reply,
                    reasoning = result.reasoning,
                    ms = result.ms,
                )
                notice = "Message test passed on ${account.shortId}"
            } catch (e: Exception) {
                val message = humanError(e)
                messageTest = MessageTest(
                    accountId = account.id,
                    shortId = account.shortId,
                    prompt = prompt,
                    reply = "",
                    reasoning = "",
                    ms = 0,
                    error = message,
                )
                error = message
            } finally {
                testingId = null
                // The test may have marked the account expired/throttled.
                runCatching { refreshInternal(server) }
            }
        }
    }

    fun verifyAll() {
        val server = active ?: return
        val targets = vault.filter { it.serverId == server.id || it.serverId == null }
        if (targets.isEmpty()) {
            notice = "No saved logins for this bridge"
            return
        }
        viewModelScope.launch {
            var ok = 0
            targets.forEachIndexed { index, entry ->
                pushProgress = (index to targets.size)
                if (verifyVault(entry)) ok++
            }
            pushProgress = null
            notice = "$ok / ${targets.size} logins verified"
        }
    }

    suspend fun pushAll(): Pair<Int, Int> {
        val server = active ?: return 0 to 0
        var ok = 0
        val targets = vault
        targets.forEachIndexed { index, entry ->
            pushProgress = index to targets.size
            try {
                val response = client.addAccount(server, entry.token, entry.cookies, entry.userAgent, entry.label)
                val account = response.account
                if (account != null) {
                    saveVault(entry.copy(accountId = account.id, serverId = server.id, lastState = "ready", lastError = null))
                    ok++
                }
            } catch (_: Exception) {
                // leave this entry as-is; the caller reports the count
            }
        }
        pushProgress = null
        runCatching { refreshInternal(server) }
        return ok to targets.size
    }

    fun importVault(entries: List<VaultLogin>): Int {
        var added = 0
        entries.forEach { incoming ->
            if (vault.none { it.token == incoming.token }) {
                vault = vault + incoming.copy(id = UUID.randomUUID().toString())
                added++
            }
        }
        persist()
        return added
    }

    fun exportJson(): String = store.exportJson(vault)

    fun parseImport(text: String): List<VaultLogin> = store.importJson(text)

    fun seedForTesting(url: String, key: String) {
        val server = upsertServerInternal(url, key)
        activeId = server.id
        persist()
    }
}
