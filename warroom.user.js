// ==UserScript==
// @name         TuRzAm WarRoom Connector
// @description  Connect to the TuRzAm WarRoom service to receive attack notifications directly within Torn.
// @author       TuRzAm
// @namespace    https://torn.zzcraft.net/
// @version      1.1
// @match        https://www.torn.com/loader.php*
// @match        https://www.torn.com/factions.php*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.torn.zzcraft.net
// @updateURL    https://raw.githubusercontent.com/TuRz4m/warroom-userscript/refs/heads/main/warroom-userscript.js
// @downloadURL  https://raw.githubusercontent.com/TuRz4m/warroom-userscript/refs/heads/main/warroom-userscript.js
// @require   https://raw.githubusercontent.com/Tampermonkey/utils/refs/heads/main/requires/gh_2215_make_GM_xhr_more_parallel_again.js
// ==/UserScript==

;(async function () {
  'use strict'

  const API_BASE = 'https://api.torn.zzcraft.net'
  const HUB_URL = 'https://api.torn.zzcraft.net/warroomhub'

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
    maxToasts: 10
  }

  function getSettings() {
    try {
      const stored = GM_getValue('wr_settings', null)
      return stored ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } : DEFAULT_SETTINGS
    } catch {
      return DEFAULT_SETTINGS
    }
  }

  function saveSettings(settings) {
    try {
      GM_setValue('wr_settings', JSON.stringify(settings))
      return true
    } catch {
      return false
    }
  }

  let SETTINGS = getSettings()

  /**********************
   * UTILITY HELPERS
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

  /**********************
   * TOAST UI (AttackCard-inspired design)
   **********************/
  GM_addStyle(`
    .wr-toast-container {
      position: fixed;
      display: flex;
      gap: 10px;
      z-index: 99999;
      max-width: 320px;
    }

    .wr-toast-container.bottom-left {
      left: 20px;
      bottom: 70px;
      flex-direction: column-reverse;
    }

    .wr-toast-container.bottom-right {
      right: 20px;
      bottom: 70px;
      flex-direction: column-reverse;
    }

    .wr-toast-container.top-left {
      left: 20px;
      top: 70px;
      flex-direction: column;
    }

    .wr-toast-container.top-right {
      right: 20px;
      top: 70px;
      flex-direction: column;
    }

    .wr-toast {
      background: rgba(30, 30, 50, 0.95);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(155, 89, 182, 0.3);
      border-radius: 0.75rem;
      padding: 0.75rem;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #fff;
      animation: wr-slidein 0.3s ease;
      min-width: 280px;
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

    /* Toast types */
    .wr-toast.wr-success { border-top: 3px solid #2ecc71; }
    .wr-toast.wr-error { border-top: 3px solid #e74c3c; }
    .wr-toast.wr-info { border-top: 3px solid #3498db; }
    .wr-toast.wr-attack { border-top: 3px solid #9b59b6; }

    /* Toast header */
    .wr-toast-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }

    .wr-toast-title {
      font-size: 0.9rem;
      font-weight: 600;
      color: #fff;
    }

    .wr-toast-close {
      background: rgba(255, 255, 255, 0.1);
      border: none;
      color: #888;
      cursor: pointer;
      padding: 0.2rem 0.4rem;
      border-radius: 0.25rem;
      font-size: 1rem;
      line-height: 1;
      transition: all 0.2s;
    }

    .wr-toast-close:hover {
      background: rgba(255, 255, 255, 0.2);
      color: #fff;
    }

    .wr-toast-message {
      color: #aaa;
      font-size: 0.8rem;
    }

    /* Attack card in toast */
    .wr-attack-card {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .wr-attack-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.5rem;
    }

    .wr-target-section {
      display: flex;
      align-items: baseline;
      gap: 0.3rem;
      min-width: 0;
      flex: 1;
    }

    .wr-target-name {
      color: #fff;
      font-size: 1rem;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .wr-target-id {
      color: #666;
      font-size: 0.75rem;
      flex-shrink: 0;
    }

    .wr-status-badge {
      font-size: 0.65rem;
      font-weight: 600;
      padding: 0.2rem 0.4rem;
      border-radius: 0.25rem;
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

    /* Timer and slots */
    .wr-attack-middle {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.4rem 0;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }

    .wr-timer-section {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      color: #ccc;
    }

    .wr-timer-icon {
      opacity: 0.7;
    }

    .wr-timer-value {
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 1.1rem;
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
      font-size: 1rem;
      font-weight: 600;
    }

    .wr-slots-value .filled { color: #2ecc71; }
    .wr-slots-value .separator { color: #555; margin: 0 2px; }
    .wr-slots-value .total { color: #888; }

    .wr-slots-label {
      color: #666;
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    /* Participants */
    .wr-participants {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem;
    }

    .wr-participant {
      background: rgba(155, 89, 182, 0.15);
      color: #b388d9;
      font-size: 0.75rem;
      padding: 0.15rem 0.4rem;
      border-radius: 0.25rem;
      white-space: nowrap;
      max-width: 100px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Actions */
    .wr-actions {
      display: flex;
      gap: 0.5rem;
      margin-top: 0.25rem;
    }

    .wr-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.35rem 0.6rem;
      border-radius: 0.35rem;
      border: 1px solid rgba(255, 255, 255, 0.15);
      background: rgba(255, 255, 255, 0.05);
      color: #aaa;
      cursor: pointer;
      font-size: 0.75rem;
      font-weight: 500;
      transition: all 0.2s ease;
    }

    .wr-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      transform: translateY(-1px);
    }

    .wr-btn-join {
      background: rgba(46, 204, 113, 0.1);
      border-color: rgba(46, 204, 113, 0.3);
      color: #2ecc71;
    }

    .wr-btn-join:hover {
      background: rgba(46, 204, 113, 0.2);
      border-color: #2ecc71;
      box-shadow: 0 2px 8px rgba(46, 204, 113, 0.3);
    }

    .wr-btn-attack {
      background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%);
      border-color: #e74c3c;
      color: #fff;
    }

    .wr-btn-attack:hover {
      box-shadow: 0 4px 12px rgba(231, 76, 60, 0.4);
    }

    /* Created by */
    .wr-created-info {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
      color: #666;
      font-size: 0.7rem;
      margin-top: 0.25rem;
    }

    /* Refresh button */
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

    @keyframes wr-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    /* Button base styles */
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
      z-index: 99998;
      transition: all 0.2s ease;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }

    /* Settings button */
    .wr-settings-btn {
      border: 1px solid rgba(155, 89, 182, 0.4);
      color: #9b59b6;
    }

    .wr-settings-btn:hover {
      background: rgba(155, 89, 182, 0.2);
      border-color: #9b59b6;
      transform: scale(1.1);
    }

    /* Attack feed toggle button */
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

    /* Coordinated attack button */
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
    .wr-feed-toggle-btn.bottom-left {
      left: 20px;
      bottom: 20px;
    }

    .wr-settings-btn.bottom-left {
      left: 66px;
      bottom: 20px;
    }

    .wr-attack-btn.bottom-left {
      left: 112px;
      bottom: 20px;
    }

    /* Button positions - bottom-right */
    .wr-feed-toggle-btn.bottom-right {
      right: 20px;
      bottom: 20px;
    }

    .wr-settings-btn.bottom-right {
      right: 66px;
      bottom: 20px;
    }

    .wr-attack-btn.bottom-right {
      right: 112px;
      bottom: 20px;
    }

    /* Button positions - top-left */
    .wr-feed-toggle-btn.top-left {
      left: 20px;
      top: 20px;
    }

    .wr-settings-btn.top-left {
      left: 66px;
      top: 20px;
    }

    .wr-attack-btn.top-left {
      left: 112px;
      top: 20px;
    }

    /* Button positions - top-right */
    .wr-feed-toggle-btn.top-right {
      right: 20px;
      top: 20px;
    }

    .wr-settings-btn.top-right {
      right: 66px;
      top: 20px;
    }

    .wr-attack-btn.top-right {
      right: 112px;
      top: 20px;
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
    }

    .wr-modal-close:hover {
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
    }

    .wr-setting-toggle:hover {
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
    }

    .wr-btn-primary:hover {
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
    }

    .wr-btn-secondary:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }

    .wr-setting-desc {
      color: #666;
      font-size: 0.75rem;
      margin-top: 0.25rem;
    }
  `)

  // Check if we're on factions page or loader page (when enabled)
  const isFactionsPage = window.location.pathname.includes('/factions.php')
  const isLoaderPage = window.location.pathname.includes('/loader.php')
  const shouldShowFeed = isFactionsPage || (isLoaderPage && SETTINGS.attackFeedOnLoaderPage)

  // Create toast container (on all pages)
  const toastContainer = document.createElement('div')
  toastContainer.className = `wr-toast-container ${SETTINGS.toastPosition}`
  document.body.appendChild(toastContainer)

  // Toast management
  const activeToasts = new Map()

  function createToast(id, content, type = 'info', duration = 20000) {
    // Check if toast container exists
    if (!toastContainer) {
      return null
    }

    // Check if toast already exists - update it instead of recreating
    const existingToast = activeToasts.get(id)
    if (existingToast) {
      existingToast.element.innerHTML = content
      
      // Re-add close button handler
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

    // Add close button handler
    const closeBtn = toastEl.querySelector('.wr-toast-close')
    if (closeBtn) {
      closeBtn.addEventListener('click', () => removeToast(id))
    }

    toastContainer.appendChild(toastEl)

    // duration = 0 means no auto-dismiss
    const timeoutId = duration > 0 ? setTimeout(() => removeToast(id), duration) : null
    activeToasts.set(id, { element: toastEl, timeoutId })

    return toastEl
  }

  function removeToast(id) {
    const toastData = activeToasts.get(id)
    if (!toastData) return

    // Clear any active timers to prevent memory leaks
    if (toastData.timeoutId) clearTimeout(toastData.timeoutId)
    if (toastData.intervalId) clearInterval(toastData.intervalId)

    // Remove from map immediately to prevent race conditions
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
      <div class="wr-toast-message">${message}</div>
    `
    createToast(id, content, type, 2000)
  }

  /**********************
   * SOUND NOTIFICATIONS
   **********************/
  function playNotificationSound() {
    if (!SETTINGS.soundEnabled) return

    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)()
      const oscillator = audioContext.createOscillator()
      const gainNode = audioContext.createGain()

      oscillator.connect(gainNode)
      gainNode.connect(audioContext.destination)

      // Configure sound - two quick beeps
      oscillator.frequency.value = 800 // Hz
      oscillator.type = 'sine'

      // Volume envelope
      gainNode.gain.setValueAtTime(0, audioContext.currentTime)
      gainNode.gain.linearRampToValueAtTime(0.3, audioContext.currentTime + 0.01)
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1)
      gainNode.gain.setValueAtTime(0, audioContext.currentTime + 0.15)
      gainNode.gain.linearRampToValueAtTime(0.3, audioContext.currentTime + 0.16)
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.25)

      oscillator.start(audioContext.currentTime)
      oscillator.stop(audioContext.currentTime + 0.3)
    } catch {
      // Ignore audio errors
    }
  }

  function handleAttackEvent(event) {
    // Event structure: { warRoomId, attack, eventType }
    // eventType can be string ('Added', 'Updated', 'Done', 'Removed') or number (0, 1, 2)
    const attack = event.attack || event
    const rawEventType = event.eventType ?? 'Added'
    const eventType =
      typeof rawEventType === 'number' ? ['Added', 'Updated', 'Done'][rawEventType] : rawEventType

    const id = 'attack-' + attack.id

    // If done or removed, remove the toast
    if (eventType === 'Done' || eventType === 'Removed' || rawEventType === 2 || attack.isDone) {
      removeToast(id)
      return
    }

    // If full, remove the toast (attack is complete)
    if (attack.isFull && attack.link == null) {
      removeToast(id)
      return
    }

    // Play sound for new attacks
    if (eventType === 'Added') {
      playNotificationSound()
    }

    showAttackToast(attack, eventType)
  }

  function showAttackToast(attack, eventType = 'Added') {
    const id = 'attack-' + attack.id

    // Don't show toasts for done attacks
    if (attack.isDone) {
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

    // Only show attack button if there's a link and current user is IN the attackers list
    const isUserInAttackers = attack.attackers && attack.attackers.includes(currentUsername)
    const isUserCreator = attack.createdBy === currentUsername
    // Generate attack link from userId if not provided by server
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

        if (minutes < SETTINGS.urgentThresholdMinutes) {
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
        if (url) window.open(url, '_blank')
      })
    }

    const joinBtn = toastEl.querySelector('.wr-btn-join')
    if (joinBtn) {
      joinBtn.addEventListener('click', async () => {
        const attackId = joinBtn.dataset.attackId
        try {
          await gmFetch(
            'POST',
            `${API_BASE}/WarRooms/participate/${attackId}`,
            {
              'Authorization': `Bearer ${jwt}`,
              'Content-Type': 'application/json',
            }
          )
          toast('Joined attack successfully!', 'success')
        } catch (e) {
          toast('Failed to join attack: ' + extractErrorMessage(e), 'error')
        }
      })
    }

    const doneBtn = toastEl.querySelector(`#wr-done-${attack.id}`)
    if (doneBtn) {
      doneBtn.addEventListener('click', async () => {
        const attackId = doneBtn.dataset.attackId
        try {
          await gmFetch(
            'POST',
            `${API_BASE}/WarRooms/end/${attackId}`,
            {
              'Authorization': `Bearer ${jwt}`,
            }
          )
          toast('Attack marked as done!', 'success')
          // Don't manually remove toast - let server event handle it
        } catch (e) {
          toast('Failed to mark attack as done: ' + extractErrorMessage(e), 'error')
        }
      })
    }
  }

  /**********************
   * HTTP HELPERS (via GM.xmlHttpRequest to bypass CSP)
   * Uses GM.xmlHttpRequest (promise-based) with parallel fix for Tampermonkey
   **********************/
  async function gmFetch(method, url, headers = {}, body = null) {
    try {
      const res = await GM.xmlHttpRequest({
        method,
        url,
        headers,
        data: body,
        timeout: 30000,
      })

      if (res.status >= 200 && res.status < 300) {
        return res
      } else {
        // Try to extract error message from response body
        let errorMsg = res.statusText
        try {
          if (res.responseText) {
            const errorData = JSON.parse(res.responseText)
            errorMsg = errorData.message || errorData.error || errorData.title || res.statusText
          }
        } catch {
          // If parsing fails, use statusText
        }
        throw new Error(`HTTP ${res.status}: ${errorMsg}`)
      }
    } catch (err) {
      // Handle network errors and timeouts
      if (err.message?.startsWith('HTTP ')) {
        throw err
      }
      throw new Error('Network error: ' + (err.message || err))
    }
  }

  /**********************
   * AUTHENTICATION
   **********************/
  const TOKEN_STORAGE_KEY = 'wr_jwt_token'
  const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000 // 5 minutes

  function isTokenExpired(token) {
    const claims = parseJwtClaims(token)
    if (!claims || !claims.exp) return true
    const exp = claims.exp * 1000
    return Date.now() > exp - TOKEN_EXPIRY_BUFFER_MS
  }

  function getStoredToken() {
    try {
      // Use GM_getValue for better isolation from page scripts (vs localStorage)
      const token = GM_getValue(TOKEN_STORAGE_KEY, null)
      if (token && !isTokenExpired(token)) {
        return token
      }
      GM_setValue(TOKEN_STORAGE_KEY, null)
    } catch {
      // Ignore storage errors
    }
    return null
  }

  function storeToken(token) {
    try {
      GM_setValue(TOKEN_STORAGE_KEY, token)
    } catch {
      // Ignore storage errors
    }
  }

  function clearStoredToken() {
    try {
      GM_setValue(TOKEN_STORAGE_KEY, null)
    } catch {
      // Ignore storage errors
    }
  }

  async function login() {
    if (!SETTINGS.apiKey) {
      throw new Error('API key not configured')
    }
    const res = await gmFetch(
      'POST',
      `${API_BASE}/auth/login`,
      {
        'Content-Type': 'application/json',
      },
      JSON.stringify({ apikey: SETTINGS.apiKey }),
    )
    const json = JSON.parse(res.responseText)
    return json.token
  }

  let jwt = getStoredToken()
  let currentUsername = null
  let isAuthenticated = false

  // Centralized function to extract username from JWT
  function updateCurrentUserFromJwt(token) {
    const claims = parseJwtClaims(token)
    if (claims) {
      currentUsername = claims['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'] || null
      return true
    }
    return false
  }

  // Authentication flow with proper error handling
  async function ensureAuthenticated() {
    // Try stored token first
    if (jwt && !isTokenExpired(jwt)) {
      if (updateCurrentUserFromJwt(jwt)) {
        isAuthenticated = true
        return true
      }
    }

    // Need to login
    if (!SETTINGS.apiKey) {
      isAuthenticated = false
      return false
    }

    try {
      jwt = await login()
      storeToken(jwt)
      if (updateCurrentUserFromJwt(jwt)) {
        isAuthenticated = true
        return true
      }
    } catch (e) {
      toast('Auth failed: ' + extractErrorMessage(e), 'error')
      jwt = null
      currentUsername = null
      isAuthenticated = false
      clearStoredToken()
    }
    return false
  }

  // Run initial authentication
  await ensureAuthenticated()

  /**********************
   * CACHE MANAGEMENT
   **********************/
  const TARGET_CACHE_KEY = 'wr_target_cache'
  const TARGET_CACHE_TTL = 60 * 60 * 1000 // 1 hour in milliseconds

  function getCachedTargets() {
    try {
      const cached = GM_getValue(TARGET_CACHE_KEY, null)
      if (!cached) return null
      
      const data = JSON.parse(cached)
      if (Date.now() - data.timestamp > TARGET_CACHE_TTL) {
        GM_setValue(TARGET_CACHE_KEY, null)
        return null
      }
      
      return data.targets
    } catch {
      return null
    }
  }

  function setCachedTargets(targets) {
    try {
      GM_setValue(TARGET_CACHE_KEY, JSON.stringify({
        targets,
        timestamp: Date.now()
      }))
    } catch {
      // Ignore cache errors
    }
  }

  function clearTargetCache() {
    try {
      GM_setValue(TARGET_CACHE_KEY, null)
      return true
    } catch {
      return false
    }
  }

  /**********************
   * SIGNALR LONG POLLING CONNECTION
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
        const negotiateRes = await gmFetch('POST', `${this.hubUrl}/negotiate?negotiateVersion=1`, {
          'Content-Type': 'text/plain;charset=UTF-8',
          Authorization: `Bearer ${this.accessToken}`,
        })
        const negotiateData = JSON.parse(negotiateRes.responseText)

        this.connectionId = negotiateData.connectionId
        this.connectionToken = negotiateData.connectionToken || this.connectionId

        const handshakePayload = JSON.stringify({ protocol: 'json', version: 1 }) + '\x1e'
        await gmFetch(
          'POST',
          `${this.hubUrl}?id=${encodeURIComponent(this.connectionToken)}`,
          {
            'Content-Type': 'text/plain;charset=UTF-8',
            Authorization: `Bearer ${this.accessToken}`,
          },
          handshakePayload,
        )

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
        this.pollLoop()

        return true
      } catch (e) {
        throw e
      }
    }

    async poll() {
      const res = await gmFetch(
        'GET',
        `${this.hubUrl}?id=${encodeURIComponent(this.connectionToken)}`,
        {
          Authorization: `Bearer ${this.accessToken}`,
        },
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
        } catch {
          if (this.running) {
            this.running = false
            this.attemptReconnect()
          }
          return
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
              break
            case 7:
              this.stop()
              break
          }
        } catch {
          // Ignore parse errors
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
          } catch {
            // Ignore handler errors
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
        this.pendingCalls.set(invocationId, { resolve, reject })

        gmFetch(
          'POST',
          `${this.hubUrl}?id=${encodeURIComponent(this.connectionToken)}`,
          {
            'Content-Type': 'text/plain;charset=UTF-8',
            Authorization: `Bearer ${this.accessToken}`,
          },
          payload,
        ).catch((e) => {
          this.pendingCalls.delete(invocationId)
          reject(e)
        })

        setTimeout(() => {
          if (this.pendingCalls.has(invocationId)) {
            this.pendingCalls.delete(invocationId)
            reject(new Error('Invoke timeout'))
          }
        }, 30000)
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
        await gmFetch(
          'POST',
          `${this.hubUrl}?id=${encodeURIComponent(this.connectionToken)}`,
          {
            'Content-Type': 'text/plain;charset=UTF-8',
            Authorization: `Bearer ${this.accessToken}`,
          },
          payload,
        )
      } catch {
        // Ignore send errors
      }
    }

    attemptReconnect() {
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        toast('Connection lost', 'error')
        return
      }

      this.reconnectAttempts++
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1)

      setTimeout(async () => {
        try {
          await this.start()
        } catch {
          this.attemptReconnect()
        }
      }, delay)
    }

    stop() {
      this.running = false
      this.maxReconnectAttempts = 0 // Prevent reconnection attempts after explicit stop

      if (this.connectionToken) {
        // Fire and forget - don't wait for DELETE to complete
        // The active long-poll will be killed by the server
        gmFetch('DELETE', `${this.hubUrl}?id=${encodeURIComponent(this.connectionToken)}`, {
          Authorization: `Bearer ${this.accessToken}`,
        }).catch(() => {
          // Ignore errors on close
        })
      }
    }
  }

  /**********************
   * CONNECT AND LISTEN (only on factions page)
   **********************/
  let connection = null
  let warRoomIds = []

  async function connectToWarRoom() {
    if (!shouldShowFeed || !isAuthenticated) return

    connection = new SignalRLongPollingConnection(HUB_URL, jwt)

    // Handle attack updates
    connection.on('AttackUpdate', (event) => {
      handleAttackEvent(event)
    })

    // Handle war room attacks list
    connection.on('WarRoomAttacks', (data) => {
      if (data && data.attacks) {
        const now = new Date()
        for (const attack of data.attacks) {
          // Show active attacks that aren't done, expired, or (full without link)
          if (attack.isDone) continue
          
          const expiration = new Date(attack.expiration)
          if (expiration <= now) continue
          
          if (attack.isFull && !attack.link) continue
          
          handleAttackEvent({ attack, eventType: 'Added', warRoomId: data.warRoomId })
        }
      }
    })

    // Handle other messages
    connection.on('ReceiveMessage', (message) => {
      toast(message, 'info')
    })

    try {
      await connection.start()
    } catch {
      toast('Connection failed', 'error')
      return
    }

    // Set display name to identify this client as coming from Torn
    try {
      await connection.send('SetDisplayName', 'Torn')
    } catch {
      // Ignore - not critical
    }

    // Get available war rooms and join them to receive attack updates
    try {
      const warRooms = await connection.invoke('GetWarRooms')
      if (warRooms && warRooms.length > 0) {
        warRoomIds = warRooms.map((wr) => wr.warRoomId)
        toast(`Joined ${warRooms.length} war room(s)`, 'success')
        // Fetch existing attacks for each war room
        for (const warRoom of warRooms) {
          try {
            const attacksData = await connection.invoke('GetAttacks', warRoom.warRoomId)
            if (attacksData && attacksData.attacks) {
              for (const attack of attacksData.attacks) {
                // Show active attacks that aren't done or full
                if (!attack.isDone && !attack.isFull) {
                  const expiration = new Date(attack.expiration)
                  if (expiration > new Date()) {
                    handleAttackEvent({ attack, eventType: 'Added', warRoomId: warRoom.warRoomId })
                  }
                }
              }
            }
          } catch {
            // Ignore individual war room fetch errors
          }
        }
      } else {
        toast('No war rooms available', 'info')
      }
    } catch {
      toast('Failed to fetch war rooms', 'error')
    }
  }

  async function disconnectFromWarRoom() {
    if (connection) {
      try {
        connection.stop() // Fire and forget - don't await
        connection = null
        warRoomIds = []
        toast('Disconnected from WarRoom', 'info')
      } catch {
        // Ignore disconnect errors
      }
    }
  }

  if (shouldShowFeed && SETTINGS.attackFeedEnabled) {
    await connectToWarRoom()
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
            // Fetch all targets from the new unified endpoint
            const targetsRes = await gmFetch(
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
        attackBtn.className = `wr-attack-btn ${SETTINGS.buttonPosition}`
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
            const res = await gmFetch(
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
   * SETTINGS UI
   **********************/
  function showSettingsModal() {
    // Create modal overlay
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
        <label class="wr-setting-label">API Key</label>
        <input type="text" class="wr-setting-input" id="wr-apikey" value="${SETTINGS.apiKey}" placeholder="Enter your WarRoom API key">
        <div class="wr-setting-desc">Required for authentication. Get yours from torn.zzcraft.net</div>
      </div>

      <div class="wr-setting-group">
        <div class="wr-setting-toggle" id="wr-toggle-feed">
          <span class="wr-toggle-label">Attack Feed On Faction Page</span>
          <div class="wr-toggle-switch ${SETTINGS.attackFeedEnabled ? 'active' : ''}">
            <div class="wr-toggle-slider"></div>
          </div>
        </div>
        <div class="wr-setting-desc">Show/hide attack notifications on factions page</div>
      </div>

      <div class="wr-setting-group">
        <div class="wr-setting-toggle" id="wr-toggle-loader">
          <span class="wr-toggle-label">Attack Feed on Attack Page</span>
          <div class="wr-toggle-switch ${SETTINGS.attackFeedOnLoaderPage ? 'active' : ''}">
            <div class="wr-toggle-slider"></div>
          </div>
        </div>
        <div class="wr-setting-desc">Show attack feed on loader.php (attack page)</div>
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

      <div class="wr-setting-group">
        <div class="wr-setting-toggle" id="wr-toggle-sound">
          <span class="wr-toggle-label">Sound Notifications</span>
          <div class="wr-toggle-switch ${SETTINGS.soundEnabled ? 'active' : ''}">
            <div class="wr-toggle-slider"></div>
          </div>
        </div>
        <div class="wr-setting-desc">Play sound when new attacks are added</div>
      </div>

      <div class="wr-setting-group">
        <label class="wr-setting-label">Toast Position</label>
        <select class="wr-setting-input" id="wr-toast-position">
          <option value="bottom-left" ${SETTINGS.toastPosition === 'bottom-left' ? 'selected' : ''}>Bottom Left</option>
          <option value="bottom-right" ${SETTINGS.toastPosition === 'bottom-right' ? 'selected' : ''}>Bottom Right</option>
          <option value="top-left" ${SETTINGS.toastPosition === 'top-left' ? 'selected' : ''}>Top Left</option>
          <option value="top-right" ${SETTINGS.toastPosition === 'top-right' ? 'selected' : ''}>Top Right</option>
        </select>
        <div class="wr-setting-desc">Choose where toast notifications appear on screen</div>
      </div>

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

      <div class="wr-modal-footer">
        <button class="wr-btn-secondary" id="wr-clear-cache" style="flex: 0.8;">Clear Cache</button>
        <button class="wr-btn-secondary" id="wr-clear-token" style="flex: 0.8;">Clear Token</button>
        <button class="wr-btn-secondary" id="wr-reset">Reset</button>
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

    // Toggle switches
    const toggleFeed = modal.querySelector('#wr-toggle-feed')
    const toggleLoader = modal.querySelector('#wr-toggle-loader')
    const toggleAutoHide = modal.querySelector('#wr-toggle-autohide')
    const toggleSound = modal.querySelector('#wr-toggle-sound')

    toggleFeed.addEventListener('click', () => {
      const sw = toggleFeed.querySelector('.wr-toggle-switch')
      sw.classList.toggle('active')
    })

    toggleLoader.addEventListener('click', () => {
      const sw = toggleLoader.querySelector('.wr-toggle-switch')
      sw.classList.toggle('active')
    })

    toggleAutoHide.addEventListener('click', () => {
      const sw = toggleAutoHide.querySelector('.wr-toggle-switch')
      sw.classList.toggle('active')
    })

    toggleSound.addEventListener('click', () => {
      const sw = toggleSound.querySelector('.wr-toggle-switch')
      sw.classList.toggle('active')
    })

    // Save button
    modal.querySelector('#wr-save').addEventListener('click', () => {
      const newSettings = {
        apiKey: modal.querySelector('#wr-apikey').value.trim(),
        attackFeedEnabled: toggleFeed.querySelector('.wr-toggle-switch').classList.contains('active'),
        attackFeedOnLoaderPage: toggleLoader.querySelector('.wr-toggle-switch').classList.contains('active'),
        autoHideFullAttacks: toggleAutoHide.querySelector('.wr-toggle-switch').classList.contains('active'),
        soundEnabled: toggleSound.querySelector('.wr-toggle-switch').classList.contains('active'),
        urgentThresholdMinutes: 1,
        toastPosition: modal.querySelector('#wr-toast-position').value,
        buttonPosition: modal.querySelector('#wr-button-position').value,
        toastDuration: SETTINGS.toastDuration,
        maxToasts: SETTINGS.maxToasts
      }

      if (saveSettings(newSettings)) {
        SETTINGS = newSettings
        overlay.remove()
        toast('Settings saved! Reload page for full effect.', 'success')
      } else {
        toast('Failed to save settings', 'error')
      }
    })

    // Clear cache button
    modal.querySelector('#wr-clear-cache').addEventListener('click', () => {
      if (clearTargetCache()) {
        toast('Target cache cleared successfully!', 'success')
      } else {
        toast('Failed to clear cache', 'error')
      }
    })

    // Clear token button
    modal.querySelector('#wr-clear-token').addEventListener('click', () => {
      if (confirm('Clear authentication token? You will need to reload the page to reconnect.')) {
        clearStoredToken()
        jwt = null
        currentUsername = null
        isAuthenticated = false
        if (connection) {
          connection.stop()
          connection = null
        }
        toast('Token cleared! Reload page to re-authenticate.', 'success')
      }
    })

    // Reset button
    modal.querySelector('#wr-reset').addEventListener('click', () => {
      if (confirm('Reset all settings to defaults?')) {
        if (saveSettings(DEFAULT_SETTINGS)) {
          SETTINGS = { ...DEFAULT_SETTINGS }
          overlay.remove()
          toast('Settings reset! Reload page.', 'success')
        }
      }
    })
  }

  /**********************
   * SETTINGS & TOGGLE BUTTONS (all pages)
   **********************/
  // Settings button
  const settingsBtn = document.createElement('button')
  settingsBtn.className = `wr-settings-btn ${SETTINGS.buttonPosition}`
  settingsBtn.title = 'Settings'
  settingsBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M12 1v6m0 6v6m9-9h-6m-6 0H3m15.364 6.364l-4.243-4.243m-6 0L3.636 18.364m16.728 0l-4.243-4.243m-6 0L3.636 5.636"/>
    </svg>
  `
  document.body.appendChild(settingsBtn)

  settingsBtn.addEventListener('click', () => {
    showSettingsModal()
  })

  // Attack feed toggle button (not on loader.php)
  if (!window.location.pathname.includes('/loader.php')) {
    const feedToggleBtn = document.createElement('button')
    feedToggleBtn.className = `wr-feed-toggle-btn ${SETTINGS.buttonPosition}`
    feedToggleBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        <line class="wr-bell-cross" x1="4" y1="4" x2="20" y2="20" stroke-width="2.5" style="display: none;"/>
      </svg>
    `
    document.body.appendChild(feedToggleBtn)

    // Unified function to update button state based on settings
    const updateFeedToggleState = () => {
      const cross = feedToggleBtn.querySelector('.wr-bell-cross')
      
      if (SETTINGS.attackFeedEnabled) {
        // Enabled state: purple bell, no cross
        feedToggleBtn.classList.remove('disabled')
        feedToggleBtn.title = 'Attack Feed: ON (click to disable)'
        if (cross) cross.style.display = 'none'
      } else {
        // Disabled state: red bell with cross
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
        // Connect to WarRoom if on factions page
        if (isFactionsPage) {
          await connectToWarRoom()
        }
      } else {
        // Disconnect from WarRoom
        disconnectFromWarRoom()
      }
    })
  }

  /**********************
   * CLEANUP ON PAGE UNLOAD
   **********************/
  window.addEventListener('beforeunload', () => {
    // Gracefully disconnect SignalR connection
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

  // Expose for debugging
  window.__warRoomConnection = connection

  // Startup message
  console.log(
    '%c🎯 TuRzAm WarRoom Connector v1.0 %c Loaded successfully! ',
    'background: linear-gradient(135deg, #9b59b6 0%, #8e44ad 100%); color: white; font-weight: bold; padding: 4px 8px; border-radius: 4px 0 0 4px;',
    'background: #2ecc71; color: white; font-weight: bold; padding: 4px 8px; border-radius: 0 4px 4px 0;'
  )
})()
