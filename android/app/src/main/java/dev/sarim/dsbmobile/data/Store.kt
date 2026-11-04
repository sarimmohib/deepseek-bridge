package dev.sarim.dsbmobile.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.serialization.json.Json
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Everything sensitive (bridge API keys, DeepSeek user tokens, their cookies)
 * lives in one AES/GCM blob whose key never leaves the Android Keystore.
 * Export is the only time plaintext leaves this file, and it goes through the
 * system file picker or the share sheet.
 */
object SecureStore {
    private const val ALIAS = "dsb-mobile-state"
    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    fun seal(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val body = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        val packed = cipher.iv + body
        return Base64.encodeToString(packed, Base64.NO_WRAP)
    }

    fun open(sealed: String): String? = runCatching {
        val packed = Base64.decode(sealed, Base64.NO_WRAP)
        val iv = packed.copyOfRange(0, IV_BYTES)
        val body = packed.copyOfRange(IV_BYTES, packed.size)
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, iv))
        String(cipher.doFinal(body), Charsets.UTF_8)
    }.getOrNull()
}

class Store(context: Context) {
    private val file = File(context.applicationContext.filesDir, "dsb-state.enc")
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    fun load(): PersistedState {
        if (!file.exists()) return PersistedState()
        val sealed = runCatching { file.readText() }.getOrNull() ?: return PersistedState()
        val plain = SecureStore.open(sealed) ?: return PersistedState()
        return runCatching { json.decodeFromString(PersistedState.serializer(), plain) }
            .getOrDefault(PersistedState())
    }

    fun save(state: PersistedState) {
        runCatching {
            file.writeText(SecureStore.seal(json.encodeToString(PersistedState.serializer(), state)))
        }
    }

    fun exportJson(logins: List<VaultLogin>): String {
        val export = VaultExport(logins = logins)
        return Json { prettyPrint = true; encodeDefaults = true }
            .encodeToString(VaultExport.serializer(), export)
    }

    fun importJson(text: String): List<VaultLogin> {
        val export = Json { ignoreUnknownKeys = true }
            .decodeFromString(VaultExport.serializer(), text)
        return export.logins
    }
}
