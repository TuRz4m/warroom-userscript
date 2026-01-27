// warroom-shared.js — Shared logic for WarRoom userscript (Desktop + PDA)
// Loaded via @require by both warroom.user.js and warroom-pda.user.js

// eslint-disable-next-line no-unused-vars
async function initWarRoom(platform) {
  'use strict'

  /**********************
   * CONSTANTS
   **********************/
  const API_BASE = 'https://api.torn.zzcraft.net'
  const HUB_URL = 'https://api.torn.zzcraft.net/warroomhub'
  const TOKEN_STORAGE_KEY = 'wr_jwt_token'
  const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000 // 5 minutes
  const TARGET_CACHE_KEY = platform.targetCacheKey
  const TARGET_CACHE_TTL = 60 * 60 * 1000 // 1 hour
  const SETTINGS_KEY = platform.settingsKey

  /**********************
   * UTILITY FUNCTIONS
   **********************/

  function escapeHtml(str) {
    if (str == null) return ''
    const div = document.createElement('div')
    div.textContent = String(str)
    return div.innerHTML
  }

  function parseJwtClaims(token) {
    try {
      return JSON.parse(atob(token.split('.')[1]))
    } catch {
      return null
    }
  }

  function extractErrorMessage(error) {
    return error.message.replace(/^HTTP \d+:\s*/, '')
  }

  function log(category, message, data) {
    if (data !== undefined) {
      if (typeof data === 'object' && data !== null) {
        try {
          console.log(`[WarRoom:${category}]`, message, JSON.stringify(data, null, 2))
        } catch {
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
   * SETTINGS MANAGEMENT
   **********************/
  const DEFAULT_SETTINGS = {
    apiKey: '',
    attackFeedEnabled: true,
    attackFeedOnLoaderPage: false,
    toastPosition: 'bottom-left',
    buttonPosition: 'bottom-left',
    toastDuration: 20000,
    soundEnabled: false,
    autoHideFullAttacks: true,
    urgentThresholdMinutes: 1,
    maxToasts: 10,
    showMemberStatsOnRankedWar: true
  }

  function getSettings() {
    try {
      const stored = platform.getValue(SETTINGS_KEY, null)
      if (!stored) return { ...DEFAULT_SETTINGS }
      const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored
      return { ...DEFAULT_SETTINGS, ...parsed }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  function saveSettings(settings) {
    try {
      const value = typeof settings === 'string' ? settings : JSON.stringify(settings)
      platform.setValue(SETTINGS_KEY, value)
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
  let currentUserId = null
  let connection = null
  let warRoomIds = []

  /**********************
   * CACHE MANAGEMENT
   **********************/

  function clearTargetCache() {
    try {
      platform.removeValue(TARGET_CACHE_KEY)
      return true
    } catch {
      return false
    }
  }

  function getCachedTargets() {
    try {
      const cached = platform.getValue(TARGET_CACHE_KEY, null)
      if (!cached) return null

      const data = typeof cached === 'string' ? JSON.parse(cached) : cached
      if (Date.now() - data.timestamp > TARGET_CACHE_TTL) {
        platform.removeValue(TARGET_CACHE_KEY)
        return null
      }

      return data.targets
    } catch {
      return null
    }
  }

  function setCachedTargets(targets) {
    try {
      platform.setValue(TARGET_CACHE_KEY, JSON.stringify({
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
      const token = platform.getValue(TOKEN_STORAGE_KEY, null)
      if (token && !isTokenExpired(token)) {
        return token
      }
      clearStoredToken()
    } catch {
      // Ignore storage errors
    }
    return null
  }

  function storeToken(token) {
    try {
      platform.setValue(TOKEN_STORAGE_KEY, token)
      return true
    } catch {
      return false
    }
  }

  function clearStoredToken() {
    try {
      platform.removeValue(TOKEN_STORAGE_KEY)
    } catch {
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
   * AUTHENTICATION FLOW
   **********************/

  async function login() {
    const apiKey = platform.getApiKey()
    if (!apiKey) {
      throw new Error('API key not configured')
    }

    const res = await platform.fetch(
      'POST',
      `${API_BASE}/auth/login`,
      { 'Content-Type': 'application/json' },
      JSON.stringify({ apikey: apiKey })
    )

    const json = JSON.parse(res.responseText)
    return json.token
  }

  function updateCurrentUserFromJwt(token) {
    const claims = parseJwtClaims(token)
    if (!claims) return false

    currentUsername = claims['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'] || null
    currentUserId = claims['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier'] || null
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
        const negotiateRes = await platform.fetch(
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
        await platform.fetch(
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
      const negotiateRes = await platform.fetch(
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
      await platform.fetch(
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
      const res = await platform.fetch(
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
          if (e.message.includes('HTTP 404') || e.message.includes('Network error')) {
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
              this.reconnectAttempts++
              const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000)

              await new Promise(resolve => setTimeout(resolve, delay))

              if (this.running !== false) {
                try {
                  await this.reconnect()
                  await setupConnection()
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

      return new Promise((resolve, reject) => {
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

        platform.fetch(
          'POST',
          `${this.hubUrl}?id=${encodeURIComponent(this.connectionToken)}`,
          {
            'Content-Type': 'text/plain;charset=UTF-8',
            Authorization: `Bearer ${this.accessToken}`,
          },
          payload
        ).catch((e) => {
          clearTimeout(timeoutId)
          this.pendingCalls.delete(invocationId)
          reject(e)
        })
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
        await platform.fetch(
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

      if (this.connectionToken) {
        platform.fetch('DELETE', `${this.hubUrl}?id=${encodeURIComponent(this.connectionToken)}`, {
          Authorization: `Bearer ${this.accessToken}`,
        }).catch(() => {
          // Ignore errors on close
        })
      }
    }
  }

  /**********************
   * TOAST UI - CSS
   **********************/

  const baseCSS = `
    .wr-toast-container {
      position: fixed;
      display: flex;
      gap: 10px;
      z-index: 99999;
      pointer-events: none;
    }

    .wr-toast-container.bottom-left {
      left: ${platform.isPda ? '10px' : '20px'};
      bottom: ${platform.isPda ? '40px' : '70px'};
      flex-direction: column-reverse;
    }

    .wr-toast-container.bottom-right {
      right: ${platform.isPda ? '10px' : '20px'};
      bottom: ${platform.isPda ? '40px' : '70px'};
      flex-direction: column-reverse;
    }

    .wr-toast-container.top-left {
      left: ${platform.isPda ? '10px' : '20px'};
      top: ${platform.isPda ? '40px' : '70px'};
      flex-direction: column;
    }

    .wr-toast-container.top-right {
      right: ${platform.isPda ? '10px' : '20px'};
      top: ${platform.isPda ? '40px' : '70px'};
      flex-direction: column;
    }

    .wr-toast {
      background: rgba(30, 30, 50, ${platform.isPda ? '0.98' : '0.95'});
      backdrop-filter: blur(${platform.isPda ? '10px' : '20px'});
      border: 1px solid rgba(155, 89, 182, 0.3);
      border-radius: ${platform.isPda ? '12px' : '0.75rem'};
      padding: ${platform.isPda ? '12px' : '0.75rem'};
      box-shadow: 0 ${platform.isPda ? '4px 20px' : '6px 20px'} rgba(0, 0, 0, ${platform.isPda ? '0.5' : '0.4'});
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #fff;
      animation: wr-slidein 0.3s ease;
      min-width: 280px;
      max-width: ${platform.isPda ? 'calc(100vw - 20px)' : '320px'};
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
      align-items: ${platform.isPda ? 'center' : 'flex-start'};
      ${platform.isPda ? 'margin-bottom: 10px;' : 'gap: 0.5rem; margin-bottom: 0.5rem;'}
    }

    .wr-toast-title {
      font-size: ${platform.isPda ? '14px' : '0.9rem'};
      font-weight: 600;
      color: #fff;
    }

    .wr-toast-close {
      background: rgba(255, 255, 255, 0.1);
      border: none;
      color: #888;
      cursor: pointer;
      padding: ${platform.isPda ? '4px 8px' : '0.2rem 0.4rem'};
      border-radius: ${platform.isPda ? '4px' : '0.25rem'};
      font-size: ${platform.isPda ? '18px' : '1rem'};
      line-height: 1;
      transition: all 0.2s;
      ${platform.isPda ? 'min-width: 32px; min-height: 32px;' : ''}
    }

    .wr-toast-close:active {
      background: rgba(255, 255, 255, 0.2);
      color: #fff;
    }

    .wr-toast-message {
      color: #aaa;
      font-size: ${platform.isPda ? '13px' : '0.8rem'};
      ${platform.isPda ? 'line-height: 1.4;' : ''}
    }

    .wr-attack-card {
      display: flex;
      flex-direction: column;
      gap: ${platform.isPda ? '10px' : '0.5rem'};
    }

    .wr-attack-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: ${platform.isPda ? '8px' : '0.5rem'};
    }

    .wr-target-section {
      display: flex;
      align-items: baseline;
      gap: ${platform.isPda ? '6px' : '0.3rem'};
      min-width: 0;
      flex: 1;
    }

    .wr-target-name {
      color: #fff;
      font-size: ${platform.isPda ? '16px' : '1rem'};
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .wr-target-id {
      color: #666;
      font-size: ${platform.isPda ? '12px' : '0.75rem'};
      flex-shrink: 0;
    }

    .wr-status-badge {
      font-size: ${platform.isPda ? '10px' : '0.65rem'};
      font-weight: 600;
      padding: ${platform.isPda ? '4px 8px' : '0.2rem 0.4rem'};
      border-radius: ${platform.isPda ? '4px' : '0.25rem'};
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
      padding: ${platform.isPda ? '8px 0' : '0.4rem 0'};
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }

    .wr-timer-section {
      display: flex;
      align-items: center;
      gap: ${platform.isPda ? '6px' : '0.4rem'};
      color: #ccc;
    }

    .wr-timer-icon {
      opacity: 0.7;
      ${platform.isPda ? 'flex-shrink: 0;' : ''}
    }

    .wr-timer-value {
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: ${platform.isPda ? '18px' : '1.1rem'};
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
      font-size: ${platform.isPda ? '16px' : '1rem'};
      font-weight: 600;
    }

    .wr-slots-value .filled { color: #2ecc71; }
    .wr-slots-value .separator { color: #555; margin: 0 2px; }
    .wr-slots-value .total { color: #888; }

    .wr-slots-label {
      color: #666;
      font-size: ${platform.isPda ? '10px' : '0.65rem'};
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .wr-participants {
      display: flex;
      flex-wrap: wrap;
      gap: ${platform.isPda ? '6px' : '0.3rem'};
    }

    .wr-participant {
      background: rgba(155, 89, 182, 0.15);
      color: #b388d9;
      font-size: ${platform.isPda ? '12px' : '0.75rem'};
      padding: ${platform.isPda ? '4px 8px' : '0.15rem 0.4rem'};
      border-radius: ${platform.isPda ? '4px' : '0.25rem'};
      white-space: nowrap;
      max-width: ${platform.isPda ? '120px' : '100px'};
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .wr-actions {
      display: flex;
      gap: ${platform.isPda ? '8px' : '0.5rem'};
      margin-top: ${platform.isPda ? '4px' : '0.25rem'};
    }

    .wr-btn {
      display: inline-flex;
      align-items: center;
      ${platform.isPda ? 'justify-content: center;' : ''}
      gap: ${platform.isPda ? '6px' : '0.3rem'};
      padding: ${platform.isPda ? '10px 14px' : '0.35rem 0.6rem'};
      border-radius: ${platform.isPda ? '8px' : '0.35rem'};
      border: 1px solid rgba(255, 255, 255, 0.15);
      background: rgba(255, 255, 255, 0.05);
      color: #aaa;
      cursor: pointer;
      font-size: ${platform.isPda ? '13px' : '0.75rem'};
      font-weight: 500;
      transition: all 0.2s ease;
      ${platform.isPda ? 'flex: 1; min-height: 44px;' : ''}
    }

    .wr-btn:active {
      background: rgba(255, 255, 255, 0.15);
      ${platform.isPda ? 'transform: scale(0.95);' : ''}
    }

    .wr-btn-join {
      background: rgba(46, 204, 113, ${platform.isPda ? '0.15' : '0.1'});
      border-color: rgba(46, 204, 113, 0.3);
      color: #2ecc71;
    }

    .wr-btn-join:active {
      background: rgba(46, 204, 113, ${platform.isPda ? '0.25' : '0.2'});
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
      ${platform.isPda ? '' : 'gap: 0.5rem;'}
      color: #666;
      font-size: ${platform.isPda ? '11px' : '0.7rem'};
      margin-top: ${platform.isPda ? '4px' : '0.25rem'};
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
      ${platform.isPda ? 'min-width: 44px; min-height: 44px;' : ''}
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
      ${platform.isPda ? 'min-height: 44px;' : ''}
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
      ${platform.isPda ? 'min-height: 44px;' : ''}
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
      ${platform.isPda ? 'min-height: 44px;' : ''}
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
      align-items: center;
      gap: ${platform.isPda ? '0.25rem 1rem' : '0.5rem 1rem'};
    }

    .wr-rw-limits-footer {
      ${platform.isPda ? 'width: 100%;' : ''}
      display: flex;
      align-items: center;
      ${platform.isPda ? 'margin-top: 0.25rem;' : ''}
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
      padding: ${platform.isPda ? '4px' : '2px'};
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

  // Button styles differ significantly between PDA and desktop
  const buttonCSS = platform.isPda ? `
    /* PDA button base */
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

    .wr-settings-btn {
      left: 160px;
      border: 1px solid rgba(155, 89, 182, 0.4);
      color: #9b59b6;
    }

    .wr-settings-btn:active {
      background: rgba(155, 89, 182, 0.2);
      border-color: #9b59b6;
      transform: scale(0.95);
    }

    .wr-feed-toggle-btn {
      left: 120px;
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
  ` : `
    /* Desktop button base */
    .wr-settings-btn,
    .wr-feed-toggle-btn,
    .wr-attack-btn {
      position: fixed;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: rgba(30, 30, 50, 0.9);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000001;
      transition: all 0.2s ease;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }

    .wr-settings-btn {
      border: 1px solid rgba(155, 89, 182, 0.4);
      color: #9b59b6;
    }

    .wr-settings-btn:hover {
      background: rgba(155, 89, 182, 0.2);
      border-color: #9b59b6;
      transform: scale(1.1);
    }

    .wr-feed-toggle-btn {
      border: 1px solid rgba(155, 89, 182, 0.4);
      color: #9b59b6;
    }

    .wr-feed-toggle-btn:hover {
      background: rgba(155, 89, 182, 0.2);
      border-color: #9b59b6;
      transform: scale(1.1);
    }

    .wr-feed-toggle-btn.disabled {
      background: rgba(30, 30, 50, 0.9);
      border-color: rgba(231, 76, 60, 0.4);
      color: #e74c3c;
    }

    .wr-feed-toggle-btn.disabled:hover {
      background: rgba(231, 76, 60, 0.2);
      border-color: #e74c3c;
    }

    .wr-feed-toggle-btn.connecting {
      background: rgba(30, 30, 50, 0.9);
      border-color: rgba(243, 156, 18, 0.6);
      color: #f39c12;
      animation: wr-pulse-connecting 1.5s infinite;
    }

    @keyframes wr-pulse-connecting {
      0%, 100% {
        opacity: 1;
        border-color: rgba(243, 156, 18, 0.6);
      }
      50% {
        opacity: 0.7;
        border-color: rgba(243, 156, 18, 1);
      }
    }

    .wr-attack-btn {
      border: 1px solid rgba(46, 204, 113, 0.4);
      color: #2ecc71;
    }

    .wr-attack-btn:hover {
      background: rgba(46, 204, 113, 0.2);
      border-color: #2ecc71;
      transform: scale(1.1);
    }

    /* Button positions - bottom-left */
    .wr-feed-toggle-btn.bottom-left { left: 20px; bottom: 20px; }
    .wr-settings-btn.bottom-left { left: 66px; bottom: 20px; }
    .wr-attack-btn.bottom-left { left: 112px; bottom: 20px; }

    /* Button positions - bottom-right */
    .wr-feed-toggle-btn.bottom-right { right: 20px; bottom: 20px; }
    .wr-settings-btn.bottom-right { right: 66px; bottom: 20px; }
    .wr-attack-btn.bottom-right { right: 112px; bottom: 20px; }

    /* Button positions - top-left */
    .wr-feed-toggle-btn.top-left { left: 20px; top: 20px; }
    .wr-settings-btn.top-left { left: 66px; top: 20px; }
    .wr-attack-btn.top-left { left: 112px; top: 20px; }

    /* Button positions - top-right */
    .wr-feed-toggle-btn.top-right { right: 20px; top: 20px; }
    .wr-settings-btn.top-right { right: 66px; top: 20px; }
    .wr-attack-btn.top-right { right: 112px; top: 20px; }

    /* Refresh button on desktop */
    .wr-refresh-btn {
      position: fixed;
      left: 20px;
      bottom: 20px;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: rgba(30, 30, 50, 0.9);
      border: 1px solid rgba(155, 89, 182, 0.4);
      color: #9b59b6;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 99998;
      transition: all 0.2s ease;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }

    .wr-refresh-btn:hover {
      background: rgba(155, 89, 182, 0.2);
      border-color: #9b59b6;
      transform: scale(1.1);
    }

    .wr-refresh-btn.loading {
      pointer-events: none;
      opacity: 0.7;
    }

    .wr-refresh-btn.loading svg {
      animation: wr-spin 1s linear infinite;
    }
  `

  // Desktop-only hover styles for non-PDA
  const hoverCSS = platform.isPda ? '' : `
    .wr-toast-close:hover {
      background: rgba(255, 255, 255, 0.2);
      color: #fff;
    }

    .wr-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      transform: translateY(-1px);
    }

    .wr-btn-join:hover {
      background: rgba(46, 204, 113, 0.2);
      border-color: #2ecc71;
      box-shadow: 0 2px 8px rgba(46, 204, 113, 0.3);
    }

    .wr-btn-attack:hover {
      box-shadow: 0 4px 12px rgba(231, 76, 60, 0.4);
    }

    .wr-modal-close:hover {
      background: rgba(255, 255, 255, 0.2);
      color: #fff;
    }

    .wr-setting-toggle:hover {
      background: rgba(255, 255, 255, 0.06);
    }

    .wr-btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(155, 89, 182, 0.4);
    }

    .wr-btn-secondary:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }

    .wr-rw-refresh-btn:hover {
      transform: scale(1.1);
    }
  `

  platform.addStyle(baseCSS + buttonCSS + hoverCSS)

  /**********************
   * TOAST SYSTEM
   **********************/

  // Create toast container
  const toastContainer = document.createElement('div')
  toastContainer.className = `wr-toast-container ${SETTINGS.toastPosition}`
  document.body.appendChild(toastContainer)

  const activeToasts = new Map()

  function createToast(id, content, type = 'info', duration = 20000) {
    if (!toastContainer) return null

    const existingToast = activeToasts.get(id)
    if (existingToast) {
      existingToast.element.innerHTML = content

      const closeBtn = existingToast.element.querySelector('.wr-toast-close')
      if (closeBtn) {
        closeBtn.addEventListener('click', () => removeToast(id))
      }

      return existingToast.element
    }

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
    createToast(id, content, type, platform.isPda ? 3000 : 2000)
  }

  /**********************
   * ATTACK TOAST RENDERING
   **********************/

  function showAttackToast(attack, eventType = 'Added') {
    const id = 'attack-' + attack.id

    if (attack.isDone) {
      removeToast(id)
      return
    }

    if (attack.expiration) {
      const now = new Date()
      const expiration = new Date(attack.expiration)
      if (expiration <= now) {
        removeToast(id)
        return
      }
    }

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

    const isUserInAttackers = attack.attackers && attack.attackers.includes(currentUsername)
    const isUserCreator = attack.createdBy === currentUsername
    const attackLink = attack.link || (attack.userId ? `https://www.torn.com/loader.php?sid=attack&user2ID=${attack.userId}` : null)

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

    const toastEl = createToast(id, content, 'attack', 0)
    if (!toastEl) return

    // Setup timer countdown
    const timerSection = toastEl.querySelector('.wr-timer-section')
    const timerValue = toastEl.querySelector('.wr-timer-value')
    if (timerSection && timerValue && attack.expiration) {
      const toastData = activeToasts.get(id)
      if (toastData && toastData.intervalId) {
        clearInterval(toastData.intervalId)
      }

      const urgentThreshold = SETTINGS.urgentThresholdMinutes ?? 1

      const updateTimer = () => {
        const now = new Date()
        const expiration = new Date(attack.expiration)
        const diff = expiration.getTime() - now.getTime()

        if (diff <= 0) {
          timerValue.textContent = 'Expired'
          timerSection.classList.remove('urgent')
          setTimeout(() => removeToast(id), 2000)
          return false
        }

        const minutes = Math.floor(diff / 60000)
        const seconds = Math.floor((diff % 60000) / 1000)
        timerValue.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`

        if (minutes < urgentThreshold) {
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

      if (toastData) {
        toastData.intervalId = intervalId
      }
    }

    // Setup button handlers
    const attackBtn = toastEl.querySelector('.wr-btn-attack')
    if (attackBtn) {
      attackBtn.addEventListener('click', () => {
        const url = attackBtn.dataset.url
        if (url) platform.openUrl(url)
      })
    }

    const joinBtn = toastEl.querySelector('.wr-btn-join')
    if (joinBtn) {
      joinBtn.addEventListener('click', async () => {
        const attackId = joinBtn.dataset.attackId
        try {
          await platform.fetch(
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
          await platform.fetch(
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
    const attack = event.attack || event
    if (!attack) return

    let eventType = event.eventType ?? 'Added'
    if (typeof eventType === 'number') {
      eventType = ['Added', 'Updated', 'Done'][eventType] || 'Unknown'
    }

    const id = 'attack-' + attack.id

    if (eventType === 'Done' || eventType === 'Removed' || attack.isDone) {
      removeToast(id)
      return
    }

    if (SETTINGS.autoHideFullAttacks && attack.isFull && attack.link == null) {
      removeToast(id)
      return
    }

    // Play sound for new attacks
    if (eventType === 'Added' && SETTINGS.soundEnabled) {
      platform.playNotificationSound()
    }

    showAttackToast(attack, eventType)
  }

  function handleWarRoomAttacks(data) {
    if (data.attacks && Array.isArray(data.attacks)) {
      const now = new Date()
      for (const attack of data.attacks) {
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
    const urlParams = new URLSearchParams(window.location.search)
    const user2ID = urlParams.get('user2ID')

    let detectedTarget = null

    if (user2ID) {
      async function checkIfUserIsTarget() {
        try {
          let allTargets = getCachedTargets()

          if (!allTargets) {
            const authenticated = await ensureAuthenticated()
            if (!authenticated) return

            const targetsRes = await platform.fetch(
              'GET',
              `${API_BASE}/warrooms/targets`,
              {
                'Authorization': `Bearer ${jwt}`,
              }
            )
            const warRoomTargetsData = JSON.parse(targetsRes.responseText)

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

            setCachedTargets(allTargets)
          }

          const targetMatch = allTargets.find(t => String(t.userId) === String(user2ID))

          if (targetMatch) {
            detectedTarget = targetMatch
            showCoordinatedAttackButton()
          }
        } catch {
          // Ignore errors checking war targets
        }
      }

      function showCoordinatedAttackButton() {
        const attackBtn = document.createElement('button')
        attackBtn.className = platform.isPda
          ? 'wr-attack-btn'
          : `wr-attack-btn ${SETTINGS.buttonPosition}`
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

      function showAttackDialog() {
        if (!detectedTarget) return

        const overlay = document.createElement('div')
        overlay.className = 'wr-modal-overlay'

        const modal = document.createElement('div')
        modal.className = 'wr-modal'
        modal.innerHTML = `
          <div class="wr-modal-header">
            <h2 class="wr-modal-title">Create Coordinated Attack</h2>
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

        modal.querySelector('.wr-modal-close').addEventListener('click', () => {
          overlay.remove()
        })

        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) {
            overlay.remove()
          }
        })

        modal.querySelector('#wr-cancel').addEventListener('click', () => {
          overlay.remove()
        })

        const toggleWaitFull = modal.querySelector('#wr-toggle-waitfull')
        toggleWaitFull.addEventListener('click', () => {
          const sw = toggleWaitFull.querySelector('.wr-toggle-switch')
          sw.classList.toggle('active')
        })

        modal.querySelector('#wr-create').addEventListener('click', async () => {
          const numberOfPeopleNeeded = parseInt(modal.querySelector('#wr-people-needed').value) || 4
          const expirationInMinutes = parseInt(modal.querySelector('#wr-expiration').value) || 5
          const shouldWaitUntilFullToShowLink = toggleWaitFull.querySelector('.wr-toggle-switch').classList.contains('active')

          if (numberOfPeopleNeeded < 1 || numberOfPeopleNeeded > 30) {
            toast('Number of people must be between 1 and 30', 'error')
            return
          }

          if (expirationInMinutes < 1 || expirationInMinutes > 15) {
            toast('Expiration must be between 1 and 15 minutes', 'error')
            return
          }

          try {
            await platform.fetch(
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

      checkIfUserIsTarget()
    }
  }

  /**********************
   * SIGNALR CONNECTION MANAGEMENT
   **********************/

  async function setupConnection() {
    await connection.send('SetDisplayName', platform.displayName)

    await new Promise(resolve => setTimeout(resolve, 100))

    if (!connection.running) {
      throw new Error('Connection was closed by server')
    }

    const warRooms = await connection.invoke('GetWarRooms')
    if (warRooms && Array.isArray(warRooms)) {
      warRoomIds = warRooms.map((wr) => wr.warRoomId || wr.id)

      for (const warRoomId of warRoomIds) {
        try {
          await connection.invoke('GetAttacks', warRoomId)
        } catch {
          // Ignore fetch errors
        }
      }
    }
  }

  async function connectToWarRoom() {
    try {
      const authenticated = await ensureAuthenticated()
      if (!authenticated) return

      if (!connection) {
        connection = new SignalRLongPollingConnection(HUB_URL, jwt)

        connection.on('AttackUpdate', handleAttackUpdate)
        connection.on('WarRoomAttacks', handleWarRoomAttacks)
        connection.on('ReceiveMessage', handleReceiveMessage)
      }

      if (!connection.running) {
        await connection.start()
        await setupConnection()

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

  /**********************
   * RANKED WAR STATS DISPLAY
   **********************/

  const isFactionsPage = window.location.pathname.includes('/factions.php')

  let rankedWarStatsCache = null
  let rankedWarStatsCacheExpiry = 0
  let rankedWarAutoRefreshTimeout = null
  let rankedWarAutoRefreshEnabled = true

  async function triggerRankedWarUIRefresh(isAutoRefresh = false) {
    log('RankedWar', `UI refresh triggered (${isAutoRefresh ? 'auto' : 'manual'})`)

    rankedWarStatsCache = null
    rankedWarStatsCacheExpiry = 0

    if (!isAutoRefresh && rankedWarAutoRefreshTimeout) {
      clearTimeout(rankedWarAutoRefreshTimeout)
      rankedWarAutoRefreshTimeout = null
    }

    document.querySelectorAll('.wr-rw-stats-container').forEach(el => el.remove())
    document.querySelectorAll('.your-faction .points').forEach(el => {
      el.style.color = ''
      el.style.fontWeight = ''
    })

    await enhanceRankedWarPage()
  }

  async function fetchRankedWarStats() {
    if (!jwt) {
      log('RankedWar', 'No JWT token available')
      return null
    }

    const now = Date.now()
    if (rankedWarStatsCache && now < rankedWarStatsCacheExpiry) {
      log('RankedWar', `Using cached stats (expires in ${Math.round((rankedWarStatsCacheExpiry - now) / 1000)}s)`)
      return rankedWarStatsCache
    }

    try {
      log('RankedWar', 'Fetching fresh stats from API')
      const res = await platform.fetch('GET', `${API_BASE}/rankedwars/last`, {
        'Authorization': `Bearer ${jwt}`
      })
      rankedWarStatsCache = JSON.parse(res.responseText)

      const maxCacheMs = 60 * 60 * 1000

      if (rankedWarStatsCache.nextUpdate) {
        const nextUpdateTime = new Date(rankedWarStatsCache.nextUpdate).getTime()
        rankedWarStatsCacheExpiry = Math.min(nextUpdateTime, Date.now() + maxCacheMs)

        if (rankedWarAutoRefreshEnabled && isFactionsPage && window.location.search.includes('step=your')) {
          if (rankedWarAutoRefreshTimeout) {
            clearTimeout(rankedWarAutoRefreshTimeout)
          }
          let refreshDelay = nextUpdateTime - Date.now() + 1000

          if (refreshDelay <= 0) {
            refreshDelay = 2000
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
          }
        }
      } else {
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

  function checkRankedWarCompliance(member, limits) {
    if (!limits) return { hits: 'neutral', total: 'neutral', avg: 'neutral' }

    const result = { hits: 'neutral', total: 'neutral', avg: 'neutral' }
    const nbWarHits = member.nbWarHits ?? 0
    const totalRespect = member.totalRespect ?? 0
    const averageRespect = member.averageRespect ?? 0

    if (limits.minHits != null && nbWarHits < limits.minHits) {
      result.hits = 'non-compliant'
    } else if (limits.maxHits != null && nbWarHits > limits.maxHits) {
      result.hits = 'non-compliant'
    } else if (limits.minHits != null || limits.maxHits != null) {
      result.hits = 'compliant'
    }

    if (limits.minTotalRespect != null && totalRespect < limits.minTotalRespect) {
      result.total = 'non-compliant'
    } else if (limits.maxTotalRespect != null && totalRespect > limits.maxTotalRespect) {
      result.total = 'non-compliant'
    } else if (limits.minTotalRespect != null || limits.maxTotalRespect != null) {
      result.total = 'compliant'
    }

    if (limits.averageRespectGoal != null && nbWarHits > 0 && averageRespect < limits.averageRespectGoal) {
      result.avg = 'non-compliant'
    } else if (limits.averageRespectGoal != null && nbWarHits > 0) {
      result.avg = 'compliant'
    }

    return result
  }

  function formatRelativeTime(dateString) {
    if (!dateString) return null

    const normalizedDateString = dateString.replace(/\.(\d{3})\d+Z$/, '.$1Z')
    const date = new Date(normalizedDateString)
    if (isNaN(date.getTime())) return null

    const now = new Date()
    const absDiffMs = Math.abs(now.getTime() - date.getTime())

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

  function updateLimitsDisplay(container, limits, lastUpdated, onRefresh, members) {
    if (!container) return

    container._lastLimits = limits
    container._lastUpdated = lastUpdated
    container._lastMembers = members

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
    const updatedHtml = relativeTime ? `<div class="wr-rw-limits-footer"><span class="wr-rw-limits-updated">Last data update: ${escapeHtml(relativeTime)}</span>${refreshBtnHtml}</div>` : ''

    let myStatsHtml = ''
    if (members && currentUserId) {
      const myMember = members.find(m => String(m.id) === String(currentUserId))
      if (myMember) {
        const myHits = myMember.nbWarHits ?? 0
        const myAvgRespect = myMember.averageRespect ?? 0
        const myCompliance = checkRankedWarCompliance(myMember, limits)
        myStatsHtml = `<div class="wr-rw-limits-content"><span class="wr-rw-limits-title">My Hits:</span><span class="wr-rw-stat ${escapeHtml(myCompliance.hits)}" style="margin-left: 0.5rem;"><span class="wr-rw-stat-label">Hits: </span>${escapeHtml(String(myHits))}</span><span class="wr-rw-stat ${escapeHtml(myCompliance.avg)}"><span class="wr-rw-stat-label">Avg Respect: </span>${escapeHtml(myAvgRespect.toFixed(2))}</span></div>`
      }
    }

    if (!limits) {
      container.innerHTML = `<div class="wr-rw-limits-content"><span class="wr-rw-limits-title">Limits:</span><span class="wr-rw-limits-label">No active limits</span></div>${myStatsHtml}${updatedHtml}`
    } else {
      const items = []

      if (limits.minHits != null || limits.maxHits != null) {
        const hitsText = limits.minHits != null && limits.maxHits != null
          ? `${limits.minHits}-${limits.maxHits}`
          : limits.minHits != null
            ? `\u2265${limits.minHits}`
            : `\u2264${limits.maxHits}`
        items.push(`<span class="wr-rw-limits-item"><span class="wr-rw-limits-label">Number of Hits: </span><span class="wr-rw-limits-value">${escapeHtml(hitsText)}</span></span>`)
      }

      if (limits.minTotalRespect != null || limits.maxTotalRespect != null) {
        const totalText = limits.minTotalRespect != null && limits.maxTotalRespect != null
          ? `${limits.minTotalRespect.toFixed(1)}-${limits.maxTotalRespect.toFixed(1)}`
          : limits.minTotalRespect != null
            ? `\u2265${limits.minTotalRespect.toFixed(1)}`
            : `\u2264${limits.maxTotalRespect.toFixed(1)}`
        items.push(`<span class="wr-rw-limits-item"><span class="wr-rw-limits-label">Total Respect: </span><span class="wr-rw-limits-value">${escapeHtml(totalText)}</span></span>`)
      }

      if (limits.averageRespectGoal != null) {
        items.push(`<span class="wr-rw-limits-item"><span class="wr-rw-limits-label">Average Respect: </span><span class="wr-rw-limits-value">\u2265${escapeHtml(limits.averageRespectGoal.toFixed(2))}</span></span>`)
      }

      container.innerHTML = `<div class="wr-rw-limits-content"><span class="wr-rw-limits-title">Limits:</span>${items.length > 0 ? items.join('') : '<span class="wr-rw-limits-label">None defined</span>'}</div>${myStatsHtml}${updatedHtml}`
    }

    if (onRefresh) {
      const refreshBtn = container.querySelector('.wr-rw-refresh-btn')
      if (refreshBtn) {
        container._onRefresh = onRefresh

        refreshBtn.addEventListener('click', async (e) => {
          if (container._isRefreshing) {
            log('RankedWar', 'Refresh already in progress, ignoring click')
            return
          }

          e.preventDefault()
          e.stopPropagation()

          if (document.activeElement) {
            document.activeElement.blur()
          }
          refreshBtn.blur()

          if (rankedWarAutoRefreshEnabled) {
            rankedWarAutoRefreshEnabled = false
            if (rankedWarAutoRefreshTimeout) {
              clearTimeout(rankedWarAutoRefreshTimeout)
              rankedWarAutoRefreshTimeout = null
            }
            log('RankedWar', 'Auto-refresh disabled')
            toast('Auto-refresh disabled', 'info')
            updateLimitsDisplay(container, container._lastLimits, container._lastUpdated, container._onRefresh, container._lastMembers)
          } else {
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
            }
          }
        })
      }
    }

    if (lastUpdated) {
      const updateInterval = setInterval(() => {
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

      container._limitsUpdateInterval = updateInterval
    }
  }

  function createLimitsDisplay(limits, lastUpdated, onRefresh, members) {
    const container = document.createElement('div')
    container.className = 'wr-rw-limits'
    updateLimitsDisplay(container, limits, lastUpdated, onRefresh, members)
    return container
  }

  function addStatsToMemberRow(row, member, limits) {
    if (row.querySelector('.wr-rw-stats-container')) return

    const compliance = checkRankedWarCompliance(member, limits)
    const nbWarHits = member.nbWarHits ?? 0
    const averageRespect = member.averageRespect ?? 0

    const pointsEl = row.querySelector('.points')
    if (pointsEl) {
      if (compliance.total === 'compliant') {
        pointsEl.style.color = '#2ecc71'
      } else if (compliance.total === 'non-compliant') {
        pointsEl.style.color = '#e74c3c'
        pointsEl.style.fontWeight = '600'
      }
    }

    const statsContainer = document.createElement('div')
    statsContainer.className = 'wr-rw-stats-container'
    statsContainer.innerHTML = `
      <span class="wr-rw-stat ${escapeHtml(compliance.hits)}"><span class="wr-rw-stat-label">Number of Hits:</span>${escapeHtml(String(nbWarHits))}</span>
      <span class="wr-rw-stat ${escapeHtml(compliance.avg)}"><span class="wr-rw-stat-label">Average Respect:</span>${escapeHtml(averageRespect.toFixed(2))}</span>
    `

    row.appendChild(statsContainer)
  }

  function extractUsernameFromRow(row) {
    const honorText = row.querySelector('.honor-text:not(.honor-text-svg)')
    if (honorText) {
      return honorText.textContent.trim()
    }

    const statusEl = row.querySelector('[aria-label*="User "]')
    if (statusEl) {
      const match = statusEl.getAttribute('aria-label').match(/User (\S+)/)
      if (match) return match[1]
    }

    return null
  }

  async function enhanceRankedWarPage() {
    const factionWarList = document.getElementById('faction_war_list_id')
    if (!factionWarList) return

    const authenticated = await ensureAuthenticated()
    if (!authenticated) {
      log('RankedWar', 'Not authenticated, cannot fetch stats')
      return
    }

    const statsData = await fetchRankedWarStats()
    if (!statsData) {
      log('RankedWar', 'No stats data returned from API')
      return
    }

    const membersByName = new Map()
    if (statsData.members) {
      for (const member of statsData.members) {
        membersByName.set(member.name.toLowerCase(), member)
      }
    }
    log('RankedWar', `Loaded ${membersByName.size} members, limits:`, statsData.currentLimit)

    const yourFactionSection = document.querySelector('.your-faction')
    if (!yourFactionSection) {
      log('RankedWar', 'Could not find .your-faction section')
      return
    }

    const refreshStats = async () => {
      log('RankedWar', 'Manual refresh triggered')
      await triggerRankedWarUIRefresh()
    }

    const factionWarInfo = document.querySelector('.faction-war-info')
    let limitsDisplay = document.querySelector('.wr-rw-limits')

    if (factionWarInfo) {
      if (!limitsDisplay) {
        log('RankedWar', 'Creating limits display')
        limitsDisplay = createLimitsDisplay(statsData.currentLimit, statsData.lastUpdated, refreshStats, statsData.members)
        factionWarInfo.parentNode.insertBefore(limitsDisplay, factionWarInfo.nextSibling)
      } else {
        log('RankedWar', 'Updating existing limits display')
        updateLimitsDisplay(limitsDisplay, statsData.currentLimit, statsData.lastUpdated, refreshStats, statsData.members)
      }
    }

    if (SETTINGS.showMemberStatsOnRankedWar) {
      const memberRows = yourFactionSection.querySelectorAll('li.your')
      log('RankedWar', `Found ${memberRows.length} member rows to enhance`)

      for (const row of memberRows) {
        const username = extractUsernameFromRow(row)
        if (!username) continue

        const memberData = membersByName.get(username.toLowerCase()) || {
          name: username,
          nbWarHits: 0,
          totalRespect: 0,
          averageRespect: 0
        }

        addStatsToMemberRow(row, memberData, statsData.currentLimit)
      }
    }
    log('RankedWar', 'Enhancement complete')
  }

  // Initialize ranked war enhancement with MutationObserver
  if (isFactionsPage && window.location.search.includes('step=your')) {
    let rankedWarEnhancementInProgress = null
    let rankedWarObserver = null

    function tryEnhanceRankedWar() {
      const factionWarList = document.getElementById('faction_war_list_id')
      if (!factionWarList || !window.location.hash.includes('/war/rank')) {
        return Promise.resolve(false)
      }

      if (rankedWarEnhancementInProgress) {
        return rankedWarEnhancementInProgress
      }

      if (rankedWarObserver) {
        rankedWarObserver.disconnect()
        rankedWarObserver = null
      }

      const enhancePromise = (async () => {
        try {
          await enhanceRankedWarPage()
          return true
        } catch (err) {
          log('RankedWar', 'Enhancement failed:', err)
          rankedWarEnhancementInProgress = null
          return false
        }
      })()

      rankedWarEnhancementInProgress = enhancePromise
      return enhancePromise
    }

    function setupRankedWarObserver() {
      if (rankedWarObserver) return

      rankedWarObserver = new MutationObserver(() => {
        tryEnhanceRankedWar()
      })

      rankedWarObserver.observe(document.body, { childList: true, subtree: true })
    }

    window.addEventListener('hashchange', () => {
      if (window.location.hash.includes('/war/rank')) {
        rankedWarEnhancementInProgress = null
        setTimeout(() => {
          tryEnhanceRankedWar().then(success => {
            if (!success) {
              setupRankedWarObserver()
            }
          })
        }, 500)
      }
    })

    if (window.location.hash.includes('/war/rank')) {
      tryEnhanceRankedWar().then(success => {
        if (!success) {
          setupRankedWarObserver()
          setTimeout(tryEnhanceRankedWar, 1000)
        }
      })
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

    // Build settings fields conditionally
    const apiKeyField = !platform.isPda ? `
      <div class="wr-setting-group">
        <label class="wr-setting-label">API Key</label>
        <input type="text" class="wr-setting-input" id="wr-apikey" value="${escapeHtml(SETTINGS.apiKey)}" placeholder="Enter your WarRoom API key">
        <div class="wr-setting-desc">Required for authentication. Get yours from torn.zzcraft.net</div>
      </div>
    ` : ''

    const loaderFeedField = !platform.isPda ? `
      <div class="wr-setting-group">
        <div class="wr-setting-toggle" id="wr-toggle-loader">
          <span class="wr-toggle-label">Attack Feed on Attack Page</span>
          <div class="wr-toggle-switch ${SETTINGS.attackFeedOnLoaderPage ? 'active' : ''}">
            <div class="wr-toggle-slider"></div>
          </div>
        </div>
        <div class="wr-setting-desc">Show attack feed on loader.php (attack page)</div>
      </div>
    ` : ''

    const soundField = !platform.isPda ? `
      <div class="wr-setting-group">
        <div class="wr-setting-toggle" id="wr-toggle-sound">
          <span class="wr-toggle-label">Sound Notifications</span>
          <div class="wr-toggle-switch ${SETTINGS.soundEnabled ? 'active' : ''}">
            <div class="wr-toggle-slider"></div>
          </div>
        </div>
        <div class="wr-setting-desc">Play sound when new attacks are added</div>
      </div>
    ` : ''

    const buttonPositionField = !platform.isPda ? `
      <div class="wr-setting-group">
        <label class="wr-setting-label">Button Position</label>
        <select class="wr-setting-input" id="wr-button-position">
          <option value="bottom-left" ${SETTINGS.buttonPosition === 'bottom-left' ? 'selected' : ''}>Bottom Left</option>
          <option value="bottom-right" ${SETTINGS.buttonPosition === 'bottom-right' ? 'selected' : ''}>Bottom Right</option>
          <option value="top-left" ${SETTINGS.buttonPosition === 'top-left' ? 'selected' : ''}>Top Left</option>
          <option value="top-right" ${SETTINGS.buttonPosition === 'top-right' ? 'selected' : ''}>Top Right</option>
        </select>
        <div class="wr-setting-desc">Choose where control buttons appear on screen</div>
      </div>
    ` : ''

    const resetButton = !platform.isPda ? `<button class="wr-btn-secondary" id="wr-reset">Reset</button>` : ''

    modal.innerHTML = `
      <div class="wr-modal-header">
        <h2 class="wr-modal-title">WarRoom Settings</h2>
        <button class="wr-modal-close">&times;</button>
      </div>

      ${apiKeyField}

      <div class="wr-setting-group">
        <div class="wr-setting-toggle" id="wr-toggle-feed">
          <span class="wr-toggle-label">${platform.isPda ? 'Attack Feed' : 'Attack Feed On Faction Page'}</span>
          <div class="wr-toggle-switch ${SETTINGS.attackFeedEnabled ? 'active' : ''}">
            <div class="wr-toggle-slider"></div>
          </div>
        </div>
        <div class="wr-setting-desc">${platform.isPda ? 'Enable or disable attack notifications' : 'Show/hide attack notifications on factions page'}</div>
      </div>

      ${loaderFeedField}

      <div class="wr-setting-group">
        <div class="wr-setting-toggle" id="wr-toggle-autohide">
          <span class="wr-toggle-label">Auto-hide Full Attacks</span>
          <div class="wr-toggle-switch ${SETTINGS.autoHideFullAttacks ? 'active' : ''}">
            <div class="wr-toggle-slider"></div>
          </div>
        </div>
        <div class="wr-setting-desc">Automatically hide attacks when they become full</div>
      </div>

      ${soundField}

      <div class="wr-setting-group">
        <div class="wr-setting-toggle" id="wr-toggle-memberstats">
          <span class="wr-toggle-label">Show Member Stats on Ranked War</span>
          <div class="wr-toggle-switch ${SETTINGS.showMemberStatsOnRankedWar ? 'active' : ''}">
            <div class="wr-toggle-slider"></div>
          </div>
        </div>
        <div class="wr-setting-desc">Show hits/avg respect for all members in /war/rank</div>
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

      ${buttonPositionField}

      <div class="wr-modal-footer">
        <button class="wr-btn-secondary" id="wr-clear-cache" ${!platform.isPda ? 'style="flex: 0.8;"' : ''}>Clear Cache</button>
        <button class="wr-btn-secondary" id="wr-clear-token" ${!platform.isPda ? 'style="flex: 0.8;"' : ''}>Clear Token</button>
        ${resetButton}
        <button class="wr-btn-primary" id="wr-save">Save</button>
      </div>
    `

    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    // Close button
    modal.querySelector('.wr-modal-close').addEventListener('click', () => {
      overlay.remove()
    })

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove()
      }
    })

    // Toggle handlers
    const toggleFeed = modal.querySelector('#wr-toggle-feed')
    toggleFeed.addEventListener('click', () => {
      toggleFeed.querySelector('.wr-toggle-switch').classList.toggle('active')
    })

    const toggleAutoHide = modal.querySelector('#wr-toggle-autohide')
    toggleAutoHide.addEventListener('click', () => {
      toggleAutoHide.querySelector('.wr-toggle-switch').classList.toggle('active')
    })

    const toggleMemberStats = modal.querySelector('#wr-toggle-memberstats')
    toggleMemberStats.addEventListener('click', () => {
      toggleMemberStats.querySelector('.wr-toggle-switch').classList.toggle('active')
    })

    // Desktop-only toggles
    const toggleLoader = modal.querySelector('#wr-toggle-loader')
    if (toggleLoader) {
      toggleLoader.addEventListener('click', () => {
        toggleLoader.querySelector('.wr-toggle-switch').classList.toggle('active')
      })
    }

    const toggleSound = modal.querySelector('#wr-toggle-sound')
    if (toggleSound) {
      toggleSound.addEventListener('click', () => {
        toggleSound.querySelector('.wr-toggle-switch').classList.toggle('active')
      })
    }

    // Save button
    modal.querySelector('#wr-save').addEventListener('click', async () => {
      const newSettings = {
        ...SETTINGS,
        toastPosition: modal.querySelector('#wr-toast-position').value,
        attackFeedEnabled: toggleFeed.querySelector('.wr-toggle-switch').classList.contains('active'),
        autoHideFullAttacks: toggleAutoHide.querySelector('.wr-toggle-switch').classList.contains('active'),
        showMemberStatsOnRankedWar: toggleMemberStats.querySelector('.wr-toggle-switch').classList.contains('active')
      }

      // Desktop-only settings
      if (!platform.isPda) {
        newSettings.apiKey = modal.querySelector('#wr-apikey').value.trim()
        newSettings.attackFeedOnLoaderPage = toggleLoader.querySelector('.wr-toggle-switch').classList.contains('active')
        newSettings.soundEnabled = toggleSound.querySelector('.wr-toggle-switch').classList.contains('active')
        newSettings.buttonPosition = modal.querySelector('#wr-button-position').value
      }

      if (saveSettings(newSettings)) {
        const oldFeedEnabled = SETTINGS.attackFeedEnabled
        SETTINGS = newSettings
        overlay.remove()

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
      if (platform.confirm('Clear authentication token? You will need to reload the page to reconnect.')) {
        clearStoredToken()
        jwt = null
        currentUsername = null
        if (connection) {
          connection.stop()
          connection = null
        }
        toast('Token cleared! Reload page to re-authenticate.', 'success')
      }
    })

    // Reset button (desktop only)
    const resetBtn = modal.querySelector('#wr-reset')
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (platform.confirm('Reset all settings to defaults?')) {
          if (saveSettings(DEFAULT_SETTINGS)) {
            SETTINGS = { ...DEFAULT_SETTINGS }
            overlay.remove()
            toast('Settings reset! Reload page.', 'success')
          }
        }
      })
    }
  }

  /**********************
   * UI BUTTONS
   **********************/

  // Settings button
  const settingsBtn = document.createElement('button')
  settingsBtn.className = platform.isPda
    ? 'wr-settings-btn'
    : `wr-settings-btn ${SETTINGS.buttonPosition}`
  settingsBtn.title = 'Settings'
  settingsBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${platform.isPda ? '16' : '18'}" height="${platform.isPda ? '16' : '18'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M12 1v6m0 6v6m9-9h-6m-6 0H3m15.364 6.364l-4.243-4.243m-6 0L3.636 18.364m16.728 0l-4.243-4.243m-6 0L3.636 5.636"/>
    </svg>
  `
  document.body.appendChild(settingsBtn)

  settingsBtn.addEventListener('click', () => {
    showSettingsModal()
  })

  // Feed toggle button
  const isLoaderPage = window.location.pathname.includes('/loader.php')
  const showFeedToggle = platform.isPda || !isLoaderPage

  let feedToggleBtn = null
  let updateFeedToggleState = null

  if (showFeedToggle) {
    feedToggleBtn = document.createElement('button')
    feedToggleBtn.className = platform.isPda
      ? 'wr-feed-toggle-btn'
      : `wr-feed-toggle-btn ${SETTINGS.buttonPosition}`
    feedToggleBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${platform.isPda ? '16' : '18'}" height="${platform.isPda ? '16' : '18'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        <line class="wr-bell-cross" x1="4" y1="4" x2="20" y2="20" stroke-width="2.5" style="display: none;"/>
      </svg>
    `
    document.body.appendChild(feedToggleBtn)

    updateFeedToggleState = (status = 'idle') => {
      const cross = feedToggleBtn.querySelector('.wr-bell-cross')

      feedToggleBtn.classList.remove('disabled', 'connecting')

      if (!platform.isPda && status === 'connecting') {
        feedToggleBtn.classList.add('connecting')
        feedToggleBtn.title = 'Connecting to WarRoom...'
        if (cross) cross.style.display = 'none'
      } else if (SETTINGS.attackFeedEnabled) {
        feedToggleBtn.title = 'Attack Feed: ON (click to disable)'
        if (cross) cross.style.display = 'none'
      } else {
        feedToggleBtn.classList.add('disabled')
        feedToggleBtn.title = 'Attack Feed: OFF (click to enable)'
        if (cross) cross.style.display = 'block'
      }
    }

    updateFeedToggleState()

    feedToggleBtn.addEventListener('click', async () => {
      SETTINGS.attackFeedEnabled = !SETTINGS.attackFeedEnabled
      saveSettings(SETTINGS)

      updateFeedToggleState()

      if (SETTINGS.attackFeedEnabled) {
        if (!platform.isPda && updateFeedToggleState) {
          updateFeedToggleState('connecting')
        }
        await connectToWarRoom()
        if (!platform.isPda && updateFeedToggleState) {
          updateFeedToggleState()
        }
      } else {
        disconnectFromWarRoom()
      }
    })
  }

  /**********************
   * INITIALIZATION
   **********************/

  // Determine whether to show feed
  const shouldShowFeed = platform.isPda
    ? SETTINGS.attackFeedEnabled
    : (isFactionsPage || (isLoaderPage && SETTINGS.attackFeedOnLoaderPage)) && SETTINGS.attackFeedEnabled

  // Authenticate
  await ensureAuthenticated()

  // Start SignalR connection
  if (shouldShowFeed) {
    if (!platform.isPda && updateFeedToggleState) {
      updateFeedToggleState('connecting')
    }

    connectToWarRoom().then(() => {
      if (!platform.isPda && updateFeedToggleState) {
        updateFeedToggleState()
      }
    }).catch(() => {
      if (!platform.isPda && updateFeedToggleState) {
        updateFeedToggleState()
      }
    })
  }

  /**********************
   * CLEANUP ON PAGE UNLOAD
   **********************/
  window.addEventListener('beforeunload', () => {
    if (connection) {
      connection.stop()
    }

    for (const toastData of activeToasts.values()) {
      if (toastData.timeoutId) clearTimeout(toastData.timeoutId)
      if (toastData.intervalId) clearInterval(toastData.intervalId)
    }
    activeToasts.clear()
  })

  // Post-initialization hook (debug exposure, console banner, etc.)
  platform.onInitialized(connection)
}
