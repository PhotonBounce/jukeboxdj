# JukeboxDJ is a thin native WebView shell — keep all of our own code so nothing
# the Android framework or a future JS bridge relies on gets stripped/renamed.
# (Our weight is the bundled web app; there is nothing of ours worth obfuscating.)
-keep class com.photonbounce.jukeboxdj.** { *; }

# Keep any methods exposed to JavaScript via @JavascriptInterface (none today,
# but this guards a future billing/native bridge from being removed by R8).
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# WebView asset loader / webkit compat.
-keep class androidx.webkit.** { *; }
-dontwarn androidx.webkit.**

# Standard: keep line numbers and hide the original source file name so stack
# traces stay mappable via the uploaded mapping.txt.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
