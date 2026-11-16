import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Cloud builder account (Supabase project URL + publishable key). Both are
// public values; they come from local.properties (byh.cloud.supabaseUrl /
// byh.cloud.supabaseKey) or the BYH_CLOUD_SUPABASE_URL / BYH_CLOUD_SUPABASE_KEY
// environment. Left blank, the app builds without the cloud section.
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun cloudSetting(prop: String, env: String): String =
    (localProps.getProperty(prop) ?: System.getenv(env) ?: "").trim()
        .replace("\\", "").replace("\"", "")

android {
    namespace = "com.backyardhero.hub"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.backyardhero.hub"
        // 29: WifiNetworkSpecifier (app-requested join of the hub's AP).
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField(
            "String", "CLOUD_SUPABASE_URL",
            "\"${cloudSetting("byh.cloud.supabaseUrl", "BYH_CLOUD_SUPABASE_URL")}\"",
        )
        buildConfigField(
            "String", "CLOUD_SUPABASE_KEY",
            "\"${cloudSetting("byh.cloud.supabaseKey", "BYH_CLOUD_SUPABASE_KEY")}\"",
        )
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    debugImplementation("androidx.compose.ui:ui-tooling")

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.github.mik3y:usb-serial-for-android:3.10.0")
}
