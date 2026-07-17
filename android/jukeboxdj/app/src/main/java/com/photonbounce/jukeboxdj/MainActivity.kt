package com.photonbounce.jukeboxdj

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader

/**
 * JukeboxDJ — a thin native shell around the same web app that runs at
 * photon-bounce.com/jukeboxdj. The whole console (assets/www) is bundled in
 * the APK, so both turntables spin and scratch entirely offline.
 *
 * The bundled assets are served through a WebViewAssetLoader over the virtual
 * origin https://appassets.androidplatform.net/ instead of a raw file:// URL.
 * This matters twice here: (1) file:// pages get a "null" origin so the WebView
 * blocks fetch() of local files, and (2) the vinyl engine is an AudioWorklet
 * module — audioWorklet.addModule() needs a real (secure) origin to load.
 * Served over the virtual https origin, both behave exactly like the website.
 *
 * The UA is tagged "JukeboxDJApp": the web app's Pro layer detects it and
 * includes Pro for free in the app — Google Play requires in-app digital goods
 * to go through Play Billing, so the web crypto unlock must never appear here.
 * With Pro simply included, nothing is sold in-app at all.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Edge-to-edge behind the system bars for the full-bleed booth look.
        window.decorView.systemUiVisibility =
            (View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN)

        // Map https://appassets.androidplatform.net/assets/** → src/main/assets/**
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this)
        setContentView(webView)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // The decks must be able to make sound the moment a record drops —
            // no gesture gate between the DJ's hand and the platter.
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            // Pin text scaling to 100%: Android otherwise multiplies CSS px by the
            // phone's font-size setting, which blows the dense console layout apart.
            textZoom = 100
            // Tag the WebView so the web app knows it's the Android build
            // (Pro included, crypto UI hidden — see jukebox-pro.js).
            userAgentString = "$userAgentString JukeboxDJApp"
            // Everything is served via the asset loader over the virtual https
            // origin — no raw file access needed.
            allowFileAccess = false
            allowContentAccess = false
        }

        // Straight into the decks — the marketing landing stays on the web.
        webView.loadUrl("https://appassets.androidplatform.net/assets/www/app.html")
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
