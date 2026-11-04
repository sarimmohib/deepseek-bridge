package dev.sarim.dsbmobile.data

import kotlinx.serialization.Serializable

@Serializable
data class Counts(
    val count: Int = 0,
    val ready: Int = 0,
    val cooling: Int = 0,
)

@Serializable
data class Upstream(
    val active: Int = 0,
    val queued: Int = 0,
    val max: Int = 0,
)

@Serializable
data class Health(
    val ok: Boolean = false,
    val version: String? = null,
    val agent: Boolean = false,
    val direct: Boolean = false,
    val mode: String? = null,
    val accounts: Counts? = null,
    val upstream: Upstream? = null,
)

@Serializable
data class AccountError(
    val code: String? = null,
    val at: Long? = null,
    val message: String? = null,
)

@Serializable
data class Account(
    val id: String = "",
    val label: String = "",
    val user: String? = null,
    val cookies: Int = 0,
    val addedAt: String? = null,
    val updatedAt: String? = null,
    val lastUsedAt: Long? = null,
    val lastSuccessAt: Long? = null,
    val cooldownUntil: Long? = null,
    val cooldownMs: Long? = 0,
    val cooling: Boolean = false,
    val state: String = "ready",
    val successCount: Int = 0,
    val failureCount: Int = 0,
    val lastError: AccountError? = null,
) {
    val shortId: String get() = id.take(8)
    val isReady: Boolean get() = !isExpired && state == "ready" && !cooling
    val isExpired: Boolean get() = lastError?.code == "not_signed_in" || state == "expired"
    val stateColor: Long get() = when {
        isExpired -> 0xFFFF6F61
        cooling -> 0xFFF5B74A
        else -> 0xFFB8F24B
    }
    val stateLabel: String get() = when {
        isExpired -> "EXPIRED"
        cooling -> "COOLING"
        else -> "READY"
    }
}

@Serializable
data class AccountsEnvelope(
    val ok: Boolean = false,
    val count: Int = 0,
    val ready: Int = 0,
    val cooling: Int = 0,
    val accounts: List<Account> = emptyList(),
)

@Serializable
data class CookieDto(
    val name: String,
    val value: String,
    val domain: String = "chat.deepseek.com",
    val path: String = "/",
    val secure: Boolean = true,
    val httpOnly: Boolean = true,
    val hostOnly: Boolean = true,
    val sameSite: String = "strict",
)

@Serializable
data class AddAccountRequest(
    val token: String,
    val cookies: List<CookieDto>? = null,
    val userAgent: String? = null,
    val label: String? = null,
)

@Serializable
data class AddAccountResponse(
    val ok: Boolean = false,
    val verified: Boolean = false,
    val warning: String? = null,
    val created: Boolean = false,
    val duplicate: Boolean = false,
    val account: Account? = null,
    val count: Int = 0,
    val ready: Int = 0,
    val cooling: Int = 0,
)

@Serializable
data class TestMessageRequest(
    val message: String,
)

@Serializable
data class TestMessageResponse(
    val ok: Boolean = false,
    val accountId: String = "",
    val reply: String = "",
    val reasoning: String = "",
    val sessionId: String? = null,
    val messageId: Long? = null,
    val ms: Long = 0,
)

@Serializable
data class DirectInfo(
    val available: Boolean = false,
    val user: String? = null,
    val accounts: Int = 0,
    val cookies: Int = 0,
)

@Serializable
data class Capabilities(
    val contextWindow: Long? = null,
    val vision: Boolean = false,
    val files: Boolean = false,
    val parallelToolCalls: Boolean = false,
)

@Serializable
data class BridgeConfigInfo(
    val port: Int = 0,
    val host: String = "127.0.0.1",
    val model: String = "",
    val systemPreset: String = "",
    val systemRules: Boolean = true,
)

@Serializable
data class BridgeStatus(
    val ok: Boolean = false,
    val version: String? = null,
    val mode: String? = null,
    val direct: DirectInfo? = null,
    val accounts: Counts? = null,
    val upstream: Upstream? = null,
    val config: BridgeConfigInfo? = null,
    val capabilities: Capabilities? = null,
)

@Serializable
data class ServerConfig(
    val id: String = "",
    val baseUrl: String,
    val apiKey: String = "",
    val label: String = "",
    val lastUsedAt: Long = 0,
) {
    val isProxy: Boolean
        get() = runCatching {
            val path = java.net.URI(baseUrl.trim()).path ?: return@runCatching false
            path.contains("bridge")
        }.getOrDefault(false)

    val hostLabel: String
        get() = runCatching { java.net.URI(baseUrl.trim()).host ?: baseUrl }.getOrDefault(baseUrl)
}

@Serializable
data class VaultLogin(
    val id: String,
    val accountId: String? = null,
    val serverId: String? = null,
    val label: String = "",
    val token: String,
    val cookies: List<CookieDto> = emptyList(),
    val userAgent: String = "",
    val addedAt: Long = 0,
    val lastVerifiedAt: Long = 0,
    val lastState: String = "unknown",
    val lastError: String? = null,
) {
    val maskedToken: String
        get() = if (token.length <= 14) token else token.take(8) + "…" + token.takeLast(4)
}

@Serializable
data class PersistedState(
    val servers: List<ServerConfig> = emptyList(),
    val activeId: String? = null,
    val vault: List<VaultLogin> = emptyList(),
)

@Serializable
data class VaultExport(
    val app: String = "dsb-mobile",
    val version: Int = 1,
    val exportedAt: Long = System.currentTimeMillis(),
    val logins: List<VaultLogin> = emptyList(),
)
