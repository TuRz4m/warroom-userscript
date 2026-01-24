// ==UserScript==
// @name         TuRzAm WarRoom Connector (TornPDA)
// @description  Warroom connector script for TornPDA users. Connects to WarRoomHub via PDA's HTTP API.
// @author       TuRzAm
// @namespace    https://torn.zzcraft.net/
// @version      1.1.2
// @match        https://www.torn.com/*
// @grant        none
// ==/UserScript==

;(async function () {
  'use strict'

  /**********************
   * CONSTANTS
   **********************/
  const API_BASE = 'https://api.torn.zzcraft.net'
  const HUB_URL = 'https://api.torn.zzcraft.net/warroomhub'
  const TOKEN_STORAGE_KEY = 'wr_jwt_token'
  const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000 // 5 minutes

  // Detect TornPDA environment
  const IS_TORN_PDA = typeof window.flutter_inappwebview !== 'undefined'

  /**
   * @type {string}
   * @readonly
   * The current PDA API key. Do not modify this unless you're not using PDA.
   */
  const API_KEY = "###PDA-APIKEY###"

  /**********************
   * SETTINGS MANAGEMENT
   **********************/
  const DEFAULT_SETTINGS = {
    toastPosition: 'bottom-left',
    autoHideFullAttacks: true,
    attackFeedEnabled: true
  }

  function getSettings() {
    try {
      const stored = localStorage.getItem('wr_pda_settings')
      return stored ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } : DEFAULT_SETTINGS
    } catch {
      return DEFAULT_SETTINGS
    }
  }

  function saveSettings(settings) {
    try {
      localStorage.setItem('wr_pda_settings', JSON.stringify(settings))
      return true
    } catch {
      return false
    }
  }

  let SETTINGS = getSettings()

  /**********************
   * GLOBAL STATE
   **********************/
  let jwt = null
  let currentUsername = null
  let connection = null
  let warRoomIds = []

  /**********************
   * UTILITY FUNCTIONS
   **********************/

  // HTML sanitization to prevent XSS
  function escapeHtml(str) {
    if (str == null) return ''
    const div = document.createElement('div')
    div.textContent = String(str)
    return div.innerHTML
  }

  // Parse JWT claims without throwing
  function parseJwtClaims(token) {
    try {
      return JSON.parse(atob(token.split('.')[1]))
    } catch {
      return null
    }
  }

  // Extract user-friendly error message from Error object
  function extractErrorMessage(error) {
    return error.message.replace(/^HTTP \d+:\s*/, '')
  }

  // Debug logging
  function log(category, message, data) {
    if (data !== undefined) {
      // Use JSON.stringify for objects to see their contents
      if (typeof data === 'object' && data !== null) {
        try {
          console.log(`[WarRoom:${category}]`, message, JSON.stringify(data, null, 2))
        } catch (e) {
          console.log(`[WarRoom:${category}]`, message, data)
        }
      } else {
        console.log(`[WarRoom:${category}]`, message, data)
      }
    } else {
      console.log(`[WarRoom:${category}]`, message)
    }
  }

  /**********************
   * CACHE MANAGEMENT
   **********************/
  const TARGET_CACHE_KEY = 'wr_pda_target_cache'
  const TARGET_CACHE_TTL = 60 * 60 * 1000 // 1 hour

  function clearTargetCache() {
    try {
      localStorage.removeItem(TARGET_CACHE_KEY)
      return true
    } catch {
      return false
    }
  }

  function getCachedTargets() {
    try {
      const cached = localStorage.getItem(TARGET_CACHE_KEY)
      if (!cached) return null
      
      const data = JSON.parse(cached)
      if (Date.now() - data.timestamp > TARGET_CACHE_TTL) {
        localStorage.removeItem(TARGET_CACHE_KEY)
        return null
      }
      
      return data.targets
    } catch {
      return null
    }
  }

  function setCachedTargets(targets) {
    try {
      localStorage.setItem(TARGET_CACHE_KEY, JSON.stringify({
        targets,
        timestamp: Date.now()
      }))
    } catch {
      // Ignore cache errors
    }
  }

  /**********************
   * STORAGE LAYER
   **********************/

  function getStoredToken() {
    try {
      const token = localStorage.getItem(TOKEN_STORAGE_KEY)
      if (token && !isTokenExpired(token)) {
        return token
      }
      clearStoredToken()
    } catch (e) {
      // Ignore storage errors
    }
    return null
  }

  function storeToken(token) {
    try {
      localStorage.setItem(TOKEN_STORAGE_KEY, token)
      return true
    } catch (e) {
      return false
    }
  }

  function clearStoredToken() {
    try {
      localStorage.removeItem(TOKEN_STORAGE_KEY)
    } catch (e) {
      // Ignore storage errors
    }
  }

  function isTokenExpired(token) {
    const claims = parseJwtClaims(token)
    if (!claims || !claims.exp) return true
    const expiryMs = claims.exp * 1000
    return Date.now() > expiryMs - TOKEN_EXPIRY_BUFFER_MS
  }

  /**********************
   * HTTP LAYER - PDA WRAPPER
   **********************/

  async function pdaFetch(method, url, headers = {}, body = null) {
    try {
      let res
      if (method === 'GET') {
        res = await window.flutter_inappwebview.callHandler('PDA_httpGet', url, headers)
      } else if (method === 'POST') {
        res = await window.flutter_inappwebview.callHandler('PDA_httpPost', url, headers, body)
      } else if (method === 'DELETE') {
        // PDA doesn't support DELETE - skip silently for connection cleanup
        return { status: 200, responseText: '' }
      } else {
        throw new Error(`Unsupported method: ${method}`)
      }

      // Check status
      if (res.status >= 200 && res.status < 300) {
        return res
      } else {
        // Extract error message from response
        let errorMsg = res.statusText || `HTTP ${res.status}`
        try {
          if (res.responseText) {
            const errorData = JSON.parse(res.responseText)
            errorMsg = errorData.message || errorData.error || errorData.title || errorMsg
          }
        } catch {
          // Use statusText
        }
        throw new Error(`HTTP ${res.status}: ${errorMsg}`)
      }
    } catch (err) {
      // Wrap non-HTTP errors
      if (err.message?.startsWith('HTTP ')) {
        throw err
      }
      throw new Error('Network error: ' + (err.message || err))
    }
  }

  /**********************
   * AUTHENTICATION FLOW
   **********************/

  async function login() {
    const res = await pdaFetch(
      'POST',
      `${API_BASE}/auth/login`,
      { 'Content-Type': 'application/json' },
      JSON.stringify({ apikey: API_KEY })
    )

    const json = JSON.parse(res.responseText)
    return json.token
  }

  function updateCurrentUserFromJwt(token) {
    const claims = parseJwtClaims(token)
    if (!claims) return false

    currentUsername = claims['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name']
    return !!currentUsername
  }

  async function ensureAuthenticated() {
    // Check cached token
    if (jwt && !isTokenExpired(jwt)) {
      if (updateCurrentUserFromJwt(jwt)) {
        return true
      }
    }

    // Load from storage
    if (!jwt) {
      jwt = getStoredToken()
      if (jwt && !isTokenExpired(jwt)) {
        if (updateCurrentUserFromJwt(jwt)) {
          return true
        }
      }
    }

    // Need to login
    try {
      jwt = await login()
      storeToken(jwt)
      if (updateCurrentUserFromJwt(jwt)) {
        return true
      }
    } catch (e) {
      log('Auth', 'Authentication failed', e.message)
      jwt = null
      currentUsername = null
      clearStoredToken()

      // Show error toast
      toast('Failed to authenticate: ' + extractErrorMessage(e), 'error')
    }

    return false
  }

  /**********************
   * SIGNALR LONG-POLLING CLIENT
   **********************/

  class SignalRLongPollingConnection {
    constructor(hubUrl, accessToken) {
      this.hubUrl = hubUrl
      this.accessToken = accessToken
      this.connectionId = null
      this.connectionToken = null
      this.running = false
      this.handlers = new Map()
      this.invocationId = 0
      this.pendingCalls = new Map()
      this.reconnectAttempts = 0
      this.maxReconnectAttempts = 5
      this.reconnectDelay = 1000
    }

    async start() {
      try {
        // NEGOTIATE
        const negotiateRes = await pdaFetch(
          'POST',
          `${this.hubUrl}/negotiate?negotiateVersion=1`,
          {
            'Content-Type': 'text/plain;charset=UTF-8',
            Authorization: `Bearer ${this.accessToken}`,
          }
        )

        const negotiateData = JSON.parse(negotiateRes.responseText)
        this.connectionId = negotiateData.connectionId
        this.connectionToken = negotiateData.connectionToken || this.connectionId

        // HANDSHAKE
        const handshakePayload = JSON.stringify({ protocol: 'json', version: 1 }) + '\x1e'
        await pdaFetch(
          'POST',
          `${this.hubUrl}?id=${encodeURIComponent(this.connectionToken)}`,
          {
            'Content-Type': 'text/plain;charset=UTF-8',
            Authorization: `Bearer ${this.accessToken}`,
          },
          handshakePayload
        )

        // Check handshake response
        const handshakeResponse = await this.poll()
        if (handshakeResponse) {
          const messages = handshakeResponse.split('\x1e').filter((m) => m)
          for (const msgStr of messages) {
            const msg = JSON.parse(msgStr)
            if (msg.error) {
              throw new Error('Handshake failed: ' + msg.error)
            }
          }
        }

        this.running = true
        this.reconnectAttempts = 0

        // Start poll loop in background
        this.pollLoop()

        return true
      } catch (e) {
        log('SignalR', 'Connection failed', e.message)
        throw e
      }
    }

    async reconnect() {
      // Stop the current connection without resetting maxReconnectAttempts
      this.running = false

      // Wait a bit for any pending requests to complete
      await new Promise(resolve => setTimeout(resolve, 500))

      // Clear old connection state but keep handlers
      this.connectionId = null
      this.connectionToken = null
      this.pendingCalls.clear()

      // NEGOTIATE
      const negotiateRes = await pdaFetch(
        'POST',
        `${this.hubUrl}/negotiate?negotiateVersion=1`,
        {
          'Content-Type': 'text/plain;charset=UTF-8',
          Authorization: `Bearer ${this.accessToken}`,
        }
      )

      const negotiateData = JSON.parse(negotiateRes.responseText)
      this.connectionId = negotiateData.connectionId
      this.connectionToken = negotiateData.connectionToken || this.connectionId

      // HANDSHAKE
      const handshakePayload = JSON.stringify({ protocol: 'json', version: 1 }) + '\x1e'
      await pdaFetch(
        'POST',
        `${this.hubUrl}?id=${encodeURIComponent(this.connectionToken)}`,
        {
          'Content-Type': 'text/plain;charset=UTF-8',
          Authorization: `Bearer ${this.accessToken}`,
        },
        handshakePayload
      )

      // Check handshake response
      const handshakeResponse = await this.poll()
      if (handshakeResponse) {
        const messages = handshakeResponse.split('\x1e').filter((m) => m)
        for (const msgStr of messages) {
          const msg = JSON.parse(msgStr)
          if (msg.error) {
            throw new Error('Handshake failed: ' + msg.error)
          }
        }
      }

      this.running = true
      return true
    }

    async poll() {
      const res = await pdaFetch(
        'GET',
        `${this.hubUrl}?id=${encodeURIComponent(this.connectionToken)}`,
        {
          Authorization: `Bearer ${this.accessToken}`,
        }
      )
      return res.responseText
    }

    async pollLoop() {
      while (this.running) {
        try {
          const data = await this.poll()
          if (data) {
            this.handleMessages(data)
          }
          // Reset reconnect attempts on successful poll
          this.reconnectAttempts = 0
        } catch (e) {
          // Check if this is a 404 or connection error that requires reconnect
          if (e.message.includes('HTTP 404') || e.message.includes('Network error')) {
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
              this.reconnectAttempts++
              const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000)

              await new Promise(resolve => setTimeout(resolve, delay))

              if (this.running !== false) {  // Only reconnect if not explicitly stopped
                try {
                  // Re-negotiate and reconnect
                  await this.reconnect()

                  // Re-setup connection (display name, war rooms, attacks)
                  await setupConnection()

                  // Show reconnection notification
                  toast('WarRoom Reconnected - Connection restored', 'success')

                  continue
                } catch (reconnectError) {
                  log('SignalR', 'Reconnection failed', reconnectError.message)
                }
              }
            } else {
              log('SignalR', 'Max reconnect attempts reached')
              this.stop()
              toast('Connection lost. Please reload the page.', 'error')
              return
            }
          }

          if (this.running) {
            await new Promise(resolve => setTimeout(resolve, 2000))
          } else {
            return
          }
        }
      }
    }

    handleMessages(data) {
      const messages = data.split('\x1e').filter((m) => m)

      for (const msgStr of messages) {
        try {
          const msg = JSON.parse(msgStr)

          if (Object.keys(msg).length === 0 || msg.type === undefined) {
            continue
          }

          switch (msg.type) {
            case 1:
              this.handleInvocation(msg)
              break
            case 3:
              this.handleCompletion(msg)
              break
            case 6:
              // Ping
              break
            case 7:
              log('SignalR', 'Connection closed by server', msg.error)
              this.stop()
              break
          }
        } catch (e) {
          log('SignalR', 'Message parse error', e.message)
        }
      }
    }

    handleInvocation(msg) {
      const { target, arguments: args } = msg

      const handlers = this.handlers.get(target.toLowerCase())
      if (handlers) {
        handlers.forEach((handler) => {
          try {
            handler(...(args || []))
          } catch (e) {
            log('SignalR', `Handler error for '${target}'`, {
              error: e.message || String(e),
              stack: e.stack,
              args: args
            })
          }
        })
      }
    }

    handleCompletion(msg) {
      const pending = this.pendingCalls.get(msg.invocationId)
      if (pending) {
        if (msg.error) {
          pending.reject(new Error(msg.error))
        } else {
          pending.resolve(msg.result)
        }
        this.pendingCalls.delete(msg.invocationId)
      }
    }

    on(methodName, handler) {
      const key = methodName.toLowerCase()
      if (!this.handlers.has(key)) {
        this.handlers.set(key, [])
      }
      this.handlers.get(key).push(handler)
      return this
    }

    async invoke(methodName, ...args) {
      if (!this.running) {
        throw new Error('Connection not open')
      }

      const invocationId = String(++this.invocationId)
      const msg = {
        type: 1,
        invocationId,
        target: methodName,
        arguments: args,
      }

      const payload = JSON.stringify(msg) + '\x1e'

      return new Promise(async (resolve, reject) => {
        const timeoutId = setTimeout(() => {
          if (this.pendingCalls.has(invocationId)) {
            this.pendingCalls.delete(invocationId)
            reject(new Error(`Invoke timeout for ${methodName}`))
          }
        }, 30000)

        this.pendingCalls.set(invocationId, {
          resolve: (result) => {
            clearTimeout(timeoutId)
            resolve(result)
          },
          reject: (error) => {
            clearTimeout(timeoutId)
            reject(error)
          }
        })

        try {
          await pdaFetch(
            'POST',
            `${this.hubUrl}?id=${encodeURIComponent(this.connectionToken)}`,
            {
              'Content-Type': 'text/plain;charset=UTF-8',
              Authorization: `Bearer ${this.accessToken}`,
            },
            payload
          )
        } catch (e) {
          clearTimeout(timeoutId)
          this.pendingCalls.delete(invocationId)
          reject(e)
        }
      })
    }

    async send(methodName, ...args) {
      if (!this.running) {
        return
      }

      const msg = {
        type: 1,
        target: methodName,
        arguments: args,
      }

      const payload = JSON.stringify(msg) + '\x1e'

      try {
        await pdaFetch(
          'POST',
          `${this.hubUrl}?id=${encodeURIComponent(this.connectionToken)}`,
          {
            'Content-Type': 'text/plain;charset=UTF-8',
            Authorization: `Bearer ${this.accessToken}`,
          },
          payload
        )
      } catch (e) {
        log('SignalR', 'Send error', e.message)
      }
    }

    stop() {
      this.running = false
      this.maxReconnectAttempts = 0
      // Skip DELETE - not supported by PDA
    }
  }

  /**********************
   * MOBILE-FRIENDLY TOAST UI
   **********************/

  // Inject mobile-optimized styles
  const style = document.createElement('style')
  style.textContent = `
    .wr-toast-container {
      position: fixed;
      display: flex;
      gap: 10px;
      z-index: 99999;
      max-width: calc(100vw - 20px);
      pointer-events: none;
    }

    .wr-toast-container.bottom-left {
      left: 10px;
      bottom: 40px;
      flex-direction: column-reverse;
    }

    .wr-toast-container.bottom-right {
      right: 10px;
      bottom: 40px;
      flex-direction: column-reverse;
    }

    .wr-toast-container.top-left {
      left: 10px;
      top: 40px;
      flex-direction: column;
    }

    .wr-toast-container.top-right {
      right: 10px;
      top: 40px;
      flex-direction: column;
    }

    .wr-toast {
      background: rgba(30, 30, 50, 0.98);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(155, 89, 182, 0.3);
      border-radius: 12px;
      padding: 12px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #fff;
      animation: wr-slidein 0.3s ease;
      min-width: 280px;
      max-width: 100%;
      pointer-events: auto;
    }

    .wr-toast.wr-closing {
      animation: wr-slideout 0.3s ease forwards;
    }

    @keyframes wr-slidein {
      from { opacity: 0; transform: translateX(-20px); }
      to { opacity: 1; transform: translateX(0); }
    }

    @keyframes wr-slideout {
      from { opacity: 1; transform: translateX(0); }
      to { opacity: 0; transform: translateX(-20px); }
    }

    .wr-toast.wr-attack { border-top: 3px solid #9b59b6; }
    .wr-toast.wr-success { border-top: 3px solid #2ecc71; }
    .wr-toast.wr-error { border-top: 3px solid #e74c3c; }
    .wr-toast.wr-info { border-top: 3px solid #3498db; }

    .wr-toast-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }

    .wr-toast-title {
      font-size: 14px;
      font-weight: 600;
      color: #fff;
    }

    .wr-toast-close {
      background: rgba(255, 255, 255, 0.1);
      border: none;
      color: #888;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 18px;
      line-height: 1;
      transition: all 0.2s;
      min-width: 32px;
      min-height: 32px;
    }

    .wr-toast-close:active {
      background: rgba(255, 255, 255, 0.2);
      color: #fff;
    }

    .wr-toast-message {
      color: #aaa;
      font-size: 13px;
      line-height: 1.4;
    }

    .wr-attack-card {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .wr-attack-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }

    .wr-target-section {
      display: flex;
      align-items: baseline;
      gap: 6px;
      min-width: 0;
      flex: 1;
    }

    .wr-target-name {
      color: #fff;
      font-size: 16px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .wr-target-id {
      color: #666;
      font-size: 12px;
      flex-shrink: 0;
    }

    .wr-status-badge {
      font-size: 10px;
      font-weight: 600;
      padding: 4px 8px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      flex-shrink: 0;
    }

    .wr-status-badge.active {
      background: rgba(46, 204, 113, 0.2);
      color: #2ecc71;
    }

    .wr-status-badge.full {
      background: rgba(243, 156, 18, 0.2);
      color: #f39c12;
    }

    .wr-attack-middle {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }

    .wr-timer-section {
      display: flex;
      align-items: center;
      gap: 6px;
      color: #ccc;
    }

    .wr-timer-icon {
      opacity: 0.7;
      flex-shrink: 0;
    }

    .wr-timer-value {
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 18px;
      font-weight: 700;
      color: #fff;
    }

    .wr-timer-section.urgent {
      color: #e74c3c;
    }

    .wr-timer-section.urgent .wr-timer-value {
      color: #e74c3c;
      animation: wr-pulse 1s infinite;
    }

    @keyframes wr-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .wr-slots-section {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
    }

    .wr-slots-value {
      font-size: 16px;
      font-weight: 600;
    }

    .wr-slots-value .filled { color: #2ecc71; }
    .wr-slots-value .separator { color: #555; margin: 0 2px; }
    .wr-slots-value .total { color: #888; }

    .wr-slots-label {
      color: #666;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .wr-participants {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .wr-participant {
      background: rgba(155, 89, 182, 0.15);
      color: #b388d9;
      font-size: 12px;
      padding: 4px 8px;
      border-radius: 4px;
      white-space: nowrap;
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .wr-actions {
      display: flex;
      gap: 8px;
      margin-top: 4px;
    }

    .wr-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      background: rgba(255, 255, 255, 0.05);
      color: #aaa;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: all 0.2s ease;
      flex: 1;
      min-height: 44px;
    }

    .wr-btn:active {
      background: rgba(255, 255, 255, 0.15);
      transform: scale(0.95);
    }

    .wr-btn-join {
      background: rgba(46, 204, 113, 0.15);
      border-color: rgba(46, 204, 113, 0.3);
      color: #2ecc71;
    }

    .wr-btn-join:active {
      background: rgba(46, 204, 113, 0.25);
    }

    .wr-btn-attack {
      background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%);
      border-color: #e74c3c;
      color: #fff;
    }

    .wr-btn-attack:active {
      background: linear-gradient(135deg, #c0392b 0%, #a93226 100%);
    }

    .wr-created-info {
      display: flex;
      justify-content: flex-end;
      color: #666;
      font-size: 11px;
      margin-top: 4px;
    }

    /* Button base styles */
    .wr-settings-btn,
    .wr-feed-toggle-btn {
      position: absolute;
      width: 32px;
      height: 32px;
      top: 2px;
      border-radius: 50%;
      background: rgba(30, 30, 50, 0.9);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      z-index: 1000001;
    }

    /* Settings button */
    .wr-settings-btn {
      left: 160px;
      top: 2px;
      border: 1px solid rgba(155, 89, 182, 0.4);
      color: #9b59b6;
    }

    .wr-settings-btn:active {
      background: rgba(155, 89, 182, 0.2);
      border-color: #9b59b6;
      transform: scale(0.95);
    }

    /* Feed toggle button */
    .wr-feed-toggle-btn {
      left: 120px;
      top: 2px;
      border: 1px solid rgba(155, 89, 182, 0.4);
      color: #9b59b6;
    }

    .wr-feed-toggle-btn:active {
      background: rgba(155, 89, 182, 0.2);
      border-color: #9b59b6;
      transform: scale(0.95);
    }

    .wr-feed-toggle-btn.disabled {
      background: rgba(30, 30, 50, 0.9);
      border-color: rgba(231, 76, 60, 0.4);
      color: #e74c3c;
    }

    .wr-feed-toggle-btn.disabled:active {
      background: rgba(231, 76, 60, 0.2);
      border-color: #e74c3c;
    }

    /* Coordinated attack request button */
    .wr-attack-btn {
      position: absolute;
      left: 200px;
      top: 2px;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: rgba(30, 30, 50, 0.9);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000001;
      transition: all 0.2s ease;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(46, 204, 113, 0.4);
      color: #2ecc71;
    }

    .wr-attack-btn:active {
      background: rgba(46, 204, 113, 0.2);
      border-color: #2ecc71;
      transform: scale(0.95);
    }

    /* Settings modal */
    .wr-modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(5px);
      z-index: 100000;
      display: flex;
      align-items: center;
      justify-content: center;
      animation: wr-fadein 0.2s ease;
    }

    @keyframes wr-fadein {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .wr-modal {
      background: rgba(30, 30, 50, 0.98);
      border: 1px solid rgba(155, 89, 182, 0.4);
      border-radius: 1rem;
      padding: 1.5rem;
      width: 90%;
      max-width: 500px;
      max-height: 80vh;
      overflow-y: auto;
      overflow-x: hidden;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
      animation: wr-slideup 0.3s ease;
    }

    @keyframes wr-slideup {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .wr-modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.5rem;
    }

    .wr-modal-title {
      font-size: 1.5rem;
      font-weight: 600;
      color: #fff;
      line-height: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      margin: 0 !important;
    }

    .wr-modal-close {
      background: rgba(255, 255, 255, 0.1);
      border: none;
      color: #888;
      cursor: pointer;
      padding: 0;
      border-radius: 0.5rem;
      font-size: 1.5rem;
      line-height: 1;
      transition: all 0.2s;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      min-width: 44px;
      min-height: 44px;
    }

    .wr-modal-close:active {
      background: rgba(255, 255, 255, 0.2);
      color: #fff;
    }

    .wr-setting-group {
      margin-bottom: 1.5rem;
    }

    .wr-setting-label {
      display: block;
      color: #aaa;
      font-size: 0.85rem;
      margin-bottom: 0.5rem;
      font-weight: 500;
    }

    .wr-setting-input {
      width: 100%;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 0.5rem;
      padding: 0.75rem;
      color: #fff;
      font-size: 0.9rem;
      transition: all 0.2s;
      box-sizing: border-box;
    }

    .wr-setting-input:focus {
      outline: none;
      border-color: #9b59b6;
      background: rgba(255, 255, 255, 0.08);
    }

    .wr-setting-input option {
      background: #1e1e32;
      color: #fff;
      padding: 0.5rem;
    }

    .wr-setting-toggle {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 0.5rem;
      cursor: pointer;
      transition: all 0.2s;
      min-height: 44px;
    }

    .wr-setting-toggle:active {
      background: rgba(255, 255, 255, 0.06);
    }

    .wr-toggle-label {
      color: #ccc;
      font-size: 0.9rem;
    }

    .wr-toggle-switch {
      position: relative;
      width: 48px;
      height: 24px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      transition: all 0.2s;
      flex-shrink: 0;
    }

    .wr-toggle-switch.active {
      background: #9b59b6;
    }

    .wr-toggle-slider {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 20px;
      height: 20px;
      background: #fff;
      border-radius: 50%;
      transition: all 0.2s;
    }

    .wr-toggle-switch.active .wr-toggle-slider {
      left: 26px;
    }

    .wr-modal-footer {
      display: flex;
      gap: 0.75rem;
      margin-top: 1.5rem;
      padding-top: 1rem;
      border-top: 1px solid rgba(155, 89, 182, 0.2);
    }

    .wr-btn-primary {
      flex: 1;
      background: linear-gradient(135deg, #9b59b6 0%, #8e44ad 100%);
      border: none;
      color: #fff;
      padding: 0.75rem;
      border-radius: 0.5rem;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      min-height: 44px;
    }

    .wr-btn-primary:active {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(155, 89, 182, 0.4);
    }

    .wr-btn-secondary {
      flex: 1;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #aaa;
      padding: 0.75rem;
      border-radius: 0.5rem;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      min-height: 44px;
    }

    .wr-btn-secondary:active {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }

    .wr-setting-desc {
      color: #666;
      font-size: 0.75rem;
      margin-top: 0.25rem;
    }

    /* Ranked War Stats */
    .wr-rw-limits {
      background: rgba(20, 20, 35, 0.95);
      border: 1px solid rgba(155, 89, 182, 0.3);
      border-radius: 0.5rem;
      padding: 0.5rem 0.75rem;
      margin: 0.5rem 0;
      font-size: 0.8rem;
      color: #ccc;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 0.5rem;
    }

    .wr-rw-limits-content {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem;
    }

    .wr-rw-limits-title {
      color: #9b59b6;
      font-weight: 600;
      margin-right: 0.5rem;
    }

    .wr-rw-limits-item {
      display: inline-block;
      margin-right: 1rem;
    }

    .wr-rw-limits-label {
      color: #888;
    }

    .wr-rw-limits-value {
      color: #fff;
      font-weight: 500;
    }

    .wr-rw-limits-updated {
      color: #666;
      font-size: 0.75rem;
      font-style: italic;
      white-space: nowrap;
    }

    .wr-rw-refresh-btn {
      background: none;
      border: none;
      color: #9b59b6;
      cursor: pointer;
      padding: 4px;
      margin-left: 0.5rem;
      opacity: 0.7;
      transition: all 0.2s;
      vertical-align: middle;
      display: inline-flex;
      align-items: center;
      min-width: 24px;
      min-height: 24px;
      pointer-events: auto;
    }

    .wr-rw-refresh-btn.disabled {
      color: #e74c3c;
      opacity: 0.6;
    }

    .wr-rw-refresh-btn:hover {
      opacity: 1;
    }

    .wr-rw-refresh-btn:active {
      opacity: 1;
      transform: scale(0.95);
    }
    
    .wr-rw-refresh-btn:focus {
      outline: none;
    }

    .wr-rw-refresh-btn.loading svg {
      animation: wr-spin 1s linear infinite;
    }

    @keyframes wr-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .wr-rw-stat {
      display: inline-block;
      font-size: 0.8rem;
      padding: 0 2px;
      color: #ccc;
      margin-right: 0.75rem;
    }

    .wr-rw-stat:last-child {
      margin-right: 0;
    }

    .wr-rw-stat.compliant {
      color: #2ecc71;
    }

    .wr-rw-stat.non-compliant {
      color: #e74c3c;
      font-weight: 600;
    }

    .wr-rw-stat-label {
      color: #888;
      margin-right: 0.25rem;
    }

    .wr-rw-stats-container {
      display: block;
      background: rgba(155, 89, 182, 0.08);
      border-top: 1px solid rgba(155, 89, 182, 0.2);
      padding: 0.4rem 0.75rem;
      font-size: 0.8rem;
    }
  `
  document.head.appendChild(style)

  // Create toast container
  const toastContainer = document.createElement('div')
  toastContainer.className = `wr-toast-container ${SETTINGS.toastPosition}`
  document.body.appendChild(toastContainer)

  // Toast management
  const activeToasts = new Map()

  function createToast(id, content, type = 'info', duration = 20000) {
    if (!toastContainer) return null

    // Update existing toast
    const existingToast = activeToasts.get(id)
    if (existingToast) {
      existingToast.element.innerHTML = content

      const closeBtn = existingToast.element.querySelector('.wr-toast-close')
      if (closeBtn) {
        closeBtn.addEventListener('click', () => removeToast(id))
      }

      return existingToast.element
    }

    // Create new toast
    const toastEl = document.createElement('div')
    toastEl.className = `wr-toast wr-${type}`
    toastEl.innerHTML = content

    const closeBtn = toastEl.querySelector('.wr-toast-close')
    if (closeBtn) {
      closeBtn.addEventListener('click', () => removeToast(id))
    }

    toastContainer.appendChild(toastEl)

    const timeoutId = duration > 0 ? setTimeout(() => removeToast(id), duration) : null
    activeToasts.set(id, { element: toastEl, timeoutId })

    return toastEl
  }

  function removeToast(id) {
    const toastData = activeToasts.get(id)
    if (!toastData) return

    if (toastData.timeoutId) clearTimeout(toastData.timeoutId)
    if (toastData.intervalId) clearInterval(toastData.intervalId)

    activeToasts.delete(id)
    toastData.element.classList.add('wr-closing')

    setTimeout(() => {
      toastData.element.remove()
    }, 300)
  }

  function toast(message, type = 'info') {
    const id = 'msg-' + Date.now()
    const content = `
      <div class="wr-toast-header">
        <span class="wr-toast-title">${type === 'success' ? 'Success' : type === 'error' ? 'Error' : 'WarRoom'}</span>
        <button class="wr-toast-close">&times;</button>
      </div>
      <div class="wr-toast-message">${escapeHtml(message)}</div>
    `
    createToast(id, content, type, 3000)
  }

  /**********************
   * TOAST NOTIFICATIONS
   **********************/

  function showAttackToast(attack, eventType = 'Added') {
    const id = 'attack-' + attack.id

    // Don't show toasts for done attacks
    if (attack.isDone) {
      removeToast(id)
      return
    }

    // Skip expired attacks
    if (attack.expiration) {
      const now = new Date()
      const expiration = new Date(attack.expiration)
      if (expiration <= now) {
        removeToast(id)
        return
      }
    }

    // Skip full attacks based on settings
    if (SETTINGS.autoHideFullAttacks && attack.isFull && !attack.link) {
      removeToast(id)
      return
    }

    const isFull = attack.isFull
    const statusClass = isFull ? 'full' : 'active'
    const statusText = isFull ? 'Full' : 'Active'

    const participantsHtml =
      attack.attackers && attack.attackers.length > 0
        ? attack.attackers
            .map((a) => `<span class="wr-participant" title="${escapeHtml(a)}">${escapeHtml(a)}</span>`)
            .join('')
        : ''

    // Check if user is in attackers list
    const isUserInAttackers = attack.attackers && attack.attackers.includes(currentUsername)
    const isUserCreator = attack.createdBy === currentUsername

    // Generate attack link from userId if not provided by server
    const attackLink = attack.link || (attack.userId ? `https://www.torn.com/loader.php?sid=attack&user2ID=${attack.userId}` : null)

    // Only show attack button if there's a link and current user is IN the attackers list
    const shouldShowAttackBtn = attackLink && currentUsername && isUserInAttackers
    const attackBtnHtml = shouldShowAttackBtn
      ? `<button class="wr-btn wr-btn-attack" data-url="${attackLink}">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <polyline points="15 3 21 3 21 9"/>
            <line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
          Attack
        </button>`
      : ''

    const shouldShowDoneBtn = attackLink && (isUserInAttackers || isUserCreator)
    const doneBtnHtml = shouldShowDoneBtn
      ? `<button class="wr-btn" data-attack-id="${attack.id}" id="wr-done-${attack.id}">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          Done
        </button>`
      : ''

    // Only show join button if attack isn't full AND user is not already in the attackers list
    const shouldShowJoinBtn = !isFull && !isUserInAttackers
    const joinBtnHtml = shouldShowJoinBtn
      ? `<button class="wr-btn wr-btn-join" data-attack-id="${attack.id}">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <line x1="19" y1="8" x2="19" y2="14"/>
            <line x1="22" y1="11" x2="16" y2="11"/>
          </svg>
          Join
        </button>`
      : ''

    const content = `
      <div class="wr-toast-header">
        <span class="wr-toast-title">Coordinated Attack</span>
        <button class="wr-toast-close">&times;</button>
      </div>
      <div class="wr-attack-card">
        <div class="wr-attack-top">
          <div class="wr-target-section">
            <span class="wr-target-name">${escapeHtml(attack.userName) || 'Unknown'}</span>
            <span class="wr-target-id">[${escapeHtml(attack.userId) || '?'}]</span>
          </div>
          <div class="wr-status-badge ${statusClass}">${statusText}</div>
        </div>

        <div class="wr-attack-middle">
          <div class="wr-timer-section" data-expiration="${escapeHtml(attack.expiration) || ''}">
            <svg class="wr-timer-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
            <span class="wr-timer-value">--:--</span>
          </div>
          <div class="wr-slots-section">
            <span class="wr-slots-value">
              <span class="filled">${attack.attackers?.length || 0}</span>
              <span class="separator">/</span>
              <span class="total">${escapeHtml(attack.numberOfPeopleNeeded) || '?'}</span>
            </span>
            <span class="wr-slots-label">participants</span>
          </div>
        </div>

        ${participantsHtml ? `<div class="wr-participants">${participantsHtml}</div>` : ''}

        <div class="wr-actions">
          ${joinBtnHtml}
          ${attackBtnHtml}
          ${doneBtnHtml}
        </div>

        <div class="wr-created-info">
          <span>by ${escapeHtml(attack.createdBy) || 'Unknown'}</span>
        </div>
      </div>
    `

    // duration = 0 means no auto-dismiss (stays until expired/done/full)
    const toastEl = createToast(id, content, 'attack', 0)
    if (!toastEl) return

    // Setup timer countdown - auto-remove when expired
    const timerSection = toastEl.querySelector('.wr-timer-section')
    const timerValue = toastEl.querySelector('.wr-timer-value')
    if (timerSection && timerValue && attack.expiration) {
      // Clear old interval if updating existing toast
      const toastData = activeToasts.get(id)
      if (toastData && toastData.intervalId) {
        clearInterval(toastData.intervalId)
      }

      const updateTimer = () => {
        const now = new Date()
        const expiration = new Date(attack.expiration)
        const diff = expiration.getTime() - now.getTime()

        if (diff <= 0) {
          timerValue.textContent = 'Expired'
          timerSection.classList.remove('urgent')
          // Auto-remove after showing "Expired" for 2 seconds
          setTimeout(() => removeToast(id), 2000)
          return false
        }

        const minutes = Math.floor(diff / 60000)
        const seconds = Math.floor((diff % 60000) / 1000)
        timerValue.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`

        if (minutes < 1) {
          timerSection.classList.add('urgent')
        }

        return true
      }

      updateTimer()
      const intervalId = setInterval(() => {
        if (!updateTimer() || !activeToasts.has(id)) {
          clearInterval(intervalId)
        }
      }, 1000)

      // Store intervalId in toast data so it can be cleared on removal or update
      if (toastData) {
        toastData.intervalId = intervalId
      }
    }

    // Setup button handlers
    const attackBtn = toastEl.querySelector('.wr-btn-attack')
    if (attackBtn) {
      attackBtn.addEventListener('click', () => {
        const url = attackBtn.dataset.url
        if (url) window.location.href = url
      })
    }

    const joinBtn = toastEl.querySelector('.wr-btn-join')
    if (joinBtn) {
      joinBtn.addEventListener('click', async () => {
        const attackId = joinBtn.dataset.attackId
        try {
          await pdaFetch(
            'POST',
            `${API_BASE}/WarRooms/participate/${attackId}`,
            {
              'Authorization': `Bearer ${jwt}`,
              'Content-Type': 'application/json',
            }
          )
          toast('Joined attack successfully!', 'success')
        } catch (e) {
          toast('Failed to join: ' + extractErrorMessage(e), 'error')
        }
      })
    }

    const doneBtn = toastEl.querySelector(`#wr-done-${attack.id}`)
    if (doneBtn) {
      doneBtn.addEventListener('click', async () => {
        const attackId = doneBtn.dataset.attackId
        try {
          await pdaFetch(
            'POST',
            `${API_BASE}/WarRooms/end/${attackId}`,
            {
              'Authorization': `Bearer ${jwt}`,
            }
          )
          toast('Attack marked as done!', 'success')
        } catch (e) {
          toast('Failed to mark as done: ' + extractErrorMessage(e), 'error')
        }
      })
    }
  }

  /**********************
   * ATTACK EVENT HANDLERS
   **********************/

  function handleAttackUpdate(event) {
    const attack = event.attack
    if (!attack) {
      return
    }

    // Convert numeric eventType to string
    let eventType = event.eventType ?? 'Added'
    if (typeof eventType === 'number') {
      eventType = ['Added', 'Updated', 'Done'][eventType] || 'Unknown'
    }

    const id = 'attack-' + attack.id

    // If done or removed, remove the toast
    if (eventType === 'Done' || eventType === 'Removed' || attack.isDone) {
      removeToast(id)
      return
    }

    // If full without link and auto-hide enabled, remove the toast
    if (SETTINGS.autoHideFullAttacks && attack.isFull && attack.link == null) {
      removeToast(id)
      return
    }

    showAttackToast(attack, eventType)
  }

  function handleWarRoomAttacks(data) {
    if (data.attacks && Array.isArray(data.attacks)) {
      const now = new Date()
      for (const attack of data.attacks) {
        // Show active attacks that aren't done, expired, or (full without link)
        if (attack.isDone) continue

        if (attack.expiration) {
          const expiration = new Date(attack.expiration)
          if (expiration <= now) continue
        }

        if (SETTINGS.autoHideFullAttacks && attack.isFull && !attack.link) continue

        showAttackToast(attack, 'Loaded')
      }
    }
  }

  function handleReceiveMessage(message) {
    toast(message, 'info')
  }

  /**********************
   * LOADER.PHP PAGE - TARGET DETECTION
   **********************/
  if (window.location.pathname.includes('/loader.php')) {
    // Get user2ID from URL query parameters
    const urlParams = new URLSearchParams(window.location.search)
    const user2ID = urlParams.get('user2ID')
    
    let detectedTarget = null
    
    if (user2ID) {
      // Function to fetch war room targets
      async function checkIfUserIsTarget() {
        try {
          // Check cache first
          let allTargets = getCachedTargets()

          if (!allTargets) {
            // Ensure we're authenticated first
            const authenticated = await ensureAuthenticated()
            if (!authenticated) return

            // Fetch all targets from the new unified endpoint
            const targetsRes = await pdaFetch(
              'GET',
              `${API_BASE}/warrooms/targets`,
              {
                'Authorization': `Bearer ${jwt}`,
              }
            )
            const warRoomTargetsData = JSON.parse(targetsRes.responseText)

            // Transform the response into a flat list of targets with warRoomId
            // Response format: [{ warRoomId, targetFaction, targets: [{ userId, userName }] }]
            allTargets = []
            for (const warRoomData of warRoomTargetsData) {
              if (warRoomData.targets && warRoomData.targets.length > 0) {
                allTargets.push(
                  ...warRoomData.targets.map(t => ({
                    ...t,
                    warRoomId: warRoomData.warRoomId
                  }))
                )
              }
            }

            // Cache the results
            setCachedTargets(allTargets)
          }

          // Check if user2ID is in the target list
          const targetMatch = allTargets.find(t => String(t.userId) === String(user2ID))

          if (targetMatch) {
            detectedTarget = targetMatch
            showCoordinatedAttackButton()
          }

        } catch {
          // Ignore errors checking war targets
        }
      }
      
      // Function to show coordinated attack button
      function showCoordinatedAttackButton() {
        const attackBtn = document.createElement('button')
        attackBtn.className = 'wr-attack-btn'
        attackBtn.title = 'Create Coordinated Attack'
        attackBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5v14"/>
            <path d="M5 12h14"/>
          </svg>
        `
        document.body.appendChild(attackBtn)
        
        attackBtn.addEventListener('click', () => showAttackDialog())
      }
      
      // Function to show attack creation dialog
      function showAttackDialog() {
        if (!detectedTarget) return
        
        const overlay = document.createElement('div')
        overlay.className = 'wr-modal-overlay'
        
        const modal = document.createElement('div')
        modal.className = 'wr-modal'
        modal.innerHTML = `
          <div class="wr-modal-header">
            <h2 class="wr-modal-title">🎯 Create Coordinated Attack</h2>
            <button class="wr-modal-close">&times;</button>
          </div>

          <div class="wr-setting-group">
            <label class="wr-setting-label">Target</label>
            <div class="wr-setting-input" style="pointer-events: none; opacity: 0.7;">${escapeHtml(detectedTarget.userName)} [${escapeHtml(detectedTarget.userId)}]</div>
          </div>

          <div class="wr-setting-group">
            <label class="wr-setting-label">Number of People Needed</label>
            <input type="number" class="wr-setting-input" id="wr-people-needed" value="4" min="1" max="30">
            <div class="wr-setting-desc">How many people should join (1-30)</div>
          </div>

          <div class="wr-setting-group">
            <label class="wr-setting-label">Expiration (minutes)</label>
            <input type="number" class="wr-setting-input" id="wr-expiration" value="5" min="1" max="15">
            <div class="wr-setting-desc">How long before the attack expires (1-15)</div>
          </div>

          <div class="wr-setting-group">
            <div class="wr-setting-toggle" id="wr-toggle-waitfull">
              <span class="wr-toggle-label">Wait Until Full</span>
              <div class="wr-toggle-switch">
                <div class="wr-toggle-slider"></div>
              </div>
            </div>
            <div class="wr-setting-desc">Only show attack link when all participants have joined</div>
          </div>

          <div class="wr-modal-footer">
            <button class="wr-btn-secondary" id="wr-cancel">Cancel</button>
            <button class="wr-btn-primary" id="wr-create">Create Attack</button>
          </div>
        `
        
        overlay.appendChild(modal)
        document.body.appendChild(overlay)
        
        // Close button
        modal.querySelector('.wr-modal-close').addEventListener('click', () => {
          overlay.remove()
        })
        
        // Click outside to close
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) {
            overlay.remove()
          }
        })
        
        // Cancel button
        modal.querySelector('#wr-cancel').addEventListener('click', () => {
          overlay.remove()
        })
        
        // Toggle handler
        const toggleWaitFull = modal.querySelector('#wr-toggle-waitfull')
        toggleWaitFull.addEventListener('click', () => {
          const sw = toggleWaitFull.querySelector('.wr-toggle-switch')
          sw.classList.toggle('active')
        })
        
        // Create button
        modal.querySelector('#wr-create').addEventListener('click', async () => {
          const numberOfPeopleNeeded = parseInt(modal.querySelector('#wr-people-needed').value) || 4
          const expirationInMinutes = parseInt(modal.querySelector('#wr-expiration').value) || 5
          const shouldWaitUntilFullToShowLink = toggleWaitFull.querySelector('.wr-toggle-switch').classList.contains('active')
          
          // Validate inputs
          if (numberOfPeopleNeeded < 1 || numberOfPeopleNeeded > 30) {
            toast('Number of people must be between 1 and 30', 'error')
            return
          }
          
          if (expirationInMinutes < 1 || expirationInMinutes > 15) {
            toast('Expiration must be between 1 and 15 minutes', 'error')
            return
          }
          
          // Create attack
          try {
            const res = await pdaFetch(
              'POST',
              `${API_BASE}/WarRooms/${detectedTarget.warRoomId}/attack`,
              {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${jwt}`,
              },
              JSON.stringify({
                userId: detectedTarget.userId,
                userName: detectedTarget.userName,
                numberOfPeopleNeeded,
                isCreatorParticipating: true,
                shouldWaitUntilFullToShowLink,
                expirationInMinutes
              })
            )
            
            overlay.remove()
            toast('Coordinated attack created successfully!', 'success')
          } catch (e) {
            overlay.remove()
            toast('Failed to create attack: ' + extractErrorMessage(e), 'error')
          }
        })
      }
      
      // Run the check
      checkIfUserIsTarget()
    }
  }

  /**********************
   * MAIN EXECUTION FLOW
   **********************/

  async function setupConnection() {
    // Set display name
    await connection.send('SetDisplayName', 'TornPDA')

    // Brief wait
    await new Promise(resolve => setTimeout(resolve, 100))

    // Check if still connected
    if (!connection.running) {
      throw new Error('Connection was closed by server')
    }

    // Get war rooms
    const warRooms = await connection.invoke('GetWarRooms')
    if (warRooms && Array.isArray(warRooms)) {
      warRoomIds = warRooms.map((wr) => wr.warRoomId || wr.id)

      // Fetch attacks for each war room
      for (const warRoomId of warRoomIds) {
        try {
          await connection.invoke('GetAttacks', warRoomId)
        } catch (e) {
          // Ignore fetch errors
        }
      }
    }
  }

  async function connectToWarRoom() {
    try {
      // Authenticate
      const authenticated = await ensureAuthenticated()
      if (!authenticated) {
        return
      }

      // Create SignalR connection if not already created
      if (!connection) {
        connection = new SignalRLongPollingConnection(HUB_URL, jwt)

        // Register event handlers
        connection.on('AttackUpdate', handleAttackUpdate)
        connection.on('WarRoomAttacks', handleWarRoomAttacks)
        connection.on('ReceiveMessage', handleReceiveMessage)
      }

      // Start connection
      if (!connection.running) {
        await connection.start()
        await setupConnection()

        // Success notification
        toast('WarRoom Connected - Listening for attacks', 'success')
      }
    } catch (e) {
      log('Main', 'Failed to connect', e.message)
      toast('Failed to connect: ' + extractErrorMessage(e), 'error')
    }
  }

  function disconnectFromWarRoom() {
    try {
      if (connection) {
        connection.stop()
        connection = null
        warRoomIds = []
        toast('Disconnected from WarRoom', 'info')
      }
    } catch {
      // Ignore disconnect errors
    }
  }

  async function main() {
    // Check if in TornPDA
    if (!IS_TORN_PDA) {
      return
    }

    // Connect to WarRoom if feed is enabled
    if (SETTINGS.attackFeedEnabled) {
      await connectToWarRoom()
    }
  }

  /**********************
   * RANKED WAR STATS DISPLAY
   **********************/

  // Page detection
  const isFactionsPage = window.location.pathname.includes('/factions.php')

  // Fetch ranked war stats from API
  let rankedWarStatsCache = null
  let rankedWarStatsCacheExpiry = 0
  let rankedWarAutoRefreshTimeout = null
  let rankedWarAutoRefreshEnabled = true // Auto-refresh is enabled by default

  // Function to trigger UI refresh for ranked war stats
  async function triggerRankedWarUIRefresh(isAutoRefresh = false) {
    log('RankedWar', `UI refresh triggered (${isAutoRefresh ? 'auto' : 'manual'})`)
    
    // Clear cache to force fresh fetch
    rankedWarStatsCache = null
    rankedWarStatsCacheExpiry = 0
    
    // Only clear the auto-refresh timeout if this is a manual refresh
    // Let auto-refresh set up the next one naturally
    if (!isAutoRefresh && rankedWarAutoRefreshTimeout) {
      clearTimeout(rankedWarAutoRefreshTimeout)
      rankedWarAutoRefreshTimeout = null
    }
    
    // Remove existing stats from member rows
    document.querySelectorAll('.wr-rw-stats-container').forEach(el => el.remove())
    // Reset points element colors
    document.querySelectorAll('.your-faction .points').forEach(el => {
      el.style.color = ''
      el.style.fontWeight = ''
    })
    
    // Re-run enhancement which will update the limits display
    await enhanceRankedWarPage()
  }

  async function fetchRankedWarStats() {
    if (!jwt) {
      log('RankedWar', 'No JWT token available')
      return null
    }

    // Return cached data if still valid
    const now = Date.now()
    if (rankedWarStatsCache && now < rankedWarStatsCacheExpiry) {
      log('RankedWar', `Using cached stats (expires in ${Math.round((rankedWarStatsCacheExpiry - now) / 1000)}s)`)
      return rankedWarStatsCache
    }

    try {
      log('RankedWar', 'Fetching fresh stats from API')
      const res = await pdaFetch('GET', `${API_BASE}/rankedwars/last`, {
        'Authorization': `Bearer ${jwt}`
      })
      rankedWarStatsCache = JSON.parse(res.responseText)

      // Set cache expiry based on NextUpdate field from response (max 1 hour)
      const maxCacheMs = 60 * 60 * 1000 // 1 hour
      
      if (rankedWarStatsCache.nextUpdate) {
        const nextUpdateTime = new Date(rankedWarStatsCache.nextUpdate).getTime()
        const now = Date.now()
        rankedWarStatsCacheExpiry = Math.min(nextUpdateTime, now + maxCacheMs)

        // Schedule auto-refresh 1 second after nextUpdate (only if on factions page AND enabled)
        if (rankedWarAutoRefreshEnabled && isFactionsPage && window.location.search.includes('step=your')) {
          if (rankedWarAutoRefreshTimeout) {
            clearTimeout(rankedWarAutoRefreshTimeout)
          }
          let refreshDelay = nextUpdateTime - Date.now() + 1000 // 1 second after nextUpdate
          
          // If nextUpdate has already passed, schedule immediate refresh (2 seconds from now)
          if (refreshDelay <= 0) {
            refreshDelay = 2000 // 2 seconds from now
          }
          
          if (refreshDelay < maxCacheMs) {
            log('RankedWar', `Scheduling auto-refresh in ${Math.round(refreshDelay / 1000)}s`)
            rankedWarAutoRefreshTimeout = setTimeout(async () => {
              log('RankedWar', 'Auto-refresh triggered')
              try {
                await triggerRankedWarUIRefresh(true)
              } catch (err) {
                log('RankedWar', 'Auto-refresh failed:', err)
              }
            }, refreshDelay)
          } else {
            log('RankedWar', 'Auto-refresh delay exceeds maximum, not scheduling')
          }
        } else {
          log('RankedWar', 'Not on ranked war page, auto-refresh not scheduled')
        }
      } else {
        log('RankedWar', 'No nextUpdate in API response')
        // Fallback to 1 minute if NextUpdate not provided
        rankedWarStatsCacheExpiry = Date.now() + 60000
      }

      log('RankedWar', 'Stats fetched successfully', {
        membersCount: rankedWarStatsCache?.members?.length,
        hasLimits: !!rankedWarStatsCache?.currentLimit
      })
      return rankedWarStatsCache
    } catch (e) {
      log('RankedWar', 'Failed to fetch stats', e.message)
      return null
    }
  }

  // Check compliance against current limits
  function checkRankedWarCompliance(member, limits) {
    if (!limits) return { hits: 'neutral', total: 'neutral', avg: 'neutral' }

    const result = { hits: 'neutral', total: 'neutral', avg: 'neutral' }
    const nbWarHits = member.nbWarHits ?? 0
    const totalRespect = member.totalRespect ?? 0
    const averageRespect = member.averageRespect ?? 0

    // Check hits
    if (limits.minHits != null && nbWarHits < limits.minHits) {
      result.hits = 'non-compliant'
    } else if (limits.maxHits != null && nbWarHits > limits.maxHits) {
      result.hits = 'non-compliant'
    } else if (limits.minHits != null || limits.maxHits != null) {
      result.hits = 'compliant'
    }

    // Check total respect
    if (limits.minTotalRespect != null && totalRespect < limits.minTotalRespect) {
      result.total = 'non-compliant'
    } else if (limits.maxTotalRespect != null && totalRespect > limits.maxTotalRespect) {
      result.total = 'non-compliant'
    } else if (limits.minTotalRespect != null || limits.maxTotalRespect != null) {
      result.total = 'compliant'
    }

    // Check average respect (only if member has hits)
    if (limits.averageRespectGoal != null && nbWarHits > 0 && averageRespect < limits.averageRespectGoal) {
      result.avg = 'non-compliant'
    } else if (limits.averageRespectGoal != null && nbWarHits > 0) {
      result.avg = 'compliant'
    }

    return result
  }

  // Format relative time (e.g., "2 minutes ago")
  function formatRelativeTime(dateString) {
    if (!dateString) return null

    // Normalize timestamps with microsecond precision (6 digits) to milliseconds (3 digits)
    // e.g., "2026-01-24T21:01:30.088026Z" -> "2026-01-24T21:01:30.088Z"
    const normalizedDateString = dateString.replace(/\.(\d{3})\d+Z$/, '.$1Z')

    const date = new Date(normalizedDateString)
    if (isNaN(date.getTime())) return null

    const now = new Date()
    const diffMs = now.getTime() - date.getTime()

    // Handle future dates (clock skew) - treat small future times as "just now"
    // For larger clock skews, use absolute difference
    const absDiffMs = Math.abs(diffMs)

    const diffSeconds = Math.floor(absDiffMs / 1000)
    const diffMinutes = Math.floor(diffSeconds / 60)
    const diffHours = Math.floor(diffMinutes / 60)
    const diffDays = Math.floor(diffHours / 24)

    if (diffSeconds < 60) {
      return `${diffSeconds} second${diffSeconds !== 1 ? 's' : ''} ago`
    } else if (diffMinutes < 60) {
      return `${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''} ago`
    } else if (diffHours < 24) {
      return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`
    } else if (diffDays < 7) {
      return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`
    } else {
      return date.toLocaleDateString()
    }
  }

  // Update existing limits display element
  function updateLimitsDisplay(container, limits, lastUpdated, onRefresh) {
    if (!container) return

    // Store for later use when toggling auto-refresh
    container._lastLimits = limits
    container._lastUpdated = lastUpdated

    // Clear existing interval if any
    if (container._limitsUpdateInterval) {
      clearInterval(container._limitsUpdateInterval)
    }

    const relativeTime = formatRelativeTime(lastUpdated)
    const autoRefreshClass = rankedWarAutoRefreshEnabled ? 'enabled' : 'disabled'
    const autoRefreshIcon = rankedWarAutoRefreshEnabled 
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 2v6h-6"/>
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
          <path d="M3 22v-6h6"/>
          <path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
          <circle cx="12" cy="12" r="2" fill="currentColor"/>
        </svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 2v6h-6"/>
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
          <path d="M3 22v-6h6"/>
          <path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
          <line x1="2" y1="2" x2="22" y2="22"/>
        </svg>`
    const refreshBtnHtml = onRefresh ? `<button class="wr-rw-refresh-btn ${autoRefreshClass}">${autoRefreshIcon}</button>` : ''
    const updatedHtml = relativeTime ? `<span class="wr-rw-limits-updated">Last data update: ${escapeHtml(relativeTime)}</span>${refreshBtnHtml}` : ''

    if (!limits) {
      container.innerHTML = `<div class="wr-rw-limits-content"><span class="wr-rw-limits-title">Limits:</span><span class="wr-rw-limits-label">No active limits</span></div>${updatedHtml}`
    } else {
      const items = []

      if (limits.minHits != null || limits.maxHits != null) {
        const hitsText = limits.minHits != null && limits.maxHits != null
          ? `${limits.minHits}-${limits.maxHits}`
          : limits.minHits != null
            ? `≥${limits.minHits}`
            : `≤${limits.maxHits}`
        items.push(`<span class="wr-rw-limits-item"><span class="wr-rw-limits-label">Number of Hits: </span><span class="wr-rw-limits-value">${escapeHtml(hitsText)}</span></span>`)
      }

      if (limits.minTotalRespect != null || limits.maxTotalRespect != null) {
        const totalText = limits.minTotalRespect != null && limits.maxTotalRespect != null
          ? `${limits.minTotalRespect.toFixed(1)}-${limits.maxTotalRespect.toFixed(1)}`
          : limits.minTotalRespect != null
            ? `≥${limits.minTotalRespect.toFixed(1)}`
            : `≤${limits.maxTotalRespect.toFixed(1)}`
        items.push(`<span class="wr-rw-limits-item"><span class="wr-rw-limits-label">Total Respect: </span><span class="wr-rw-limits-value">${escapeHtml(totalText)}</span></span>`)
      }

      if (limits.averageRespectGoal != null) {
        items.push(`<span class="wr-rw-limits-item"><span class="wr-rw-limits-label">Average Respect: </span><span class="wr-rw-limits-value">≥${escapeHtml(limits.averageRespectGoal.toFixed(2))}</span></span>`)
      }

      container.innerHTML = `<div class="wr-rw-limits-content"><span class="wr-rw-limits-title">Limits:</span>${items.length > 0 ? items.join('') : '<span class="wr-rw-limits-label">None defined</span>'}</div>${updatedHtml}`
    }

    // Set up refresh button click handler
    if (onRefresh) {
      const refreshBtn = container.querySelector('.wr-rw-refresh-btn')
      if (refreshBtn) {
        // Store the onRefresh function on container to prevent duplicates
        container._onRefresh = onRefresh
        
        refreshBtn.addEventListener('click', async (e) => {
          // Prevent concurrent refreshes
          if (container._isRefreshing) {
            log('RankedWar', 'Refresh already in progress, ignoring click')
            return
          }
          
          e.preventDefault()
          e.stopPropagation()
          
          // Remove focus to close tooltip
          if (document.activeElement) {
            document.activeElement.blur()
          }
          refreshBtn.blur()
          
          // Toggle auto-refresh state
          if (rankedWarAutoRefreshEnabled) {
            // Disable auto-refresh
            rankedWarAutoRefreshEnabled = false
            if (rankedWarAutoRefreshTimeout) {
              clearTimeout(rankedWarAutoRefreshTimeout)
              rankedWarAutoRefreshTimeout = null
            }
            log('RankedWar', 'Auto-refresh disabled')
            toast('Auto-refresh disabled', 'info')
            // Update button appearance immediately
            updateLimitsDisplay(container, container._lastLimits, container._lastUpdated, container._onRefresh)
          } else {
            // Re-enable auto-refresh and do a manual refresh
            rankedWarAutoRefreshEnabled = true
            log('RankedWar', 'Auto-refresh re-enabled, triggering refresh')
            
            container._isRefreshing = true
            refreshBtn.classList.add('loading')
            
            try {
              await container._onRefresh()
              toast('Auto-refresh enabled', 'success')
            } catch (err) {
              log('RankedWar', 'Refresh error:', err)
            } finally {
              container._isRefreshing = false
              // Button will be recreated by update, so no need to remove loading class
            }
          }
        })
      }
    }

    // Set up dynamic time update for "Last data update" timestamp
    if (lastUpdated) {
      const updateInterval = setInterval(() => {
        // Stop updating if element is no longer in DOM
        if (!container.isConnected) {
          clearInterval(updateInterval)
          return
        }

        const updatedSpan = container.querySelector('.wr-rw-limits-updated')
        if (updatedSpan) {
          const newRelativeTime = formatRelativeTime(lastUpdated)
          if (newRelativeTime) {
            updatedSpan.textContent = `Last data update: ${newRelativeTime}`
          }
        }
      }, 1000)

      // Store interval ID for cleanup
      container._limitsUpdateInterval = updateInterval
    }
  }

  // Create limits display element
  function createLimitsDisplay(limits, lastUpdated, onRefresh) {
    const container = document.createElement('div')
    container.className = 'wr-rw-limits'
    updateLimitsDisplay(container, limits, lastUpdated, onRefresh)
    return container
  }

  // Add stats to member row and color the points element
  function addStatsToMemberRow(row, member, limits) {
    // Check if already added
    if (row.querySelector('.wr-rw-stats-container')) return

    const compliance = checkRankedWarCompliance(member, limits)
    const nbWarHits = member.nbWarHits ?? 0
    const averageRespect = member.averageRespect ?? 0

    // Color the existing .points element based on total respect compliance
    const pointsEl = row.querySelector('.points')
    if (pointsEl) {
      if (compliance.total === 'compliant') {
        pointsEl.style.color = '#2ecc71'
      } else if (compliance.total === 'non-compliant') {
        pointsEl.style.color = '#e74c3c'
        pointsEl.style.fontWeight = '600'
      }
    }

    // Add stats container with hits and average respect
    const statsContainer = document.createElement('div')
    statsContainer.className = 'wr-rw-stats-container'
    statsContainer.innerHTML = `
      <span class="wr-rw-stat ${escapeHtml(compliance.hits)}"><span class="wr-rw-stat-label">Number of Hits:</span>${escapeHtml(String(nbWarHits))}</span>
      <span class="wr-rw-stat ${escapeHtml(compliance.avg)}"><span class="wr-rw-stat-label">Average Respect:</span>${escapeHtml(averageRespect.toFixed(2))}</span>
    `

    row.appendChild(statsContainer)
  }

  // Extract username from member row
  function extractUsernameFromRow(row) {
    // Try .honor-text element first (contains plain text username)
    const honorText = row.querySelector('.honor-text:not(.honor-text-svg)')
    if (honorText) {
      return honorText.textContent.trim()
    }

    // Fallback: try aria-label on status element
    const statusEl = row.querySelector('[aria-label*="User "]')
    if (statusEl) {
      const match = statusEl.getAttribute('aria-label').match(/User (\S+)/)
      if (match) return match[1]
    }

    return null
  }

  // Main function to enhance ranked war page
  async function enhanceRankedWarPage() {
    // Wait for the faction war list to be present
    const factionWarList = document.getElementById('faction_war_list_id')
    if (!factionWarList) return

    // Ensure we're authenticated before fetching stats
    const authenticated = await ensureAuthenticated()
    if (!authenticated) {
      log('RankedWar', 'Not authenticated, cannot fetch stats')
      return
    }

    // Fetch stats from API
    const statsData = await fetchRankedWarStats()
    if (!statsData) {
      log('RankedWar', 'No stats data returned from API')
      return
    }

    // Create a map of members by name for quick lookup (case-insensitive)
    const membersByName = new Map()
    if (statsData.members) {
      for (const member of statsData.members) {
        membersByName.set(member.name.toLowerCase(), member)
      }
    }
    log('RankedWar', `Loaded ${membersByName.size} members, limits:`, statsData.currentLimit)

    // Find and enhance the your-faction section
    const yourFactionSection = document.querySelector('.your-faction')
    if (!yourFactionSection) {
      log('RankedWar', 'Could not find .your-faction section')
      return
    }

    // Refresh function to manually update stats
    const refreshStats = async () => {
      log('RankedWar', 'Manual refresh triggered')
      await triggerRankedWarUIRefresh()
    }

    // Add or update limits display below faction-war-info
    const factionWarInfo = document.querySelector('.faction-war-info')
    let limitsDisplay = document.querySelector('.wr-rw-limits')
    
    if (factionWarInfo) {
      if (!limitsDisplay) {
        log('RankedWar', 'Creating limits display')
        limitsDisplay = createLimitsDisplay(statsData.currentLimit, statsData.lastUpdated, refreshStats)
        factionWarInfo.parentNode.insertBefore(limitsDisplay, factionWarInfo.nextSibling)
      } else {
        log('RankedWar', 'Updating existing limits display')
        updateLimitsDisplay(limitsDisplay, statsData.currentLimit, statsData.lastUpdated, refreshStats)
      }
    } else {
      log('RankedWar', 'Could not find .faction-war-info element')
    }

    // Find all member rows in your faction
    const memberRows = yourFactionSection.querySelectorAll('li.your')
    log('RankedWar', `Found ${memberRows.length} member rows to enhance`)

    for (const row of memberRows) {
      const username = extractUsernameFromRow(row)
      if (!username) continue

      // Get member data or create default with zeros (case-insensitive lookup)
      const memberData = membersByName.get(username.toLowerCase()) || {
        name: username,
        nbWarHits: 0,
        totalRespect: 0,
        averageRespect: 0
      }

      addStatsToMemberRow(row, memberData, statsData.currentLimit)
    }
    log('RankedWar', 'Enhancement complete')
  }

  // Initialize ranked war enhancement with MutationObserver
  if (isFactionsPage && window.location.search.includes('step=your')) {
    let rankedWarEnhanced = false
    let rankedWarObserver = null

    function setupRankedWarObserver() {
      if (rankedWarObserver) return

      rankedWarObserver = new MutationObserver(() => {
        if (rankedWarEnhanced) return

        const factionWarList = document.getElementById('faction_war_list_id')
        if (factionWarList && window.location.hash.includes('/war/rank')) {
          rankedWarEnhanced = true
          rankedWarObserver.disconnect()
          rankedWarObserver = null
          enhanceRankedWarPage()
        }
      })

      rankedWarObserver.observe(document.body, { childList: true, subtree: true })
    }

    // Listen for hash changes (SPA navigation)
    window.addEventListener('hashchange', () => {
      if (window.location.hash.includes('/war/rank')) {
        // Reset state for new navigation
        rankedWarEnhanced = false
        // Small delay to let DOM update, then try to enhance
        setTimeout(() => {
          if (!rankedWarEnhanced) {
            setupRankedWarObserver()
            // Also try immediately in case DOM is ready
            const factionWarList = document.getElementById('faction_war_list_id')
            if (factionWarList) {
              rankedWarEnhanced = true
              if (rankedWarObserver) {
                rankedWarObserver.disconnect()
                rankedWarObserver = null
              }
              enhanceRankedWarPage()
            }
          }
        }, 500)
      }
    })

    // Initial check
    if (window.location.hash.includes('/war/rank')) {
      setupRankedWarObserver()
      setTimeout(() => {
        if (!rankedWarEnhanced) {
          const factionWarList = document.getElementById('faction_war_list_id')
          if (factionWarList) {
            rankedWarEnhanced = true
            if (rankedWarObserver) {
              rankedWarObserver.disconnect()
              rankedWarObserver = null
            }
            enhanceRankedWarPage()
          }
        }
      }, 1000)
    }
  }

  /**********************
   * SETTINGS UI
   **********************/
  function showSettingsModal() {
    const overlay = document.createElement('div')
    overlay.className = 'wr-modal-overlay'

    const modal = document.createElement('div')
    modal.className = 'wr-modal'
    modal.innerHTML = `
      <div class="wr-modal-header">
        <h2 class="wr-modal-title">⚙️ WarRoom Settings</h2>
        <button class="wr-modal-close">&times;</button>
      </div>

      <div class="wr-setting-group">
        <label class="wr-setting-label">Toast Position</label>
        <select class="wr-setting-input" id="wr-toast-position">
          <option value="bottom-left" ${SETTINGS.toastPosition === 'bottom-left' ? 'selected' : ''}>Bottom Left</option>
          <option value="bottom-right" ${SETTINGS.toastPosition === 'bottom-right' ? 'selected' : ''}>Bottom Right</option>
          <option value="top-left" ${SETTINGS.toastPosition === 'top-left' ? 'selected' : ''}>Top Left</option>
          <option value="top-right" ${SETTINGS.toastPosition === 'top-right' ? 'selected' : ''}>Top Right</option>
        </select>
        <div class="wr-setting-desc">Choose where notifications appear on screen</div>
      </div>

      <div class="wr-setting-group">
        <div class="wr-setting-toggle" id="wr-toggle-feed">
          <span class="wr-toggle-label">Attack Feed</span>
          <div class="wr-toggle-switch ${SETTINGS.attackFeedEnabled ? 'active' : ''}">
            <div class="wr-toggle-slider"></div>
          </div>
        </div>
        <div class="wr-setting-desc">Enable or disable attack notifications</div>
      </div>

      <div class="wr-setting-group">
        <div class="wr-setting-toggle" id="wr-toggle-autohide">
          <span class="wr-toggle-label">Auto-hide Full Attacks</span>
          <div class="wr-toggle-switch ${SETTINGS.autoHideFullAttacks ? 'active' : ''}">
            <div class="wr-toggle-slider"></div>
          </div>
        </div>
        <div class="wr-setting-desc">Automatically hide attacks when they become full</div>
      </div>

      <div class="wr-modal-footer">
        <button class="wr-btn-secondary" id="wr-clear-cache">Clear Cache</button>
        <button class="wr-btn-secondary" id="wr-clear-token">Clear Token</button>
        <button class="wr-btn-primary" id="wr-save">Save</button>
      </div>
    `

    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    // Close button
    modal.querySelector('.wr-modal-close').addEventListener('click', () => {
      overlay.remove()
    })

    // Click outside to close
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove()
      }
    })

    // Toggle handlers
    const toggleFeed = modal.querySelector('#wr-toggle-feed')
    toggleFeed.addEventListener('click', () => {
      const sw = toggleFeed.querySelector('.wr-toggle-switch')
      sw.classList.toggle('active')
    })

    const toggleAutoHide = modal.querySelector('#wr-toggle-autohide')
    toggleAutoHide.addEventListener('click', () => {
      const sw = toggleAutoHide.querySelector('.wr-toggle-switch')
      sw.classList.toggle('active')
    })

    // Save button
    modal.querySelector('#wr-save').addEventListener('click', async () => {
      const newSettings = {
        toastPosition: modal.querySelector('#wr-toast-position').value,
        attackFeedEnabled: toggleFeed.querySelector('.wr-toggle-switch').classList.contains('active'),
        autoHideFullAttacks: toggleAutoHide.querySelector('.wr-toggle-switch').classList.contains('active')
      }

      if (saveSettings(newSettings)) {
        const oldFeedEnabled = SETTINGS.attackFeedEnabled
        SETTINGS = newSettings
        overlay.remove()
        
        // Handle feed connection change
        if (oldFeedEnabled !== SETTINGS.attackFeedEnabled) {
          if (SETTINGS.attackFeedEnabled) {
            await connectToWarRoom()
          } else {
            disconnectFromWarRoom()
          }
        }
        
        toast('Settings saved! Reload page for full effect.', 'success')
      } else {
        toast('Failed to save settings', 'error')
      }
    })

    // Clear cache button
    modal.querySelector('#wr-clear-cache').addEventListener('click', () => {
      if (clearTargetCache()) {
        toast('Cache cleared successfully!', 'success')
      } else {
        toast('Failed to clear cache', 'error')
      }
    })

    // Clear token button
    modal.querySelector('#wr-clear-token').addEventListener('click', () => {
      clearStoredToken()
      jwt = null
      currentUsername = null
      if (connection) {
        connection.stop()
        connection = null
      }
      toast('Token cleared! Reload page to re-authenticate.', 'success')
      setTimeout(() => {
        overlay.remove()
      }, 1000)
    })
  }

  // Settings button (only show in PDA environment)
  if (IS_TORN_PDA) {
    const settingsBtn = document.createElement('button')
    settingsBtn.className = 'wr-settings-btn'
    settingsBtn.title = 'Settings'
    settingsBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"/>
        <path d="M12 1v6m0 6v6m9-9h-6m-6 0H3m15.364 6.364l-4.243-4.243m-6 0L3.636 18.364m16.728 0l-4.243-4.243m-6 0L3.636 5.636"/>
      </svg>
    `
    document.body.appendChild(settingsBtn)

    settingsBtn.addEventListener('click', () => {
      showSettingsModal()
    })

    // Feed toggle button
    const feedToggleBtn = document.createElement('button')
    feedToggleBtn.className = 'wr-feed-toggle-btn'
    feedToggleBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        <line class="wr-bell-cross" x1="4" y1="4" x2="20" y2="20" stroke-width="2.5" style="display: none;"/>
      </svg>
    `
    document.body.appendChild(feedToggleBtn)

    // Update button state based on settings
    const updateFeedToggleState = () => {
      const cross = feedToggleBtn.querySelector('.wr-bell-cross')
      
      if (SETTINGS.attackFeedEnabled) {
        feedToggleBtn.classList.remove('disabled')
        feedToggleBtn.title = 'Attack Feed: ON (click to disable)'
        if (cross) cross.style.display = 'none'
      } else {
        feedToggleBtn.classList.add('disabled')
        feedToggleBtn.title = 'Attack Feed: OFF (click to enable)'
        if (cross) cross.style.display = 'block'
      }
    }
    
    // Set initial state
    updateFeedToggleState()

    feedToggleBtn.addEventListener('click', async () => {
      SETTINGS.attackFeedEnabled = !SETTINGS.attackFeedEnabled
      saveSettings(SETTINGS)
      
      // Update button state immediately
      updateFeedToggleState()
      
      if (SETTINGS.attackFeedEnabled) {
        await connectToWarRoom()
      } else {
        disconnectFromWarRoom()
      }
    })
  }

  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
    if (connection) {
      connection.stop()
    }

    // Clear all toast timers to prevent memory leaks
    for (const toastData of activeToasts.values()) {
      if (toastData.timeoutId) clearTimeout(toastData.timeoutId)
      if (toastData.intervalId) clearInterval(toastData.intervalId)
    }
    activeToasts.clear()
  })

  // Start script
  main().catch((e) => {
    log('Main', 'Fatal error', e)
    toast('Fatal error: ' + e.message, 'error')
  })
})()
