# TuRzAm WarRoom Connector - TornPDA Mobile Version

## Overview

This is a **proof-of-concept** mobile userscript for [TornPDA](https://github.com/Manuito83/torn-pda) that brings real-time coordinated attack notifications to your mobile device.

## Features

### Core Functionality
✅ **TornPDA Environment Detection** - Automatically detects and runs only in TornPDA
✅ **JWT Authentication** - Secure authentication with token caching via localStorage
✅ **SignalR Long-Polling** - Real-time connection to WarRoom API
✅ **Mobile-Optimized Toast Notifications** - Attack alerts with countdown timers
✅ **Attack Details** - Shows target, timer, participants, and creator
✅ **Urgency Indicators** - Red pulsing timer for attacks with <1 minute remaining

### Interactive Features
✅ **Join/Attack/Done Buttons** - Take action directly from attack notifications
✅ **Create Coordinated Attacks** - Request attacks on targets from loader.php pages
✅ **Feed Toggle Button** - Enable/disable attack notifications on the fly
✅ **Settings Panel** - Configure toast position, auto-hide, and feed status
✅ **Target Detection** - Auto-detects war room targets on attack pages

## Installation

### Prerequisites

1. **TornPDA App** installed on your mobile device
2. **WarRoom API Key** from [https://torn.zzcraft.net](https://torn.zzcraft.net)

### Steps

1. **Add Script to TornPDA**:
   - Open TornPDA app
   - Go to **Settings** → **Userscripts**
   - Add new userscript
   - Copy the contents of `warroom-pda.user.js`
   - Paste into TornPDA userscript editor

2. **Configure API Key**:
   - In TornPDA, go to **Settings** → **API Key**
   - Enter your WarRoom API key
   - The script will automatically use this key (via the `###PDA-APIKEY###` pattern)

3. **Enable Script**:
   - Ensure the script is enabled in TornPDA userscripts settings
   - Navigate to any Torn.com page
   - The script will initialize automatically

## How It Works

### Initialization Flow

1. **Environment Check**: Detects if running in TornPDA
2. **Authentication**:
   - Checks for cached JWT token in localStorage
   - If expired/missing, authenticates with WarRoom API using API key
   - Stores token for future sessions
3. **SignalR Connection**:
   - Negotiates connection with WarRoom hub
   - Establishes long-polling for real-time updates
   - Sets display name to "Torn"
4. **War Room Subscription**:
   - Fetches available war rooms
   - Subscribes to attack events for each war room
   - Loads existing active attacks

### Attack Notifications

When a coordinated attack is created or updated, a toast notification appears with:

- **Target Information**: Name and ID
- **Status Badge**: "Active" (green) or "Full" (orange)
- **Live Countdown Timer**: Updates every second
  - Normal: White timer
  - Urgent (<1 min): Red pulsing timer
- **Participant Count**: Shows filled/total slots
- **Participant List**: Names of joined attackers
- **Action Buttons**:
  - **Join** - Join the attack (if not full and you haven't joined)
  - **Attack** - Opens attack link (if you've joined)
  - **Done** - Mark attack as complete (if you're a participant or creator)
- **Creator Info**: Shows who created the attack
- **Auto-Expiration**: Toast auto-removes when timer expires

### Attack Request Button

When viewing a war room target on loader.php pages:

1. **Green "+" Button** appears (positioned at `left: 190px, top: 2px`)
2. **Click to Open Dialog** with options:
   - Target (auto-filled)
   - Number of People Needed (1-30)
   - Expiration (1-15 minutes)
   - Wait Until Full toggle
3. **Create Attack** - Broadcasts to all war room members

### Feed Toggle Button

**Bell Icon** (positioned at `left: 110px, top: 0px`):
- **Purple Bell** - Feed is ON, receiving attack notifications
- **Red Bell with Cross** - Feed is OFF, not receiving notifications
- **Click to Toggle** - Instantly connect/disconnect from WarRoom
- **Persistent** - Setting saved across sessions

### Settings Panel

**Gear Icon** (positioned at `left: 150px, top: 2px`):
- **Toast Position** - Bottom-left, bottom-right, top-left, top-right
- **Attack Feed** - Enable/disable real-time notifications
- **Auto-hide Full Attacks** - Automatically remove toasts when attacks fill up
- **Clear Cache** - Clear target cache
- **Clear Token** - Force re-authentication

## API Key Pattern

The script uses TornPDA's automatic API key injection:

```javascript
const API_KEY = "###PDA-APIKEY###";
```

**Important**:
- Do NOT modify this line
- TornPDA automatically replaces `###PDA-APIKEY###` with your configured API key at runtime
- If you see "API key not configured" error, check your TornPDA settings

## Console Logging

The script logs detailed debug information to the browser console:

```
[WarRoom:Main] WarRoom TornPDA POC starting
[WarRoom:Main] TornPDA detected
[WarRoom:Auth] Logging in with API key
[WarRoom:Auth] Login successful
[WarRoom:Auth] Username extracted "YourUsername"
[WarRoom:SignalR] Starting connection
[WarRoom:SignalR] Negotiated {connectionId: "..."}
[WarRoom:SignalR] Handshake complete
[WarRoom:Main] SignalR connected
[WarRoom:Main] DisplayName set
[WarRoom:Main] WarRooms received [...]
[WarRoom:Event] AttackUpdate received {attack: {...}}
[WarRoom:Toast] Attack displayed {id: "...", eventType: "Added"}
```

**To View Logs**:
1. Open TornPDA app
2. Navigate to webview page
3. Enable developer console (if available)
4. Or use remote debugging via Chrome DevTools

## Troubleshooting

### Script Not Starting

**Symptom**: No console output
**Solution**:
- Verify script is enabled in TornPDA settings
- Check userscript match pattern includes `https://www.torn.com/*`
- Reload Torn.com page
Current Limitations

⚠️ **Attack Button Positioning** - Uses `position: absolute` which may need adjustment based on device
⚠️ **No Sound Notifications** - Silent notifications only
⚠️ **Limited Reconnection** - Attempts up to 5 reconnects with exponential backoff
⚠️ **Cache Duration** - Target cache expires after 1 hour

## Roadmap (Future Enhancements)

### Planned Features
- Sound/vibration for attack notifications
- Attack history log
- Customizable button positions
- Better reconnection handling
- Attack link generation fallback optionsnect

## Limitations (POC Scope)

This is a **proof-of-concept**. Current limitations:

❌ **No Interactive Buttons** - Cannot join/attack/mark done from toast
❌ **No Live Timers** - Timer shows static snapshot, doesn't count down
❌ **No Attack Creation** - Cannot create attacks from mobile
❌ **No Settings UI** - All configuration hardcoded
❌ **Basic Reconnection** - Simple retry on failure, no exponential backoff

## Roadmap (Future Enhancements)

### Phase 2: Interactive UI
- Custom overlay with Join/Attack/Done buttons
- API integration for user actions
- Real-time timer updates with countdown

### Phase 3: Attack Creation
- Detect attack pages (loader.php)
- Show "Create Attack" button
- Dialog for configuring participants/expiration

### Phase 4: Settings & Polish
- Settings UI for notifications
- Toggle sound/vibration
- Attack history log
- Advanced reconnection logic

## Technical Details

### Architecture

- **Platform**: TornPDA userscript
- **Authentication**: JWT tokens (5-min expiry buffer)
- **Communication**: SignalR long-polling over HTTP
- **Storage**: localStorage for token persistence
- **UI**: Native TornPDA toast notifications

### Code Reuse

- **85%** of desktop logic preserved (JWT, SignalR, event handling)
- **15%** new PDA-specific code (HTTP wrapper, toast formatting)
- **~800 lines** (38% of desktop version's 2174 lines)

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|/settings persistence
- **UI**: Custom mobile-optimized toast cards with CSS animations
- **Target Detection**: Cached war room targets (1-hour TTL)

### Code Structure

- **~2070 lines** of mobile-optimized code
- **Core Features**: JWT auth, SignalR client, attack notifications
- **Interactive UI**: Join/Attack/Done buttons, settings panel
- **Target Management**: Cache-based target detection for attack creation
| Method | Type | Purpose |
|--------|------|---------|
| `SetDisplayName` | Send | Identify client as "Torn" |
| `GetWarRooms` | Invoke | Fetch available war rooms |
| `GetAttacks` | Invoke | Fetch attacks for war room |
| `AttackUpdate` | Receive | Real-time attack events |
| `WarRoomAttacks` | Receive | Bulk attack data |
| `/warrooms/targets` | GET | Fetch all war room targets |
| `/WarRooms/{id}/attack` | POST | Create coordinated attack |
| `/WarRooms/participate/{id}` | POST | Join an attack |
| `/WarRooms/end/{id}` | POST | Mark attack as done |

### Hub Methods

| Method | Type | Purpose |
|--------|------|---------|
| `SetDisplayName` | Send | Identify client as "TornPDA
- [ ] Console shows "TornPDA detected"
- [ ] Console shows "Authenticated successfully"
- [ ] Console shows "SignalR connected"
- [ ] Console shows "WarRooms received" with array
### Initial Setup
- [ ] Three buttons appear: Feed toggle (bell), Settings (gear), Attack request (+ on targets)
- [ ] Console shows "TornPDA detected"
- [ ] Console shows "Authenticated successfully"
- [ ] Console shows "SignalR connected"
- [ ] Console shows "WarRooms received" with array
- [ ] Success toast appears: "WarRoom Connected - Listening for attacks"

### Attack Notifications
- [ ] Create test attack from desktop → mobile receives toast
- [ ] Toast shows correct target, timer, participants, creator
- [ ] Timer counts down every second
- [ ] Urgent attacks (<1 min) show red pulsing timer
- [ ] Can dismiss toast by clicking X
- [ ] Join button appears if not joined and not full
- [ ] Attack button appears if joined
- [ ] Done button appears if participant or creator

### Feed Toggle
- [ ] Bell icon is purple when feed is ON
- [ ] Bell icon is red with cross when feed is OFF
- [ ] Clicking toggles feed state
- [ ] Disconnects/connects appropriately
- [ ] Setting persists after page reload

### Attack CFeature-Complete POC
- [ ] Navigate to war room target on loader.php
- [ ] Green "+" button appears
- [ ] Click opens dialog with target pre-filled
- [ ] Can set participants (1-30) and expiration (1-15 min)
- [ ] "Wait Until Full" toggle works
- [ ] Creating attack shows success toast
- [ ] Attack appears on desktop WarRoom

### Settings Panel
- [ ] Gear icon opens settings modal
- [ ] Toast position dropdown works
- [ ] Attack Feed toggle works
- [ ] Auto-hide Full Attacks toggle works
- [ ] Clear Cache button works
- [ ] Clear Token forces re-authentication
- [ ] Settings persist after reload

### Persistence
- [ ] Token persists after page reload (no re-auth)
- [ ] Settings persist after page reload
- [ ] Feed state persists after page reload
- [ ] Target cache persists for 1 hourTuRz4m/warroom-userscript/issues)

### Questions

- **WarRoom API**: [https://torn.zzcraft.net](https://torn.zzcraft.net)
- **TornPDA**: [https://github.com/Manuito83/torn-pda](https://github.com/Manuito83/torn-pda)

## License

Same as desktop version - see main repository for details.

## Credits

- **Desktop Version**: Original WarRoom userscript
- **TornPDA**: [Manuito83](https://github.com/Manuito83/torn-pda)
- **Mobile Adaptation**: Proof-of-concept for TornPDA integration

---

**Version**: 0.1.0-pda-poc
**Status**: Proof of Concept
**Last Updated**: 2026-01-16
