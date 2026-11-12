package com.backyardhero.hub.show

import android.content.Context
import com.backyardhero.hub.net.bool
import com.backyardhero.hub.net.int
import com.backyardhero.hub.net.long
import com.backyardhero.hub.net.str
import com.backyardhero.hub.proto.BscFire
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.io.File
import kotlin.math.max
import kotlin.math.roundToLong

enum class ShowType { TIMELINE, MANUAL_SEQUENCE }

enum class StepFireMode { SIMULTANEOUS, STAGGERED }

/** One step of a manual sequence. Cues keep the order they were exported in. */
data class ShowStep(
    val id: String,
    val fireMode: StepFireMode,
    val intervalMs: Int,
)

/** One cue as the receivers (or the sequence stepper) run it. */
data class ShowCue(
    /** ms from show t=0 (already `startTime - delay`, min 1). Unused by sequence steps. */
    val fireTimeMs: Long,
    /** Native receiver ident (e.g. RX12) or a 433 zone number. */
    val zone: String,
    /** 1-based cue on the receiver. */
    val target: Int,
    val name: String,
    val native: Boolean,
    /** Set on manual-sequence cues. Cues whose step is missing are not fired. */
    val stepId: String? = null,
)

data class Show(
    /** Host DB show id; sent to receivers as the 16-bit show id. */
    val id: Int,
    val name: String,
    val cues: List<ShowCue>,
    val durationSec: Double,
    val importedAt: Long,
    val type: ShowType = ShowType.TIMELINE,
    val steps: List<ShowStep> = emptyList(),
) {
    val isSequence: Boolean get() = type == ShowType.MANUAL_SEQUENCE
    val nativeCues: List<ShowCue> get() = cues.filter { it.native }
    /** 433 MHz cues. Fired live by the phone; they are not loaded into a receiver. */
    val bilusocnCues: List<ShowCue> get() = cues.filter { !it.native }
    val bilusocnZones: List<Int>
        get() = bilusocnCues.mapNotNull { it.zone.toIntOrNull() }.distinct().sorted()
    val receivers: List<String> get() = nativeCues.map { it.zone }.distinct().sorted()
    val lastCueMs: Long get() = cues.maxOfOrNull { it.fireTimeMs } ?: 0
    fun cuesFor(ident: String): List<ShowCue> = nativeCues.filter { it.zone == ident }.sortedBy { it.fireTimeMs }
    fun bilusocnCuesFor(zone: Int): List<ShowCue> =
        bilusocnCues.filter { it.zone.toIntOrNull() == zone }.sortedBy { it.fireTimeMs }

    /** Steps in export order, each with the cues that name it, in cue-list order. */
    fun groupedSteps(): List<Pair<ShowStep, List<ShowCue>>> {
        val byStep = cues.groupBy { it.stepId }
        return steps.map { step -> step to (byStep[step.id] ?: emptyList()) }
    }
}

class ShowParseException(message: String) : Exception(message)

/**
 * Accepts either the host's "Export to app" file (`format: byh-app-show`) or a
 * raw show row (`display_payload` plus optional `show_config` / `show_receivers`).
 */
object ShowParser {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    fun parse(text: String, fallbackName: String): Show {
        val root = runCatching { json.parseToJsonElement(text) }.getOrElse {
            throw ShowParseException("Not a JSON file")
        }
        val row: JsonObject? = when (root) {
            is JsonObject -> (root["show"] as? JsonObject) ?: root
            else -> null
        }
        if (row != null && (row.str("format") == "byh-app-show" || isStoredShow(row))) {
            return parseAppExport(row, fallbackName)
        }

        val payload: JsonArray = when {
            root is JsonArray -> root
            row != null -> payloadOf(row) ?: throw ShowParseException("No display_payload / cues in this file")
            else -> throw ShowParseException("Unrecognized show format")
        }
        val kinds = row?.let { receiverKinds(it) } ?: emptyMap()
        val (type, steps) = row?.let { sequenceOf(it) } ?: (ShowType.TIMELINE to emptyList())
        val cues = payload.mapNotNull { cueFromHostItem(it, kinds) }
        return finish(row, fallbackName, cues, type, steps, keepOrder = type == ShowType.MANUAL_SEQUENCE)
    }

    private fun parseAppExport(row: JsonObject, fallbackName: String): Show {
        val type = if (row.str("type") == "manual_sequence") ShowType.MANUAL_SEQUENCE else ShowType.TIMELINE
        val steps = (row["steps"] as? JsonArray)?.mapNotNull { stepFrom(it) } ?: emptyList()
        val cues = (row["cues"] as? JsonArray)?.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            val zone = o.str("zone")?.trim().orEmpty()
            val target = o.int("target") ?: return@mapNotNull null
            if (zone.isEmpty() || target < 1) return@mapNotNull null
            val native = when (o.str("kind")) {
                "bilusocn" -> false
                "native" -> true
                else -> o.bool("native") ?: (zone.toIntOrNull() == null)
            }
            ShowCue(
                fireTimeMs = max(1L, o.long("timeMs") ?: o.long("t") ?: 1L),
                zone = zone,
                target = target,
                name = o.str("name") ?: "",
                native = native,
                stepId = o.str("stepId"),
            )
        } ?: throw ShowParseException("Export has no cues")
        return finish(row, fallbackName, cues, type, steps, keepOrder = type == ShowType.MANUAL_SEQUENCE)
    }

    private fun finish(
        row: JsonObject?,
        fallbackName: String,
        cuesIn: List<ShowCue>,
        type: ShowType,
        steps: List<ShowStep>,
        keepOrder: Boolean,
    ): Show {
        val cues = if (keepOrder) cuesIn else cuesIn.sortedBy { it.fireTimeMs }
        if (cues.isEmpty()) throw ShowParseException("The show has no cues with a receiver and target")
        if (type == ShowType.MANUAL_SEQUENCE && steps.isEmpty()) {
            throw ShowParseException("This sequence has no steps")
        }
        val id = row?.int("id") ?: (fallbackName.hashCode() and 0x7FFF).coerceAtLeast(1)
        if (id !in 1..65535) throw ShowParseException("Show id $id doesn't fit the receivers' 16-bit show id")
        val tooMany = cues.filter { it.native }.groupingBy { it.zone }.eachCount().filterValues { it > 255 }
        if (tooMany.isNotEmpty()) {
            throw ShowParseException("Receivers hold at most 255 cues; too many for ${tooMany.keys.joinToString()}")
        }
        val duration = row?.let { num(it["durationSec"]) ?: num(it["duration"]) }
            ?: (cues.maxOf { it.fireTimeMs } / 1000.0)
        return Show(
            id = id,
            name = row?.str("name")?.takeIf { it.isNotBlank() } ?: fallbackName,
            cues = cues,
            durationSec = duration,
            importedAt = System.currentTimeMillis(),
            type = type,
            steps = steps,
        )
    }

    private fun cueFromHostItem(el: JsonElement, kinds: Map<String, String>): ShowCue? {
        val o = el as? JsonObject ?: return null
        val zone = (o["zone"] as? JsonPrimitive)?.content?.trim().orEmpty()
        val target = (o["target"] as? JsonPrimitive)?.content?.toDoubleOrNull()?.toInt() ?: return null
        if (zone.isEmpty() || zone == "null" || target < 1) return null
        val start = num(o["startTime"]) ?: 0.0
        val delay = num(o["delay"]) ?: 0.0
        val fireMs = max(1L, ((start - delay) * 1000.0).roundToLong())
        val native = when (kinds[zone]) {
            "native" -> true
            "bilusocn" -> false
            else -> zone.toIntOrNull() == null
        }
        return ShowCue(
            fireTimeMs = fireMs,
            zone = zone,
            target = target,
            name = o.str("name") ?: "",
            native = native,
            stepId = o.str("stepId"),
        )
    }

    /** Files this app saved before the export format: cues carry `t` / `native`, not host `startTime`. */
    private fun isStoredShow(row: JsonObject): Boolean {
        val first = (row["cues"] as? JsonArray)?.firstOrNull() as? JsonObject ?: return false
        if (first["startTime"] != null) return false
        return first["t"] != null || first["timeMs"] != null || first["native"] != null
    }

    private fun payloadOf(row: JsonObject): JsonArray? {
        val p = row["display_payload"] ?: row["cues"] ?: row["items"] ?: return null
        return when (p) {
            is JsonArray -> p
            is JsonPrimitive -> runCatching { json.parseToJsonElement(p.content).jsonArray }.getOrNull()
            else -> null
        }
    }

    private fun receiverKinds(row: JsonObject): Map<String, String> {
        val el = row["show_receivers"] ?: row["showReceivers"] ?: return emptyMap()
        val arr = asArray(el) ?: return emptyMap()
        return arr.mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            val id = (o["id"] as? JsonPrimitive)?.content ?: return@mapNotNull null
            id to (o.str("kind") ?: "native")
        }.toMap()
    }

    private fun sequenceOf(row: JsonObject): Pair<ShowType, List<ShowStep>> {
        val el = row["show_config"] ?: row["showConfig"] ?: return ShowType.TIMELINE to emptyList()
        val obj = when (el) {
            is JsonObject -> el
            is JsonPrimitive -> runCatching { json.parseToJsonElement(el.content).jsonObject }.getOrNull()
            else -> null
        } ?: return ShowType.TIMELINE to emptyList()
        val type = if (obj.str("showType") == "manual_sequence") ShowType.MANUAL_SEQUENCE else ShowType.TIMELINE
        val steps = (obj["steps"] as? JsonArray)?.mapNotNull { stepFrom(it) } ?: emptyList()
        return type to steps
    }

    private fun stepFrom(el: JsonElement): ShowStep? {
        val o = el as? JsonObject ?: return null
        val id = o.str("id") ?: return null
        val mode = if (o.str("fireMode") == "staggered") StepFireMode.STAGGERED else StepFireMode.SIMULTANEOUS
        val interval = (o.int("intervalMs") ?: 100).coerceIn(1, 60_000)
        return ShowStep(id, mode, interval)
    }

    private fun asArray(el: JsonElement): JsonArray? = when (el) {
        is JsonArray -> el
        is JsonPrimitive -> runCatching { json.parseToJsonElement(el.content).jsonArray }.getOrNull()
        else -> null
    }

    private fun num(e: JsonElement?): Double? = (e as? JsonPrimitive)?.content?.toDoubleOrNull()
}

/**
 * Point every cue aimed at [from] at [to]. [to] is an nRF ident (RX12) or a
 * Bilusocn zone number. Returns an error string, or null and the new show.
 */
fun Show.swapZone(from: String, toRaw: String): Pair<Show, String?> {
    val to = toRaw.trim()
    if (to.equals(from, ignoreCase = true)) return this to "That's already $from"
    val zoneNum = to.toIntOrNull()
    val (dest, native) = when {
        zoneNum != null && zoneNum in BscFire.ZONE_MIN..BscFire.ZONE_MAX -> zoneNum.toString() to false
        Regex("^[A-Za-z]+\\d+$").matches(to) -> to.uppercase() to true
        else -> return this to "Use a receiver ident like RX12, or a Bilusocn zone from 1 to ${BscFire.ZONE_MAX}"
    }
    if (cues.none { it.zone == from }) return this to "$from isn't in this show"
    val remapped = cues.map { cue ->
        if (cue.zone != from) cue else cue.copy(zone = dest, native = native)
    }
    val tooMany = remapped.filter { it.native }.groupingBy { it.zone }.eachCount().filterValues { it > 255 }
    if (tooMany.isNotEmpty()) return this to "${tooMany.keys.joinToString()} would have more than 255 cues"
    return copy(cues = remapped) to null
}

/** Imported shows, one JSON file each in the app's private storage. */
class ShowStore(context: Context) {
    private val dir = File(context.filesDir, "shows").apply { mkdirs() }
    private val json = Json { prettyPrint = false }

    fun list(): List<Show> = dir.listFiles { f -> f.extension == "json" }
        ?.mapNotNull { f -> runCatching { decode(f.readText()) }.getOrNull() }
        ?.sortedByDescending { it.importedAt }
        ?: emptyList()

    fun save(show: Show) {
        File(dir, "${show.id}.json").writeText(encode(show))
    }

    fun delete(show: Show) {
        File(dir, "${show.id}.json").delete()
    }

    private fun encode(s: Show): String = buildJsonObject {
        put("format", "byh-app-show")
        put("version", 1)
        put("id", s.id)
        put("name", s.name)
        put("durationSec", s.durationSec)
        put("importedAt", s.importedAt)
        put("type", if (s.isSequence) "manual_sequence" else "timeline")
        put("cues", buildJsonArray {
            for (c in s.cues) add(buildJsonObject {
                put("timeMs", c.fireTimeMs)
                put("zone", c.zone)
                put("target", c.target)
                put("name", c.name)
                put("kind", if (c.native) "native" else "bilusocn")
                if (c.stepId != null) put("stepId", c.stepId)
            })
        })
        if (s.steps.isNotEmpty()) {
            put("steps", buildJsonArray {
                for (step in s.steps) add(buildJsonObject {
                    put("id", step.id)
                    put("fireMode", if (step.fireMode == StepFireMode.STAGGERED) "staggered" else "simultaneous")
                    put("intervalMs", step.intervalMs)
                })
            })
        }
    }.toString()

    private fun decode(text: String): Show = ShowParser.parse(text, "Show").let { parsed ->
        // parse() stamps importedAt as "now". Keep the stored time.
        val o = json.parseToJsonElement(text).jsonObject
        val at = (o["importedAt"] as? JsonPrimitive)?.content?.toLongOrNull() ?: parsed.importedAt
        parsed.copy(importedAt = at)
    }
}
