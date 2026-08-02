plugins {
    id("com.android.application")
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
}

android {
    namespace = "com.roboaholic.anchormobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.roboaholic.anchormobile"
        minSdk = 26
        targetSdk = 36
        versionCode = providers.gradleProperty("anchorMobileVersionCode").orNull?.toInt() ?: 1
        versionName = providers.gradleProperty("anchorMobileVersionName").orNull ?: "0.1.0"
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
}
