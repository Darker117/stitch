package com.stitch.mobile.device

import java.util.Locale

/** What we know about the phone's chip. Pure JVM so it can be unit tested. */
data class SocInfo(
    /** Normalised SoC model, e.g. "SM8650" or "Tensor G3". */
    val model: String?,
    val manufacturer: String?,
    /** Friendly name, e.g. "Snapdragon 8 Gen 3". */
    val name: String?,
    /** Hexagon HTP architecture, e.g. "v75" (Snapdragon only, when known). */
    val htpArch: String?,
    val qualcomm: Boolean,
    val googleTensor: Boolean,
) {
    val htpVersion: Int? get() = htpArch?.removePrefix("v")?.toIntOrNull()
}

object SocTable {
    /**
     * Snapdragon SoC → (marketing name, Hexagon HTP arch). The flagship rows match Google's LiteRT NPU runtime
     * device groups (SM8450→v69 … SM8850→v81) and Qualcomm's QNN "supported Snapdragon devices" table. Chips whose
     * HTP generation we are not sure about keep a name but no arch (the NPU is then reported as unverified).
     */
    val SNAPDRAGON: Map<String, Pair<String, String?>> = linkedMapOf(
        "SM8850" to ("Snapdragon 8 Elite Gen 5" to "v81"),
        "SM8750" to ("Snapdragon 8 Elite" to "v79"),
        "SM8735" to ("Snapdragon 8s Gen 4" to null),
        "SM8650" to ("Snapdragon 8 Gen 3" to "v75"),
        "SM8635" to ("Snapdragon 8s Gen 3" to "v73"),
        "SM8550" to ("Snapdragon 8 Gen 2" to "v73"),
        "SM8475" to ("Snapdragon 8+ Gen 1" to "v69"),
        "SM8450" to ("Snapdragon 8 Gen 1" to "v69"),
        "SM8350" to ("Snapdragon 888" to "v68"),
        "SM8250" to ("Snapdragon 865" to null),
        "SM8150" to ("Snapdragon 855" to null),
        "SM7675" to ("Snapdragon 7+ Gen 3" to "v73"),
        "SM7550" to ("Snapdragon 7 Gen 3" to "v73"),
        "SM7635" to ("Snapdragon 7s Gen 3" to null),
        "SM7475" to ("Snapdragon 7+ Gen 2" to "v69"),
        "SM7450" to ("Snapdragon 7 Gen 1" to "v69"),
        "SM7435" to ("Snapdragon 7s Gen 2" to null),
        "SM7325" to ("Snapdragon 778G" to "v68"),
        "SM6450" to ("Snapdragon 6 Gen 1" to null),
        "SM6375" to ("Snapdragon 695" to null),
    )

    /** Qualcomm board codenames (ro.board.platform / Build.BOARD) for phones without Build.SOC_MODEL (API < 31). */
    val BOARD_CODENAMES: Map<String, String> = mapOf(
        "lahaina" to "SM8350",
        "yupik" to "SM7325",
        "taro" to "SM8450",
        "cape" to "SM8475",
        "kalama" to "SM8550",
        "pineapple" to "SM8650",
        "cliffs" to "SM8635",
        "sun" to "SM8750",
        "canoe" to "SM8850",
        "crow" to "SM7550",
        "ukee" to "SM7475",
        "kona" to "SM8250",
        "msmnile" to "SM8150",
    )

    private val SM_REGEX = Regex("\\bSM\\d{4}\\b", RegexOption.IGNORE_CASE)

    /**
     * @param socModel Build.SOC_MODEL (API 31+), may be null/"unknown".
     * @param socManufacturer Build.SOC_MANUFACTURER (API 31+).
     * @param board Build.BOARD / platform codename.
     * @param hardware Build.HARDWARE.
     * @param cpuinfoHardware the "Hardware" line of /proc/cpuinfo, if any.
     */
    fun resolve(
        socModel: String?,
        socManufacturer: String?,
        board: String?,
        hardware: String?,
        cpuinfoHardware: String?,
    ): SocInfo {
        val model = socModel?.trim()?.takeUnless { it.isEmpty() || it.equals("unknown", true) }
        val maker = socManufacturer?.trim()?.takeUnless { it.isEmpty() || it.equals("unknown", true) }

        // Snapdragon SM number from any source.
        val sm = listOfNotNull(model, cpuinfoHardware).firstNotNullOfOrNull { SM_REGEX.find(it)?.value?.uppercase(Locale.US) }
            ?: listOfNotNull(board, hardware).firstNotNullOfOrNull { BOARD_CODENAMES[it.lowercase(Locale.US)] }

        val qualcomm = sm != null ||
            maker?.contains("qti", true) == true || maker?.contains("qualcomm", true) == true ||
            cpuinfoHardware?.contains("qualcomm", true) == true || hardware?.equals("qcom", true) == true
        val tensor = !qualcomm && (
            model?.startsWith("Tensor", true) == true ||
                (maker?.equals("google", true) == true && model != null)
            )

        if (sm != null) {
            val entry = SNAPDRAGON[sm]
            return SocInfo(sm, maker ?: "Qualcomm", entry?.first ?: "Snapdragon ($sm)", entry?.second, true, false)
        }
        if (tensor) {
            val name = model?.let { if (it.startsWith("Tensor", true)) "Google $it" else it }
            return SocInfo(model, maker ?: "Google", name, null, false, true)
        }
        return SocInfo(model, maker, model?.let { m -> maker?.let { "$it $m" } ?: m }, null, qualcomm, false)
    }

    /** "Adreno (TM) 750" → "Adreno 750"; "Mali-G715" stays. */
    fun friendlyGpu(renderer: String?): String? {
        if (renderer.isNullOrBlank()) return null
        return renderer.replace("(TM)", "").replace("(tm)", "").replace(Regex("\\s+"), " ").trim()
    }
}
