package com.backyardhero.hub.cloud

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.backyardhero.hub.BuildConfig
import com.backyardhero.hub.net.long
import com.backyardhero.hub.net.str
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.security.KeyStore
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class CloudAccount(val userId: String, val email: String)

/** One row of the account's show list. The cue payload is fetched on download. */
data class CloudShowInfo(
    /** builder_shows.id (a UUID). */
    val id: String,
    val name: String,
    val durationSec: Double,
    /** builder_shows.updated_at, verbatim. Only compared for equality. */
    val updatedAt: String,
)

/** A downloaded show row, ready for ShowParser. */
class CloudShowRow(val info: CloudShowInfo, val json: String)

class CloudException(message: String) : Exception(message)

/**
 * The cloud builder account: the same Supabase project the builder at
 * cloud.backyard-hero.com/builder saves to. The phone signs in with the
 * account's email and password and reads `builder_shows` directly; row-level
 * security limits every read to the signed-in user. Nothing here writes.
 *
 * Cloud calls go out on the phone's default network. A hub joined from inside
 * the app doesn't replace it, so they keep working on mobile data; a hub AP
 * joined from system Wi-Fi settings has no internet and they fail cleanly.
 */
class CloudClient(context: Context) {
    private val baseUrl = BuildConfig.CLOUD_SUPABASE_URL.trimEnd('/')
    private val apiKey = BuildConfig.CLOUD_SUPABASE_KEY

    /** False when the build carries no cloud project. */
    val configured: Boolean = baseUrl.startsWith("https://") && apiKey.isNotBlank()

    private val prefs = context.getSharedPreferences("cloud_account", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .build()
    private val tokenLock = Mutex()

    private val _account = MutableStateFlow(storedAccount())
    val account: StateFlow<CloudAccount?> = _account.asStateFlow()

    suspend fun signIn(email: String, password: String): CloudAccount = withContext(Dispatchers.IO) {
        requireConfigured()
        val body = buildJsonObject {
            put("email", email)
            put("password", password)
        }
        val res = call(
            Request.Builder()
                .url("$baseUrl/auth/v1/token?grant_type=password")
                .post(body.toString().toRequestBody(JSON))
        )
        if (!res.ok) {
            throw CloudException(
                if (res.code == 400 || res.code == 401) "Wrong email or password"
                else res.errorText("Sign-in failed")
            )
        }
        tokenLock.withLock { storeSession(res.obj(), fallbackEmail = email) }
            ?: throw CloudException("Sign-in failed")
    }

    /** Forgets the account on this phone. Downloaded shows stay. */
    suspend fun signOut() = withContext(Dispatchers.IO) {
        val access = tokenLock.withLock {
            val t = Vault.open(prefs.getString(KEY_ACCESS, null))
            clearSession()
            t
        }
        if (access != null && configured) {
            // Best effort: revoke this phone's session server-side.
            runCatching {
                call(
                    Request.Builder()
                        .url("$baseUrl/auth/v1/logout?scope=local")
                        .header("Authorization", "Bearer $access")
                        .post(ByteArray(0).toRequestBody(null))
                )
            }
        }
    }

    /** The account's active (not archived) shows, newest edit first. */
    suspend fun listShows(): List<CloudShowInfo> = withContext(Dispatchers.IO) {
        val (userId, token) = session()
        val query = "select=id,name,duration,updated_at&user_id=eq.$userId&order=updated_at.desc"
        fun get(extra: String) = call(
            Request.Builder()
                .url("$baseUrl/rest/v1/builder_shows?$query$extra")
                .header("Authorization", "Bearer $token")
        )
        // archived_at and show_config are later additions to builder_shows; a
        // project without them answers 42703, and the phone reads without them.
        val res = get("&archived_at=is.null").let { if (it.missingColumn) get("") else it }
        if (!res.ok) throw CloudException(res.errorText("Couldn't list cloud shows"))
        val rows = runCatching { json.parseToJsonElement(res.body) as? JsonArray }.getOrNull()
            ?: throw CloudException("Unexpected reply from the cloud")
        rows.mapNotNull { (it as? JsonObject)?.let(::infoOf) }
    }

    /** One show with the columns the phone needs to run it. */
    suspend fun fetchShow(id: String): CloudShowRow = withContext(Dispatchers.IO) {
        if (!UUID.matches(id)) throw CloudException("Bad show id")
        val (userId, token) = session()
        val columns = "id,name,duration,updated_at,display_payload,show_receivers"
        fun get(select: String) = call(
            Request.Builder()
                .url("$baseUrl/rest/v1/builder_shows?select=$select&id=eq.$id&user_id=eq.$userId")
                .header("Authorization", "Bearer $token")
                .header("Accept", "application/vnd.pgrst.object+json")
        )
        val res = get("$columns,show_config").let { if (it.missingColumn) get(columns) else it }
        if (res.code == 406) throw CloudException("That show is no longer in the cloud")
        if (!res.ok) throw CloudException(res.errorText("Couldn't download the show"))
        val info = runCatching { json.parseToJsonElement(res.body) as? JsonObject }.getOrNull()?.let(::infoOf)
            ?: throw CloudException("Unexpected reply from the cloud")
        CloudShowRow(info, res.body)
    }

    private fun infoOf(o: JsonObject): CloudShowInfo? {
        val id = o.str("id")?.takeIf { UUID.matches(it) } ?: return null
        return CloudShowInfo(
            id = id,
            name = o.str("name")?.takeIf { it.isNotBlank() } ?: "Untitled show",
            durationSec = (o["duration"] as? JsonPrimitive)?.content?.toDoubleOrNull() ?: 0.0,
            updatedAt = o.str("updated_at") ?: "",
        )
    }

    // ── Session ─────────────────────────────────────────────────────────────

    /** (user id, access token), refreshing the token when it is about to expire. */
    private suspend fun session(): Pair<String, String> = tokenLock.withLock {
        requireConfigured()
        val acct = _account.value ?: throw CloudException("Sign in to see your cloud shows")
        val access = Vault.open(prefs.getString(KEY_ACCESS, null))
        val expiresAt = prefs.getLong(KEY_EXPIRES, 0)
        if (access != null && expiresAt - 60 > System.currentTimeMillis() / 1000) {
            return@withLock acct.userId to access
        }
        val refresh = Vault.open(prefs.getString(KEY_REFRESH, null)) ?: run {
            clearSession()
            throw CloudException("Signed out. Sign in again.")
        }
        val body = buildJsonObject { put("refresh_token", refresh) }
        val res = call(
            Request.Builder()
                .url("$baseUrl/auth/v1/token?grant_type=refresh_token")
                .post(body.toString().toRequestBody(JSON))
        )
        if (res.code == 400 || res.code == 401 || res.code == 403) {
            // Revoked, or the password changed.
            clearSession()
            throw CloudException("Signed out. Sign in again.")
        }
        if (!res.ok) throw CloudException(res.errorText("Couldn't refresh the cloud session"))
        // Refresh tokens rotate: the new one must be stored before it is used again.
        val fresh = storeSession(res.obj(), fallbackEmail = acct.email)
            ?: throw CloudException("Couldn't refresh the cloud session")
        fresh.userId to (Vault.open(prefs.getString(KEY_ACCESS, null))
            ?: throw CloudException("Couldn't store the cloud session"))
    }

    private fun storeSession(o: JsonObject?, fallbackEmail: String): CloudAccount? {
        o ?: return null
        val access = o.str("access_token") ?: return null
        val refresh = o.str("refresh_token") ?: return null
        val user = o["user"] as? JsonObject
        val userId = user?.str("id")?.takeIf { UUID.matches(it) } ?: return null
        val expiresAt = o.long("expires_at")
            ?: (System.currentTimeMillis() / 1000 + (o.long("expires_in") ?: 3600))
        val acct = CloudAccount(userId, user.str("email") ?: fallbackEmail)
        prefs.edit()
            .putString(KEY_USER, acct.userId)
            .putString(KEY_EMAIL, acct.email)
            .putString(KEY_ACCESS, Vault.seal(access))
            .putString(KEY_REFRESH, Vault.seal(refresh))
            .putLong(KEY_EXPIRES, expiresAt)
            .apply()
        _account.value = acct
        return acct
    }

    private fun clearSession() {
        prefs.edit().clear().apply()
        _account.value = null
    }

    private fun storedAccount(): CloudAccount? {
        if (!configured) return null
        val userId = prefs.getString(KEY_USER, null) ?: return null
        if (prefs.getString(KEY_REFRESH, null) == null) return null
        return CloudAccount(userId, prefs.getString(KEY_EMAIL, null) ?: "")
    }

    private fun requireConfigured() {
        if (!configured) throw CloudException("This build isn't set up for the cloud builder")
    }

    // ── HTTP ────────────────────────────────────────────────────────────────

    private class Reply(val code: Int, val body: String) {
        val ok get() = code in 200..299
    }

    private fun Reply.obj(): JsonObject? =
        runCatching { json.parseToJsonElement(body) as? JsonObject }.getOrNull()

    /** Postgres 42703: the query named a column this project doesn't have. */
    private val Reply.missingColumn: Boolean get() = code == 400 && obj()?.str("code") == "42703"

    private fun Reply.errorText(fallback: String): String {
        val o = obj()
        val detail = o?.str("error_description") ?: o?.str("msg") ?: o?.str("message")
        return if (detail.isNullOrBlank()) "$fallback (HTTP $code)" else "$fallback: $detail"
    }

    private fun call(builder: Request.Builder): Reply {
        val request = builder.header("apikey", apiKey).build()
        try {
            http.newCall(request).execute().use { r ->
                return Reply(r.code, r.body?.string().orEmpty())
            }
        } catch (e: IOException) {
            throw CloudException("Can't reach the cloud. Check this phone's internet connection.")
        }
    }

    /** AES-GCM under a key that never leaves the Android Keystore. */
    private object Vault {
        private const val ALIAS = "byh_cloud_session"
        private const val TRANSFORM = "AES/GCM/NoPadding"

        private fun key(): SecretKey {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
            val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            gen.init(
                KeyGenParameterSpec.Builder(
                    ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build()
            )
            return gen.generateKey()
        }

        fun seal(text: String): String? = runCatching {
            val cipher = Cipher.getInstance(TRANSFORM).apply { init(Cipher.ENCRYPT_MODE, key()) }
            val sealed = cipher.iv + cipher.doFinal(text.toByteArray())
            Base64.encodeToString(sealed, Base64.NO_WRAP)
        }.getOrNull()

        fun open(blob: String?): String? = runCatching {
            val raw = Base64.decode(blob ?: return null, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORM).apply {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, IV_LEN))
            }
            String(cipher.doFinal(raw, IV_LEN, raw.size - IV_LEN))
        }.getOrNull()

        private const val IV_LEN = 12
    }

    private companion object {
        val JSON = "application/json".toMediaType()
        val UUID = Regex("^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
        const val KEY_USER = "user_id"
        const val KEY_EMAIL = "email"
        const val KEY_ACCESS = "access"
        const val KEY_REFRESH = "refresh"
        const val KEY_EXPIRES = "expires_at"
    }
}
