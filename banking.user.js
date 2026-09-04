// ==UserScript==
// @name         RR - Torn Bank Helper
// @description  Ask the faction bankers for a vault withdrawal from inside Torn.
// @author       TuRzAm
// @namespace    https://torn.zzcraft.net/
// @version      1.0.0
// @match        https://www.torn.com/factions.php*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      api.torn.zzcraft.net
// @updateURL    https://github.com/TuRz4m/warroom-userscript/raw/refs/heads/main/banking.user.js
// @downloadURL  https://github.com/TuRz4m/warroom-userscript/raw/refs/heads/main/banking.user.js
// ==/UserScript==

;(async function () {
  'use strict'

  /**********************
   * PLATFORM DETECTION
   **********************/
  const IS_TORN_PDA = typeof window.flutter_inappwebview !== 'undefined'
  const USER_AGENT = 'rr-bank-userscript/1.0.0'
  const API_KEY_STORAGE_KEY = 'bk_api_key'

  /**
   * Pulls the sentence a human should read out of an error body.
   *
   * The API answers a refusal with `{"error": "..."}` — a sentence already written for the member,
   * which every surface of this feature shows verbatim. FluentValidation answers instead with
   * ValidationProblemDetails, whose `title` is the useless "One or more validation errors occurred.";
   * the sentence lives one level down under `errors`, so that is read first.
   */
  function extractServerError(responseText, fallback) {
    try {
      const data = JSON.parse(responseText)
      if (data && typeof data.errors === 'object' && data.errors !== null) {
        for (const messages of Object.values(data.errors)) {
          if (Array.isArray(messages) && messages.length > 0) return messages[0]
          if (typeof messages === 'string') return messages
        }
      }
      return data?.error || data?.message || data?.title || fallback
    } catch {
      return fallback
    }
  }

  /**
   * What to say about a status code when the response body says nothing.
   *
   * A rejected key comes back as a bare 401 with no body - the API key middleware only logs the
   * failure and lets the request continue unauthenticated, so the refusal is produced by the
   * [Authorize] attribute, which writes nothing. Falling back to the status text turned that into
   * "HTTP 401: HTTP 401", which tells the member neither what failed nor what to do.
   */
  function describeStatus(status, statusText) {
    if (status === 401) {
      return 'The service did not accept your API key. It has to belong to a member of a faction' +
        ' registered with the service.'
    }
    if (status === 403) return 'Your account is not allowed to do that.'
    return statusText || 'HTTP ' + status
  }

  /**
   * Says what actually went wrong when a request never reached the server.
   *
   * GM.xmlHttpRequest does not reject with an Error. It rejects with a response-like object -
   * readyState, status, statusText, error - so string-concatenating it produced the famously
   * unhelpful "Network error: [object Object]", which named neither the host nor the reason.
   *
   * A status of 0 means nothing was received at all. In a userscript that is nearly always one of
   * three things: the host is missing from the metadata's @connect list, the server is not
   * running, or the URL says https where the server speaks http. The message says so, because
   * none of them is guessable from the failure alone.
   */
  function describeNetworkError(err, url) {
    let host = url
    try {
      host = new URL(url).host
    } catch {
      // Keep the whole URL if it will not parse.
    }

    const detail = []
    if (typeof err === 'string' && err) detail.push(err)
    else if (err) {
      if (err.message) detail.push(String(err.message))
      if (err.error && String(err.error) !== String(err.message)) detail.push(String(err.error))
      if (err.statusText) detail.push(String(err.statusText))
      if (typeof err.status === 'number' && err.status > 0) detail.push('HTTP ' + err.status)
    }

    // statusText and error often carry the same word; saying it twice reads like a bug.
    const said = [...new Set(detail)]

    const nothingArrived = !err || typeof err.status !== 'number' || err.status === 0
    const because = nothingArrived
      ? ' Nothing came back: check the server is running, that the address is http or https to' +
        ' match it, and that the host is listed in the script\'s @connect.'
      : ''

    return `Could not reach ${host}.${said.length ? ' ' + said.join(' - ') + '.' : ''}${because}`
  }

  /**********************
   * PLATFORM DEFINITION
   **********************/
  const platform = IS_TORN_PDA
    ? {
        // ——— TornPDA Platform ———
        fetch: async function pdaFetch(method, url, headers = {}, body = null) {
          try {
            const reqHeaders = { ...headers, 'User-Agent': USER_AGENT }
            let res
            if (method === 'GET') {
              res = await window.flutter_inappwebview.callHandler('PDA_httpGet', url, reqHeaders)
            } else if (method === 'POST') {
              res = await window.flutter_inappwebview.callHandler('PDA_httpPost', url, reqHeaders, body)
            } else {
              throw new Error(`Unsupported method: ${method}`)
            }

            if (res.status >= 200 && res.status < 300) {
              return res
            }

            const errorMsg =
              extractServerError(res.responseText, describeStatus(res.status, res.statusText))
            throw new Error(`HTTP ${res.status}: ${errorMsg}`)
          } catch (err) {
            if (err?.message?.startsWith('HTTP ')) {
              throw err
            }
            throw new Error(describeNetworkError(err, url))
          }
        },
        getValue: (key, defaultValue) => {
          try {
            const value = localStorage.getItem(key)
            return value !== null ? value : defaultValue
          } catch {
            return defaultValue
          }
        },
        setValue: (key, value) => {
          try {
            localStorage.setItem(key, value)
          } catch {
            // Ignore storage errors
          }
        },
        removeValue: (key) => {
          try {
            localStorage.removeItem(key)
          } catch {
            // Ignore storage errors
          }
        },
        addStyle: (css) => {
          const style = document.createElement('style')
          style.textContent = css
          document.head.appendChild(style)
        },
        // PDA substitutes the member's own key into this placeholder when the script is installed.
        getApiKey: () => "###PDA-APIKEY###",
        setApiKey: () => {},
        isPda: true,
      }
    : {
        // ——— Desktop (Tampermonkey) Platform ———
        fetch: async (method, url, headers = {}, body = null) => {
          try {
            const res = await GM.xmlHttpRequest({
              method,
              url,
              headers: { ...headers, 'User-Agent': USER_AGENT },
              data: body,
              timeout: 30000,
            })

            if (res.status >= 200 && res.status < 300) {
              return res
            }

            const errorMsg =
              extractServerError(res.responseText, describeStatus(res.status, res.statusText))
            throw new Error(`HTTP ${res.status}: ${errorMsg}`)
          } catch (err) {
            if (err?.message?.startsWith('HTTP ')) {
              throw err
            }
            throw new Error(describeNetworkError(err, url))
          }
        },
        getValue: (key, defaultValue) => {
          try {
            return GM_getValue(key, defaultValue)
          } catch {
            return defaultValue
          }
        },
        setValue: (key, value) => {
          try {
            GM_setValue(key, value)
          } catch {
            // Ignore storage errors
          }
        },
        removeValue: (key) => {
          try {
            GM_setValue(key, undefined)
          } catch {
            // Ignore storage errors
          }
        },
        addStyle: (css) => GM_addStyle(css),
        // A plain value rather than a settings blob: this script has no other settings.
        getApiKey: () => {
          try {
            return GM_getValue(API_KEY_STORAGE_KEY, '') || ''
          } catch {
            return ''
          }
        },
        setApiKey: (value) => {
          try {
            GM_setValue(API_KEY_STORAGE_KEY, value || '')
          } catch {
            // Ignore storage errors
          }
        },
        isPda: false,
      }

  /**********************
   * SHARED LOGIC
   **********************/
  async function initBankHelper(platform) {
    'use strict'

    /**********************
     * CONSTANTS
     **********************/
    const API_BASE = 'https://api.torn.zzcraft.net'
    const TOKEN_STORAGE_KEY = 'bk_jwt_token'
    const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000 // 5 minutes
    const BUTTON_MARKER = 'data-bk-injected'

    // The armoury deposit panel holds two `.donate` blocks, one per form: cash and points. Only the
    // cash one is ours - a vault withdrawal is money, and nothing pays out points - so the button is
    // scoped to that form rather than to the class on its own, which put a second button under
    // "DEPOSIT POINTS" that could only ever ask for money.
    //
    // Both selectors name the same element; `querySelectorAll` returns it once.
    const DONATE_SELECTOR = 'form[data-action="donateCash"] .donate, .donate-wrap .cash .donate'

    // The same five the website offers, weighted short: a withdrawal is usually asked for while
    // somebody is waiting to spend it, and an expiry that outlives their attention leaves a request
    // the bankers answer to nobody.
    const DURATIONS = [
      { label: '5 minutes', minutes: 5 },
      { label: '15 minutes', minutes: 15 },
      { label: '1 hour', minutes: 60 },
      { label: '6 hours', minutes: 360 },
      { label: '1 day', minutes: 1440 },
    ]
    const DEFAULT_DURATION_MINUTES = 60

    // The validator's own limit, so a too-long amount is refused here rather than round-tripped.
    const AMOUNT_MAX_LENGTH = 32

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
      const message = typeof error === 'string' ? error : error?.message
      if (!message) {
        return 'Something went wrong, and the failure carried no message.'
      }
      return String(message).replace(/^HTTP \d+:\s*/, '')
    }

    /** Matches `BankAmountParser.Format`, so the amount reads the same here as everywhere else. */
    function formatMoney(value) {
      const amount = Number(value)
      if (!Number.isFinite(amount)) return ''
      return '$' + amount.toLocaleString('en-US', { maximumFractionDigits: 0 })
    }

    /**********************
     * STYLES
     **********************/
    platform.addStyle(`
      /* ------------------------------------------------------------------------------------
         TornWeb's own design language, lifted from ui/src/assets/base.css, AddLimitModal.vue and
         BankWithdrawRequestPanel.vue, so a member who uses the site recognises this as the same
         product rather than a third-party box that happens to sit on the page.

         Tokens are declared on the three elements this script owns, never on :root. Torn has
         custom properties of its own and a userscript has no business writing into the page's
         root scope.
         ------------------------------------------------------------------------------------ */
      .bk-modal-overlay,
      .bk-toast-container,
      .bk-btn-wrap {
        --bk-accent: #00d4ff;
        --bk-accent-2: #00ff88;
        --bk-danger: #ff006e;
        --bk-ink: #1a1a2e;
        --bk-surface: rgba(30, 30, 50, 0.95);
        --bk-text: #e8eef5;
        --bk-text-soft: #cfd8e3;
        --bk-text-dim: #6f7d8c;
        --bk-line: rgba(255, 255, 255, 0.1);
        --bk-field-line: rgba(255, 255, 255, 0.15);
        --bk-field-bg: rgba(255, 255, 255, 0.04);
        --bk-radius: 0.5rem;
        --bk-radius-sm: 0.375rem;
        --bk-ease: cubic-bezier(0.16, 1, 0.3, 1);
        --bk-font: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
          'Helvetica Neue', sans-serif;
      }

      /* -- The button in Torn's deposit row ---------------------------------------------- */

      /* Every rule on this wrapper is !important, and that is not belt-and-braces: this stylesheet
         is injected at document-idle and Torn's own loads after it, so on equal specificity
         (.btn-wrap against .bk-btn-wrap, one class each) Torn wins every tie. The paint below was
         already marked; the layout was not, so display: block lost to Torn's inline-block and
         the button stayed a 79px island in the middle of a centred row. */
      .bk-btn-wrap {
        margin-left: 5px !important;
        vertical-align: middle !important;
        /* An inline-block button sits on the baseline of its line box, which then reserves room
           for descenders below it, and the wrapper ends up taller than the button and riding
           high. Zeroing the strut makes it hug. The button restates its own font-size below. */
        font-size: 0 !important;
        line-height: 0 !important;
        height: auto !important;
        /* Only meaningful if .donate turns out to be a flex row, where the default stretch would
           otherwise give the wrapper the height of the tallest control beside it. */
        align-self: center !important;
      }

      /* Geometry comes from Torn's own .torn-btn so this shares a row with DEPOSIT MONEY at the
         same height. The fill is the app's signature gradient, the one on every primary action in
         the UI, which is what marks the button as ours at a glance. Only the paint is !important:
         Torn's stylesheet loads after this one and would otherwise win, while everything under it
         is a fallback for the case where .torn-btn is not styled at all. */
      .bk-withdraw-btn {
        background: var(--bk-accent) !important;
        background-image: linear-gradient(135deg, #00d4ff 0%, #00ff88 100%) !important;
        color: var(--bk-ink) !important;
        text-shadow: none !important;
        border: none;
        border-radius: 3px;
        /* 8px rather than Torn's 10: the cash column is ~366px and the money input and DEPOSIT
           MONEY already claim ~271px of it, so the row fits only if this button stays under ~90px.
           Narrower than that and syncButtonLayout gives it a row of its own. */
        padding: 0 8px;
        min-height: 26px;
        font-family: inherit;
        font-size: 11px;
        font-weight: 700;
        white-space: nowrap;
        cursor: pointer;
        transition: box-shadow 200ms var(--bk-ease), transform 200ms var(--bk-ease);
      }

      .bk-withdraw-btn:active {
        transform: scale(0.98);
      }

      @media (min-width: 1000px) {
        .bk-withdraw-btn:hover {
          box-shadow: 0 4px 15px rgba(0, 212, 255, 0.35);
        }
      }

      /* What the button looks like once it can no longer sit beside DEPOSIT MONEY: its own row,
         pushed to the right. Torn centres the contents of .donate, which is what left it floating
         mid-row. Applied by measurement, not by a breakpoint, because where Torn's row stops
         fitting depends on Torn's own widths. See syncButtonLayout.

         Written to hold whether .donate lays its children out as text or as a flex row, because
         which of the two it is cannot be read from here: block plus width covers the first,
         flex-basis the second, and text-align right-aligns the button inside the full-width strip
         either way. */
      .bk-btn-wrap--stacked {
        display: block !important;
        width: 100% !important;
        flex-basis: 100% !important;
        margin: 8px 0 0 !important;
        text-align: right !important;
        /* syncButtonLayout sets a right padding to line the button up with DEPOSIT MONEY. With a
           content box that padding would widen the strip instead of moving what is inside it. */
        box-sizing: border-box !important;
      }

      /* -- Modal ------------------------------------------------------------------------- */

      .bk-modal-overlay {
        position: fixed;
        inset: 0;
        z-index: 100000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
        overflow-y: auto;
        background-color: rgba(0, 0, 0, 0.7);
        animation: bk-fadein 200ms var(--bk-ease);
      }

      @keyframes bk-fadein {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      @keyframes bk-rise {
        from { opacity: 0; transform: translateY(12px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .bk-modal {
        width: 100%;
        max-width: 500px;
        background: var(--bk-surface);
        backdrop-filter: blur(20px);
        border: 1px solid rgba(0, 212, 255, 0.3);
        border-radius: var(--bk-radius);
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
        color: var(--bk-text);
        font-family: var(--bk-font);
        font-size: 15px;
        line-height: 1.6;
        text-align: left;
        animation: bk-rise 240ms var(--bk-ease);
      }

      /* Torn's own rules reach anything injected into its page, so the box model is pinned
         rather than assumed. */
      .bk-modal,
      .bk-modal *,
      .bk-modal *::before,
      .bk-modal *::after {
        box-sizing: border-box;
      }

      .bk-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        padding: 1.25rem 1.5rem;
        border-bottom: 1px solid var(--bk-line);
      }

      .bk-modal-title {
        margin: 0 !important;
        padding: 0;
        font-size: 1.3rem;
        font-weight: 700;
        line-height: 1.2;
        letter-spacing: normal;
        text-transform: none;
        color: var(--bk-accent);
      }

      /* The app titles every modal in this gradient. Guarded, because a browser without
         background-clip would paint transparent text on transparent and show nothing at all. */
      @supports ((-webkit-background-clip: text) or (background-clip: text)) {
        .bk-modal-title {
          background: linear-gradient(135deg, #00d4ff 0%, #00ff88 100%);
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
        }
      }

      .bk-modal-close {
        flex-shrink: 0;
        width: 2.5rem;
        height: 2.5rem;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        background: none;
        border: none;
        border-radius: var(--bk-radius-sm);
        color: #aaa;
        font-family: var(--bk-font);
        font-size: 2rem;
        line-height: 1;
        cursor: pointer;
        transition: background-color 200ms var(--bk-ease), color 200ms var(--bk-ease);
      }

      .bk-modal-close:hover,
      .bk-modal-close:active {
        background-color: rgba(255, 255, 255, 0.1);
        color: #fff;
      }

      .bk-modal-body {
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
        padding: 1.5rem;
        max-height: 60vh;
        overflow-y: auto;
      }

      /* -- Fields ------------------------------------------------------------------------ */

      .bk-field {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
      }

      .bk-label {
        color: var(--bk-text-dim);
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      .bk-input {
        width: 100%;
        padding: 0.45rem 0.7rem;
        border: 1px solid var(--bk-field-line);
        border-radius: 6px;
        background: var(--bk-field-bg);
        color: var(--bk-text);
        font: inherit;
        transition: border-color 160ms var(--bk-ease), background-color 160ms var(--bk-ease);
      }

      .bk-input:focus,
      .bk-input:focus-visible {
        outline: 2px solid var(--bk-accent);
        outline-offset: 1px;
        border-color: transparent;
        background: rgba(255, 255, 255, 0.07);
      }

      .bk-input option {
        background: #191d2e;
        color: var(--bk-text);
      }

      #bk-amount {
        font-variant-numeric: tabular-nums;
      }

      /* Masked by paint rather than type=password, which would invite the browser's password
         manager to offer to save a Torn API key as a credential. */
      #bk-apikey:not(:focus) {
        color: transparent;
        text-shadow: 0 0 8px rgba(232, 238, 245, 0.55);
      }

      .bk-desc {
        color: var(--bk-text-dim);
        font-size: 0.75rem;
        line-height: 1.45;
      }

      /* The app's .dm-scope: informational, fully bordered rather than side-striped. */
      .bk-note {
        padding: 0.75rem;
        border: 1px solid rgba(0, 212, 255, 0.3);
        border-radius: 8px;
        background: rgba(0, 212, 255, 0.06);
        color: #cfe9f5;
        font-size: 0.85rem;
        line-height: 1.5;
      }

      /* The app's .fmp-inline-error, down to the hue. */
      .bk-error {
        display: none;
        padding: 0.75rem 1rem;
        border: 1px solid rgba(255, 0, 110, 0.3);
        border-radius: var(--bk-radius-sm);
        background: rgba(255, 0, 110, 0.15);
        color: var(--bk-danger);
        font-size: 0.9rem;
        line-height: 1.45;
      }

      .bk-error.bk-visible {
        display: block;
      }

      /* -- Footer ------------------------------------------------------------------------ */

      .bk-modal-footer {
        display: flex;
        justify-content: flex-end;
        gap: 0.75rem;
        padding: 1rem 1.5rem;
        border-top: 1px solid var(--bk-line);
      }

      .bk-btn-primary,
      .bk-btn-secondary {
        padding: 0.5rem 1rem;
        border-radius: var(--bk-radius-sm);
        font-family: var(--bk-font);
        font-size: 0.9rem;
        font-weight: 600;
        cursor: pointer;
        transition: background-color 200ms var(--bk-ease), box-shadow 200ms var(--bk-ease),
          transform 200ms var(--bk-ease), color 200ms var(--bk-ease);
      }

      .bk-btn-primary {
        border: none;
        background: linear-gradient(135deg, #00d4ff 0%, #00ff88 100%);
        color: var(--bk-ink);
        box-shadow: 0 4px 15px rgba(0, 212, 255, 0.3);
      }

      .bk-btn-primary:hover:not(:disabled) {
        transform: translateY(-2px);
        box-shadow: 0 6px 25px rgba(0, 212, 255, 0.5);
      }

      .bk-btn-secondary {
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: rgba(255, 255, 255, 0.1);
        color: #aaa;
      }

      .bk-btn-secondary:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.15);
        color: #fff;
      }

      .bk-btn-primary:disabled,
      .bk-btn-secondary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none;
      }

      /* -- Toasts ------------------------------------------------------------------------ */

      .bk-toast-container {
        position: fixed;
        right: 20px;
        top: 70px;
        z-index: 99999;
        display: flex;
        flex-direction: column;
        gap: 0.625rem;
        pointer-events: none;
      }

      /* The dialog chrome at card scale. The whole border carries the outcome, the way the app's
         confirm dialog turns its border pink, rather than a stripe along one edge. */
      .bk-toast {
        min-width: 240px;
        max-width: 320px;
        padding: 0.75rem 1rem;
        background: var(--bk-surface);
        backdrop-filter: blur(20px);
        border: 1px solid rgba(0, 212, 255, 0.3);
        border-radius: var(--bk-radius);
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
        color: var(--bk-text-soft);
        font-family: var(--bk-font);
        font-size: 0.9rem;
        line-height: 1.5;
        pointer-events: auto;
        animation: bk-slidein 240ms var(--bk-ease);
      }

      .bk-toast--success { border-color: rgba(0, 255, 136, 0.4); }
      .bk-toast--error { border-color: rgba(255, 0, 110, 0.4); }

      /* Money is green and tabular everywhere in the app, so a member reads an amount the same
         way here as on the Banking page. */
      .bk-toast-money {
        color: var(--bk-accent-2);
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }

      .bk-toast.bk-closing {
        animation: bk-slideout 200ms var(--bk-ease) forwards;
      }

      @keyframes bk-slidein {
        from { opacity: 0; transform: translateX(16px); }
        to { opacity: 1; transform: translateX(0); }
      }

      @keyframes bk-slideout {
        from { opacity: 1; transform: translateX(0); }
        to { opacity: 0; transform: translateX(16px); }
      }

      /* -- The app's own global accommodations -------------------------------------------- */

      .bk-modal-body::-webkit-scrollbar {
        width: 6px;
      }

      .bk-modal-body::-webkit-scrollbar-track {
        background: rgba(255, 255, 255, 0.03);
        border-radius: 3px;
      }

      .bk-modal-body::-webkit-scrollbar-thumb {
        background: rgba(0, 212, 255, 0.25);
        border-radius: 3px;
      }

      .bk-modal-body::-webkit-scrollbar-thumb:hover {
        background: rgba(0, 212, 255, 0.55);
      }

      /* 44px targets only where the pointer is coarse, exactly as ui/src/assets/main.css does it,
         rather than inflating every control on a desktop. */
      @media (pointer: coarse) {
        .bk-modal-close,
        .bk-btn-primary,
        .bk-btn-secondary,
        .bk-input {
          min-height: 44px;
        }

        .bk-modal-footer .bk-btn-primary,
        .bk-modal-footer .bk-btn-secondary {
          flex: 1;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .bk-modal-overlay,
        .bk-modal,
        .bk-toast {
          animation-duration: 0.01ms;
        }

        .bk-btn-primary:hover:not(:disabled),
        .bk-withdraw-btn:active {
          transform: none;
        }
      }
    `)

    /**********************
     * TOASTS
     **********************/
    const toastContainer = document.createElement('div')
    toastContainer.className = 'bk-toast-container'
    document.body.appendChild(toastContainer)

    /**
     * A short-lived notice, built as nodes rather than markup so nothing here can inject.
     *
     * `amount` is optional and, when present, is painted the app's money-green: an amount reads
     * the same way here as it does on the Banking page.
     */
    function toast(message, type = 'success', amount = null) {
      const el = document.createElement('div')
      el.className = `bk-toast bk-toast--${type}`
      el.appendChild(document.createTextNode(message))

      if (amount !== null) {
        const money = document.createElement('span')
        money.className = 'bk-toast-money'
        money.textContent = ' ' + formatMoney(amount)
        el.appendChild(money)
        el.appendChild(document.createTextNode('.'))
      }

      toastContainer.appendChild(el)

      setTimeout(() => {
        el.classList.add('bk-closing')
        setTimeout(() => el.remove(), 300)
      }, type === 'error' ? 6000 : 4000)
    }

    /**********************
     * AUTHENTICATION
     **********************/
    let jwt = null
    let currentFactionId = null

    function getStoredToken() {
      try {
        return platform.getValue(TOKEN_STORAGE_KEY, null) || null
      } catch {
        return null
      }
    }

    function storeToken(token) {
      platform.setValue(TOKEN_STORAGE_KEY, token)
    }

    function clearStoredToken() {
      jwt = null
      currentFactionId = null
      platform.removeValue(TOKEN_STORAGE_KEY)
    }

    function isTokenExpired(token) {
      const claims = parseJwtClaims(token)
      if (!claims || !claims.exp) return true
      return Date.now() >= claims.exp * 1000 - TOKEN_EXPIRY_BUFFER_MS
    }

    /**
     * The faction the token belongs to.
     *
     * The withdrawal endpoint is addressed by faction, and the id is read from the token rather than
     * scraped off the page: the claim is what the server checks the route against, so anything else
     * could only ever disagree with it.
     */
    function updateCurrentUserFromJwt(token) {
      const claims = parseJwtClaims(token)
      const factionId = claims ? Number(claims.FactionId) : NaN
      currentFactionId = Number.isInteger(factionId) && factionId > 0 ? factionId : null
    }

    async function login() {
      const apiKey = platform.getApiKey()
      if (!apiKey) {
        throw new Error('API key not configured')
      }

      const res = await platform.fetch(
        'POST',
        `${API_BASE}/Auth/login`,
        { 'Content-Type': 'application/json' },
        JSON.stringify({ apiKey, rememberMe: false })
      )

      const json = JSON.parse(res.responseText)
      return json.token
    }

    async function ensureAuthenticated() {
      if (jwt && !isTokenExpired(jwt)) {
        return jwt
      }

      const stored = getStoredToken()
      if (stored && !isTokenExpired(stored)) {
        jwt = stored
        updateCurrentUserFromJwt(jwt)
        return jwt
      }

      const token = await login()
      if (!token) {
        throw new Error('Sign-in did not return a token.')
      }

      jwt = token
      storeToken(token)
      updateCurrentUserFromJwt(token)
      return jwt
    }

    /**********************
     * BANKING API
     **********************/

    /**
     * Asks the bankers for money.
     *
     * The amount is the raw string the member typed. The API owns what counts as an amount, and a
     * second opinion on this side would be one that could disagree with the one that decides — `all`
     * in particular can only be resolved against the balance the server reads at that instant.
     */
    async function requestWithdraw(amount, expiresInMinutes) {
      let token = await ensureAuthenticated()

      if (!currentFactionId) {
        throw new Error('This API key is not linked to a faction registered with the service.')
      }

      const send = (bearer) => platform.fetch(
        'POST',
        `${API_BASE}/Factions/${currentFactionId}/bank/withdraw`,
        { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bearer}` },
        JSON.stringify({ amount, expiresInMinutes })
      )

      let res
      try {
        res = await send(token)
      } catch (err) {
        // A token lasts a week, so one can expire between opening the page and pressing the button.
        // Retried once rather than reported, because the member did nothing wrong.
        if (!err?.message?.startsWith('HTTP 401')) throw err
        clearStoredToken()
        token = await ensureAuthenticated()
        res = await send(token)
      }

      return JSON.parse(res.responseText)
    }

    /**********************
     * MODAL PLUMBING
     **********************/
    let openOverlay = null

    function closeModal() {
      if (!openOverlay) return
      document.removeEventListener('keydown', onModalKeydown)
      openOverlay.remove()
      openOverlay = null
    }

    function onModalKeydown(event) {
      if (event.key === 'Escape') closeModal()
    }

    function openModal(html) {
      closeModal()

      const overlay = document.createElement('div')
      overlay.className = 'bk-modal-overlay'

      const modal = document.createElement('div')
      modal.className = 'bk-modal'
      modal.innerHTML = html

      overlay.appendChild(modal)
      document.body.appendChild(overlay)
      openOverlay = overlay

      modal.querySelector('.bk-modal-close')?.addEventListener('click', closeModal)
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closeModal()
      })
      document.addEventListener('keydown', onModalKeydown)

      return modal
    }

    /**********************
     * WITHDRAWAL MODAL
     **********************/
    function showWithdrawModal() {
      if (!platform.getApiKey()) {
        if (platform.isPda) {
          toast('No Torn API key is available. Set one in TornPDA and reload the page.', 'error')
        } else {
          showApiKeyModal()
        }
        return
      }

      const options = DURATIONS
        .map(({ label, minutes }) =>
          `<option value="${minutes}"${minutes === DEFAULT_DURATION_MINUTES ? ' selected' : ''}>${escapeHtml(label)}</option>`)
        .join('')

      const modal = openModal(`
        <div class="bk-modal-header">
          <h2 class="bk-modal-title">Vault withdrawal</h2>
          <button class="bk-modal-close" type="button" aria-label="Close">&times;</button>
        </div>

        <div class="bk-modal-body">
          <div class="bk-field">
            <label class="bk-label" for="bk-amount">Amount</label>
            <input class="bk-input" id="bk-amount" type="text" autocomplete="off"
                   maxlength="${AMOUNT_MAX_LENGTH}" placeholder="50m, 1.5b, or all">
            <div class="bk-desc">Type <strong>all</strong> for your whole balance, or an amount like 50m, 1.5b or 50,000,000.</div>
          </div>

          <div class="bk-field">
            <label class="bk-label" for="bk-duration">Bankers have</label>
            <select class="bk-input" id="bk-duration">${options}</select>
          </div>

          <div class="bk-note">
            Your request is posted in the faction's banking channel and a banker pays it on Torn.
            Nothing leaves the vault until they do.
          </div>

          <div class="bk-error" id="bk-error"></div>
        </div>

        <div class="bk-modal-footer">
          <button class="bk-btn-secondary" id="bk-cancel" type="button">Close</button>
          <button class="bk-btn-primary" id="bk-submit" type="button" disabled>Ask the bankers</button>
        </div>
      `)

      const amountInput = modal.querySelector('#bk-amount')
      const durationSelect = modal.querySelector('#bk-duration')
      const errorBox = modal.querySelector('#bk-error')
      const submitBtn = modal.querySelector('#bk-submit')

      modal.querySelector('#bk-cancel').addEventListener('click', closeModal)

      const syncSubmitState = () => {
        submitBtn.disabled = amountInput.value.trim().length === 0
      }
      amountInput.addEventListener('input', syncSubmitState)

      const showError = (message) => {
        errorBox.textContent = message
        errorBox.classList.add('bk-visible')
      }

      let submitting = false

      const submit = async () => {
        const amount = amountInput.value.trim()
        if (submitting || amount.length === 0) return

        submitting = true
        submitBtn.disabled = true
        submitBtn.textContent = 'Asking…'
        errorBox.classList.remove('bk-visible')

        try {
          const created = await requestWithdraw(amount, Number(durationSelect.value))
          closeModal()
          toast('Asked the bankers for', 'success', created.amount)
        } catch (err) {
          // The server's refusals are already written for the member; they are shown as they arrive.
          showError(extractErrorMessage(err))
        } finally {
          // In a finally, not in the catch, because anything the catch itself throws would
          // otherwise leave the button disabled and reading "Asking..." with no way to try again.
          // Harmless after a success: the nodes are detached but still perfectly writable.
          submitting = false
          submitBtn.textContent = 'Ask the bankers'
          syncSubmitState()
        }
      }

      submitBtn.addEventListener('click', submit)
      amountInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          submit()
        }
      })

      amountInput.focus()
    }

    /**********************
     * API KEY MODAL
     **********************/
    function showApiKeyModal() {
      const current = platform.getApiKey()

      const modal = openModal(`
        <div class="bk-modal-header">
          <h2 class="bk-modal-title">Torn API key</h2>
          <button class="bk-modal-close" type="button" aria-label="Close">&times;</button>
        </div>

        <div class="bk-modal-body">
          <div class="bk-field">
            <label class="bk-label" for="bk-apikey">Torn API key</label>
            <input class="bk-input" id="bk-apikey" type="text" autocomplete="off" spellcheck="false"
                   value="${escapeHtml(current)}" placeholder="Your public Torn API key">
            <div class="bk-desc">
              A public access key is enough. It is stored only in Tampermonkey on this device and is
              exchanged with the service for a sign-in token.
            </div>
          </div>

          <div class="bk-error" id="bk-error"></div>
        </div>

        <div class="bk-modal-footer">
          <button class="bk-btn-secondary" id="bk-clear" type="button">Clear</button>
          <button class="bk-btn-primary" id="bk-save" type="button">Save</button>
        </div>
      `)

      const input = modal.querySelector('#bk-apikey')
      const errorBox = modal.querySelector('#bk-error')
      const saveBtn = modal.querySelector('#bk-save')

      modal.querySelector('#bk-clear').addEventListener('click', () => {
        platform.setApiKey('')
        clearStoredToken()
        closeModal()
        toast('API key cleared.', 'success')
      })

      saveBtn.addEventListener('click', async () => {
        const value = input.value.trim()
        if (value.length === 0) {
          errorBox.textContent = 'Enter your Torn API key.'
          errorBox.classList.add('bk-visible')
          return
        }

        saveBtn.disabled = true
        saveBtn.textContent = 'Checking…'
        errorBox.classList.remove('bk-visible')

        platform.setApiKey(value)
        clearStoredToken()

        try {
          // Signed in straight away so a bad key is reported here, rather than at the next withdrawal.
          await ensureAuthenticated()
          closeModal()
          toast('API key saved.', 'success')
        } catch (err) {
          errorBox.textContent = extractErrorMessage(err)
          errorBox.classList.add('bk-visible')
        } finally {
          saveBtn.disabled = false
          saveBtn.textContent = 'Save'
        }
      })

      input.focus()
      input.select()
    }

    // TornPDA has no menu, and its key is substituted into the placeholder at install time.
    if (!platform.isPda && typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Set Torn API key', showApiKeyModal)
    }

    /**********************
     * BUTTON INJECTION
     **********************/
    function injectButtons() {
      for (const host of document.querySelectorAll(DONATE_SELECTOR)) {
        // Inside `.donate`, after DEPOSIT MONEY, so the button joins the deposit row instead of
        // adding one below it. The marker is looked for in the same place it is written, so a
        // re-render that replaces only the row's contents gets the button back.
        if (host.querySelector(`[${BUTTON_MARKER}]`)) continue

        const wrap = document.createElement('span')
        wrap.className = 'btn-wrap silver bk-btn-wrap'
        wrap.setAttribute(BUTTON_MARKER, '')
        // "WITHDRAW", matching the casing Torn writes DEPOSIT MONEY in. No emoji: it measures ~18px
        // and that is the whole difference between sharing the deposit row and wrapping below it.
        wrap.innerHTML =
          '<span class="btn"><button type="button" class="torn-btn bk-withdraw-btn">WITHDRAW</button></span>'

        // `type="button"`: this sits inside Torn's donate form, where a bare button submits it.
        wrap.querySelector('button').addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          showWithdrawModal()
        })

        host.appendChild(wrap)
      }

      syncButtonLayout()
    }

    /**
     * Decides between sitting on Torn's deposit row and owning a row below it.
     *
     * The row fits three controls on a wide screen and two on a narrow one, and the width where
     * that changes belongs to Torn's markup rather than to any breakpoint this script could name -
     * measuring at 790px put the button one pixel inside the row, which a scrollbar was enough to
     * push out. So the question is asked of the layout instead of guessed: level with DEPOSIT
     * MONEY it stays inline, pushed onto a line of its own it takes the whole width.
     *
     * The class is removed before measuring, or a stacked button would always measure as stacked.
     * Torn's own row is never touched: only this button changes between the two states.
     *
     * Stacked, it is then nudged so its right edge meets DEPOSIT MONEY's rather than the row's.
     */
    function syncButtonLayout() {
      for (const wrap of document.querySelectorAll('.bk-btn-wrap')) {
        const neighbour = wrap.parentElement?.querySelector('.btn-wrap:not(.bk-btn-wrap)')
        const button = wrap.querySelector('button')
        if (!neighbour || !button) continue

        // Both corrections are cleared before measuring, or each pass would compound the last.
        wrap.classList.remove('bk-btn-wrap--stacked')
        wrap.style.paddingRight = ''

        // Asked horizontally, which is the only unambiguous form of the question. This button is
        // appended after DEPOSIT MONEY, so while they share a line its left edge is necessarily
        // past that button's right edge; the moment it wraps, it restarts at the beginning of the
        // next line and its left edge falls behind. Vertical comparisons cannot decide this -
        // inline-block boxes of different heights sit at different tops on one line, and their
        // boxes can still overlap across two.
        const stacked = wrap.getBoundingClientRect().left < neighbour.getBoundingClientRect().right - 2
        wrap.classList.toggle('bk-btn-wrap--stacked', stacked)
        if (!stacked) continue

        // Right-aligning the strip lands the button on the row's edge, which is not the edge
        // anybody is looking at: DEPOSIT MONEY sits inside it, because Torn's wrapper carries
        // horizontal spacing this one does not, and at the widths where Torn's centred first line
        // does not fill the row it sits well inside it.
        //
        // The correction goes on the strip, not on the button. Nudging the button's own margin
        // moves the box the measurement was taken from, so each pass lands somewhere new and the
        // reading never settles - it drifted further with every step down in width. The strip's
        // right edge, by contrast, is fixed by the row: padding it moves the button and leaves the
        // reference where it was, so one pass is exact.
        // Both edges are read off the painted buttons, not off the wrappers around them. Torn's
        // wrapper extends past its own button, so lining up with the wrapper leaves the two
        // rectangles a couple of pixels apart - which is exactly what somebody sees.
        const neighbourButton = neighbour.querySelector('button') || neighbour

        wrap.style.paddingRight = '0px'
        const stripRight = wrap.getBoundingClientRect().right
        const padding =
          (stripRight - neighbourButton.getBoundingClientRect().right) -
          (stripRight - button.getBoundingClientRect().right)
        if (padding > 0.5) {
          wrap.style.paddingRight = padding + 'px'
        }
      }
    }

    // Torn re-renders the faction tabs on every sub-navigation, so unlike the war-room script's
    // one-shot observer this one stays attached for the life of the page. The marker attribute is
    // what stops our own insertion from starting a loop: the pass it triggers finds nothing to do.
    let scheduled = false
    const observer = new MutationObserver(() => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        injectButtons()
      })
    })
    observer.observe(document.body, { childList: true, subtree: true })

    window.addEventListener('hashchange', () => {
      setTimeout(injectButtons, 500)
    })

    // Rotating a phone or dragging a window across the width where the row stops fitting.
    let layoutScheduled = false
    window.addEventListener('resize', () => {
      if (layoutScheduled) return
      layoutScheduled = true
      requestAnimationFrame(() => {
        layoutScheduled = false
        syncButtonLayout()
      })
    })

    injectButtons()
  }

  await initBankHelper(platform)
})()
