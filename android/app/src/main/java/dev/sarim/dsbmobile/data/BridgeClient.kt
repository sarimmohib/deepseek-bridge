package dev.sarim.dsbmobile.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

class BridgeException(
    message: String,
    val code: String? = null,
    val status: Int? = null,
) : Exception(message)

/**
 * Small client for the deepseek-bridge HTTP API.
 *
 * Two server shapes are supported transparently:
 *  - direct: http://host:8787        -> sends the API key
 *  - proxy:  http://host/bridge     -> the dashboard proxy injects the key
 */
class BridgeClient {
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .callTimeout(80, TimeUnit.SECONDS)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private fun base(server: ServerConfig) = server.baseUrl.trim().trimEnd('/')

    private fun request(
        server: ServerConfig,
        path: String,
        method: String,
        body: String? = null,
    ): Request {
        val builder = Request.Builder().url(base(server) + path)
        if (!server.isProxy && server.apiKey.isNotBlank()) {
            builder.header("Authorization", "Bearer ${server.apiKey.trim()}")
        }
        if (body != null) {
            builder.method(method, body.toRequestBody(jsonMedia))
        } else {
            builder.method(method, null)
        }
        return builder.build()
    }

    private inline fun <reified T> call(request: Request): T = client.newCall(request).execute().use { res ->
        val text = res.body?.string().orEmpty()
        if (!res.isSuccessful) {
            throw BridgeException(extractError(text) ?: "HTTP ${res.code}", null, res.code)
        }
        json.decodeFromString<T>(text)
    }

    private fun extractError(text: String): String? = runCatching {
        val root = json.parseToJsonElement(text).jsonObject
        when (val error = root["error"]) {
            is JsonPrimitive -> error.content
            is JsonObject -> (error["message"] as? JsonPrimitive)?.content
            else -> null
        }
    }.getOrNull()

    suspend fun health(server: ServerConfig): Health = withContext(Dispatchers.IO) {
        call(request(server, "/health", "GET"))
    }

    suspend fun status(server: ServerConfig): BridgeStatus = withContext(Dispatchers.IO) {
        call(request(server, "/v1/bridge/status", "GET"))
    }

    suspend fun accounts(server: ServerConfig): AccountsEnvelope = withContext(Dispatchers.IO) {
        call(request(server, "/v1/bridge/accounts", "GET"))
    }

    suspend fun addAccount(
        server: ServerConfig,
        token: String,
        cookies: List<CookieDto>,
        userAgent: String,
        label: String?,
    ): AddAccountResponse = withContext(Dispatchers.IO) {
        val payload = AddAccountRequest(
            token = token,
            cookies = cookies.ifEmpty { null },
            userAgent = userAgent.ifBlank { null },
            label = label?.takeIf { it.isNotBlank() },
        )
        val body = json.encodeToString(AddAccountRequest.serializer(), payload)
        call(request(server, "/v1/bridge/accounts", "POST", body))
    }

    suspend fun deleteAccount(server: ServerConfig, id: String): Unit = withContext(Dispatchers.IO) {
        val encoded = java.net.URLEncoder.encode(id, "UTF-8")
        client.newCall(request(server, "/v1/bridge/accounts/$encoded", "DELETE")).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful) {
                throw BridgeException(extractError(text) ?: "HTTP ${res.code}", null, res.code)
            }
        }
    }

    /**
     * Ask the bridge to send a real chat message with EXACTLY this account's
     * token. A token can pass /users/current verification yet still be unable
     * to chat, so this is the only honest "does this login work" test.
     */
    suspend fun testMessage(server: ServerConfig, id: String, message: String): TestMessageResponse =
        withContext(Dispatchers.IO) {
            val encoded = java.net.URLEncoder.encode(id, "UTF-8")
            val body = json.encodeToString(TestMessageRequest.serializer(), TestMessageRequest(message))
            // A completion can legitimately take a minute; give this call its
            // own generous ceiling instead of the short default.
            val slow = client.newBuilder()
                .readTimeout(120, TimeUnit.SECONDS)
                .callTimeout(130, TimeUnit.SECONDS)
                .build()
            slow.newCall(request(server, "/v1/bridge/accounts/$encoded/test-message", "POST", body))
                .execute().use { res ->
                    val text = res.body?.string().orEmpty()
                    if (!res.isSuccessful) {
                        throw BridgeException(extractError(text) ?: "HTTP ${res.code}", null, res.code)
                    }
                    json.decodeFromString<TestMessageResponse>(text)
                }
        }

    fun dashboardUrl(server: ServerConfig): String {
        val b = base(server)
        return if (server.isProxy) b else "$b/"
    }
}
